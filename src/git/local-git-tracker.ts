import { resolve } from "node:path";

import type { GitCommandResult, GitCommandRunner } from "./command-runner.js";
import { MalformedStatusError, parseStatusV2 } from "./status-v2.js";
import type {
  AbsolutePath,
  AmbiguityReason,
  CommitOid,
  CommitRangeResult,
  GitDiscoveryResult,
  GitObservation,
  HeadState,
  LocalGitTracker,
  RemoteObservation,
  UpstreamState,
  WorktreeIdentity,
} from "./types.js";

const QUICK_TIMEOUT = 5_000;
const GRAPH_TIMEOUT = 15_000;
const STATUS_ARGS = [
  "--no-optional-locks",
  "status",
  "--porcelain=v2",
  "--branch",
  "--no-ahead-behind",
  "--untracked-files=all",
  "--ignore-submodules=none",
  "--find-renames=50%",
  "-z",
] as const;
const REPOSITORY_KIND_ARGS = [
  "rev-parse",
  "--is-inside-work-tree",
  "--is-bare-repository",
] as const;

export interface LocalGitTrackerOptions {
  quickTimeoutMilliseconds?: number;
  graphTimeoutMilliseconds?: number;
  now?: () => Date;
}

export function createLocalGitTracker(
  runner: GitCommandRunner,
  options: LocalGitTrackerOptions = {},
): LocalGitTracker {
  const quickTimeout = options.quickTimeoutMilliseconds ?? QUICK_TIMEOUT;
  const graphTimeout = options.graphTimeoutMilliseconds ?? GRAPH_TIMEOUT;
  const now = options.now ?? (() => new Date());

  async function run(
    args: readonly string[],
    cwd: string,
    signal: AbortSignal | undefined,
    timeout = quickTimeout,
  ): Promise<GitCommandResult> {
    return runner.run(args, { cwd, signal, timeout });
  }

  async function observe(
    cwdInput: string,
    observeOptions: { signal?: AbortSignal } = {},
  ): Promise<GitDiscoveryResult> {
    const cwd = resolve(cwdInput);
    let lastObservation: GitObservation | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const discovery = await discover(cwd, observeOptions.signal);
      if (discovery.kind !== "identity") return discovery.result;

      const statusResult = await run(STATUS_ARGS, cwd, observeOptions.signal, graphTimeout);
      if (statusResult.error !== undefined || statusResult.code !== 0) {
        return failed(statusResult, STATUS_ARGS);
      }

      let parsed: ReturnType<typeof parseStatusV2>;
      try {
        parsed = parseStatusV2(statusResult.stdout, discovery.identity.repository.objectFormat);
      } catch (error) {
        return {
          kind: "failed",
          issues: [malformed(STATUS_ARGS, error)],
        };
      }

      const issues: AmbiguityReason[] = [];
      const remotes = await readRemotes(cwd, observeOptions.signal, issues);
      const upstream = await readUpstream(cwd, parsed.head, observeOptions.signal, issues);
      const observation: GitObservation = {
        identity: discovery.identity,
        head: parsed.head,
        remotes,
        origin: remotes.find((remote) => remote.name === "origin"),
        upstream,
        workingTree: parsed.workingTree,
        observedAt: "",
        issues,
      };
      lastObservation = observation;

      const endingDiscovery = await discover(cwd, observeOptions.signal);
      const endingHead = await readHead(cwd, observeOptions.signal);
      if (
        endingDiscovery.kind === "identity" &&
        endingHead !== undefined &&
        sameIdentity(discovery.identity, endingDiscovery.identity) &&
        sameHead(parsed.head, endingHead)
      ) {
        return {
          kind: "observed",
          observation: { ...observation, observedAt: now().toISOString() },
        };
      }
    }

    if (lastObservation !== undefined) {
      return {
        kind: "observed",
        observation: {
          ...lastObservation,
          issues: [...lastObservation.issues, { code: "state_changed_during_observation" }],
          observedAt: now().toISOString(),
        },
      };
    }
    return { kind: "failed", issues: [{ code: "git_unavailable" }] };
  }

  async function discover(
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: "identity"; identity: WorktreeIdentity }
    | { kind: "result"; result: GitDiscoveryResult }
  > {
    const repositoryKind = await run(REPOSITORY_KIND_ARGS, cwd, signal);
    if (repositoryKind.error !== undefined) {
      return { kind: "result", result: failed(repositoryKind, REPOSITORY_KIND_ARGS) };
    }
    if (repositoryKind.code !== 0) {
      if (repositoryKind.code === 128 && isOutsideRepositoryDiagnostic(repositoryKind.stderr)) {
        return {
          kind: "result",
          result: { kind: "outside_repository", cwd: cwd as AbsolutePath },
        };
      }
      return { kind: "result", result: failed(repositoryKind, REPOSITORY_KIND_ARGS) };
    }

    const repositoryKindFields = splitLines(repositoryKind.stdout);
    if (repositoryKindFields.length !== 2) {
      return {
        kind: "result",
        result: {
          kind: "failed",
          issues: [
            {
              code: "malformed_git_output",
              command: commandName(REPOSITORY_KIND_ARGS),
              detail: "expected worktree and bare fields",
            },
          ],
        },
      };
    }
    const [insideWorktree, bareRepository] = repositoryKindFields;
    if (bareRepository === "true") {
      return { kind: "result", result: { kind: "unsupported_repository", reason: "bare" } };
    }
    if (insideWorktree !== "true") {
      return { kind: "result", result: { kind: "unsupported_repository", reason: "no_worktree" } };
    }

    const identityCommands = [
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      ["rev-parse", "--path-format=absolute", "--absolute-git-dir"],
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["rev-parse", "--show-object-format=storage"],
    ] as const;
    const identityFields: string[] = [];
    for (const args of identityCommands) {
      const result = await run(args, cwd, signal);
      if (result.error !== undefined || result.code !== 0) {
        return { kind: "result", result: failed(result, args) };
      }
      const field = stripFinalLineFeed(result.stdout);
      if (field === "") {
        return {
          kind: "result",
          result: {
            kind: "failed",
            issues: [
              {
                code: "malformed_git_output",
                command: commandName(args),
                detail: "empty identity field",
              },
            ],
          },
        };
      }
      identityFields.push(field);
    }

    const [rootDirectory, gitDirectory, commonDirectory, objectFormat] = identityFields;
    if (!rootDirectory || !gitDirectory || !commonDirectory || !objectFormat) {
      return {
        kind: "result",
        result: {
          kind: "failed",
          issues: [
            {
              code: "malformed_git_output",
              command: "git rev-parse",
              detail: "missing identity field",
            },
          ],
        },
      };
    }
    return {
      kind: "identity",
      identity: {
        rootDirectory: rootDirectory as AbsolutePath,
        gitDirectory: gitDirectory as AbsolutePath,
        repository: { commonDirectory: commonDirectory as AbsolutePath, objectFormat },
      },
    };
  }

  async function readHead(
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<HeadState | undefined> {
    const symbolic = await run(["symbolic-ref", "-q", "HEAD"], cwd, signal);
    const oid = await run(["rev-parse", "--verify", "-q", "HEAD^{commit}"], cwd, signal);
    if (symbolic.code === 0) {
      const branchRef = stripFinalLineFeed(symbolic.stdout);
      const prefix = "refs/heads/";
      if (!branchRef.startsWith(prefix)) return undefined;
      const branchName = branchRef.slice(prefix.length);
      if (oid.code === 0) {
        return {
          kind: "attached",
          branchRef,
          branchName,
          oid: stripFinalLineFeed(oid.stdout) as CommitOid,
        };
      }
      if (oid.code === 1) return { kind: "unborn", branchRef, branchName };
      return undefined;
    }
    if (symbolic.code === 1 && oid.code === 0) {
      return { kind: "detached", oid: stripFinalLineFeed(oid.stdout) as CommitOid };
    }
    return undefined;
  }

  async function readRemotes(
    cwd: string,
    signal: AbortSignal | undefined,
    issues: AmbiguityReason[],
  ): Promise<RemoteObservation[]> {
    const namesResult = await run(["remote"], cwd, signal);
    if (namesResult.error !== undefined || namesResult.code !== 0) {
      issues.push(commandIssue(namesResult, ["remote"]));
      return [];
    }
    const names = splitLines(namesResult.stdout);
    const remotes: RemoteObservation[] = [];
    for (const name of names) {
      const fetch = await run(["remote", "get-url", "--all", name], cwd, signal);
      const push = await run(["remote", "get-url", "--push", "--all", name], cwd, signal);
      const rawPush = await run(["config", "--get-all", `remote.${name}.pushurl`], cwd, signal);
      if (
        fetch.error !== undefined ||
        fetch.code !== 0 ||
        push.error !== undefined ||
        push.code !== 0 ||
        rawPush.error !== undefined ||
        (rawPush.code !== 0 && rawPush.code !== 1)
      ) {
        const failure =
          fetch.error !== undefined || fetch.code !== 0
            ? fetch
            : push.error !== undefined || push.code !== 0
              ? push
              : rawPush;
        issues.push(commandIssue(failure, ["remote", "get-url", name]));
        continue;
      }
      remotes.push({
        name,
        fetchUrls: splitLines(fetch.stdout),
        pushUrls: splitLines(push.stdout),
        pushUsesFetchUrls: rawPush.code === 1,
      });
    }
    return remotes;
  }

  async function readUpstream(
    cwd: string,
    head: HeadState,
    signal: AbortSignal | undefined,
    issues: AmbiguityReason[],
  ): Promise<UpstreamState> {
    if (head.kind !== "attached") return { kind: "none" };
    const mergeResult = await run(
      ["config", "--get-all", `branch.${head.branchName}.merge`],
      cwd,
      signal,
    );
    if (mergeResult.error !== undefined || (mergeResult.code !== 0 && mergeResult.code !== 1)) {
      issues.push(commandIssue(mergeResult, ["config", "--get-all"]));
      return { kind: "none" };
    }
    const mergeRefs = splitLines(mergeResult.stdout);
    if (mergeRefs.length > 1) {
      issues.push({ code: "multiple_upstream_merge_refs", refs: mergeRefs });
      return { kind: "ambiguous", candidates: mergeRefs.map((mergeRef) => ({ mergeRef })) };
    }

    const format =
      "%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track)%00";
    const refResult = await run(
      ["for-each-ref", `--format=${format}`, head.branchRef],
      cwd,
      signal,
    );
    if (refResult.error !== undefined || refResult.code !== 0) {
      issues.push(commandIssue(refResult, ["for-each-ref"]));
      return { kind: "none" };
    }
    const fields = refResult.stdout.split("\0");
    const trackingRef = fields[2] ?? "";
    const remoteName = fields[3] ?? "";
    const remoteRef = fields[4] ?? "";
    const track = fields[5] ?? "";
    if (!trackingRef) return { kind: "none" };
    if (track.includes("[gone]")) {
      return { kind: "gone", trackingRef, remoteName, remoteRef };
    }

    const configured = { kind: "configured" as const, trackingRef, remoteName, remoteRef };
    const oidResult = await run(
      ["rev-parse", "--verify", "--end-of-options", `${trackingRef}^{commit}`],
      cwd,
      signal,
    );
    if (oidResult.error !== undefined || oidResult.code !== 0) {
      issues.push(commandIssue(oidResult, ["rev-parse", "--verify"]));
      return configured;
    }
    const oid = stripFinalLineFeed(oidResult.stdout) as CommitOid;
    const countsResult = await run(
      ["rev-list", "--left-right", "--count", `HEAD...${trackingRef}`],
      cwd,
      signal,
      graphTimeout,
    );
    if (countsResult.error !== undefined || countsResult.code !== 0) {
      issues.push(commandIssue(countsResult, ["rev-list", "--left-right", "--count"]));
      return { ...configured, oid };
    }
    const counts = stripFinalLineFeed(countsResult.stdout).split(/\s+/).map(Number);
    if (counts.length !== 2 || counts.some((count) => !Number.isSafeInteger(count))) {
      issues.push({
        code: "malformed_git_output",
        command: "git rev-list",
        detail: "invalid upstream counts",
      });
      return { ...configured, oid };
    }
    return {
      ...configured,
      oid,
      ahead: counts[0] ?? 0,
      behind: counts[1] ?? 0,
    };
  }

  async function compare(
    beforeObservation: GitObservation,
    afterObservation: GitObservation,
    compareOptions: {
      signal?: AbortSignal;
      requireBranchScopedAttribution?: boolean;
    } = {},
  ): Promise<CommitRangeResult> {
    const before = headOid(beforeObservation.head);
    const after = headOid(afterObservation.head);
    const issues: AmbiguityReason[] = [];
    const commonBefore = beforeObservation.identity.repository.commonDirectory;
    const commonAfter = afterObservation.identity.repository.commonDirectory;
    if (commonBefore !== commonAfter)
      issues.push({ code: "repository_changed_between_observations" });
    if (beforeObservation.identity.gitDirectory !== afterObservation.identity.gitDirectory) {
      issues.push({ code: "worktree_changed_between_observations" });
    }
    if (before === undefined)
      issues.push({ code: "head_missing_at_range_boundary", boundary: "before" });
    if (after === undefined)
      issues.push({ code: "head_missing_at_range_boundary", boundary: "after" });
    const beforeBranch = attachedBranch(beforeObservation.head);
    const afterBranch = attachedBranch(afterObservation.head);
    if (beforeBranch !== undefined && afterBranch !== undefined && beforeBranch !== afterBranch) {
      issues.push({ code: "branch_changed_between_observations" });
    }
    if (
      compareOptions.requireBranchScopedAttribution &&
      (beforeObservation.head.kind === "detached" || afterObservation.head.kind === "detached")
    ) {
      issues.push({ code: "detached_head_during_interaction" });
    }
    if (
      [...beforeObservation.issues, ...afterObservation.issues].some(
        (issue) => issue.code === "state_changed_during_observation",
      )
    ) {
      issues.push({ code: "state_changed_during_observation" });
    }

    if (
      commonBefore !== commonAfter ||
      beforeObservation.identity.gitDirectory !== afterObservation.identity.gitDirectory
    ) {
      return rangeResult("unavailable", before, after, [], [], issues);
    }
    if (before === undefined && after === undefined) {
      return rangeResult("unchanged", before, after, [], [], issues);
    }
    if (after === undefined) return rangeResult("unavailable", before, after, [], [], issues);

    const cwd = afterObservation.identity.rootDirectory;
    if (before === undefined) {
      const list = await run(
        ["rev-list", "--topo-order", "--reverse", after],
        cwd,
        compareOptions.signal,
        graphTimeout,
      );
      if (list.error !== undefined) {
        issues.push(commandIssue(list, ["rev-list", "--topo-order", "--reverse"]));
        return rangeResult("unavailable", before, after, [], [], issues);
      }
      if (list.code !== 0) {
        issues.push({ code: "range_endpoint_unavailable", oid: after });
        return rangeResult("unavailable", before, after, [], [], issues);
      }
      return rangeResult(
        "unavailable",
        before,
        after,
        [],
        splitLines(list.stdout) as CommitOid[],
        issues,
      );
    }

    const endpointIssueStart = issues.length;
    for (const endpoint of [before, after]) {
      const verified = await run(
        ["rev-parse", "--verify", "--end-of-options", `${endpoint}^{commit}`],
        cwd,
        compareOptions.signal,
      );
      if (verified.error !== undefined) {
        issues.push(commandIssue(verified, ["rev-parse", "--verify"]));
      } else if (verified.code !== 0) {
        issues.push({ code: "range_endpoint_unavailable", oid: endpoint });
      }
    }
    if (issues.length > endpointIssueStart) {
      return rangeResult("unavailable", before, after, [], [], issues);
    }
    if (before === after) return rangeResult("unchanged", before, after, [], [], issues);

    const list = await run(
      ["rev-list", "--left-right", "--topo-order", "--reverse", `${before}...${after}`],
      cwd,
      compareOptions.signal,
      graphTimeout,
    );
    if (list.error !== undefined || list.code !== 0) {
      issues.push(commandIssue(list, ["rev-list", "--left-right"]));
      return rangeResult("unavailable", before, after, [], [], issues);
    }
    const beforeOnly: CommitOid[] = [];
    const afterOnly: CommitOid[] = [];
    for (const line of splitLines(list.stdout)) {
      if (line.startsWith("<")) beforeOnly.push(line.slice(1) as CommitOid);
      else if (line.startsWith(">")) afterOnly.push(line.slice(1) as CommitOid);
      else {
        issues.push({
          code: "malformed_git_output",
          command: "git rev-list",
          detail: "missing left/right marker",
        });
        return rangeResult("unavailable", before, after, [], [], issues);
      }
    }

    let relation: CommitRangeResult["relation"];
    if (beforeOnly.length === 0) relation = "fast_forward";
    else if (afterOnly.length === 0) relation = "rewound";
    else {
      const mergeBase = await run(
        ["merge-base", "--all", before, after],
        cwd,
        compareOptions.signal,
        graphTimeout,
      );
      if (mergeBase.error !== undefined) {
        issues.push(commandIssue(mergeBase, ["merge-base", "--all"]));
        return rangeResult("unavailable", before, after, beforeOnly, afterOnly, issues);
      } else if (mergeBase.code === 0) relation = "diverged";
      else if (mergeBase.code === 1) relation = "unrelated";
      else {
        issues.push(commandIssue(mergeBase, ["merge-base", "--all"]));
        return rangeResult("unavailable", before, after, beforeOnly, afterOnly, issues);
      }
    }
    if (beforeOnly.length > 0) issues.push({ code: "head_moved_non_fast_forward" });
    if (beforeObservation.workingTree.dirty && afterOnly.length > 0) {
      issues.push({ code: "preexisting_dirty_changes_may_have_been_committed" });
    }
    return rangeResult(relation, before, after, beforeOnly, afterOnly, deduplicateIssues(issues));
  }

  return { observe, compare };
}

function rangeResult(
  relation: CommitRangeResult["relation"],
  before: CommitOid | undefined,
  after: CommitOid | undefined,
  beforeOnly: readonly CommitOid[],
  afterOnly: readonly CommitOid[],
  issues: readonly AmbiguityReason[],
): CommitRangeResult {
  const ambiguous = issues.length > 0;
  return {
    relation,
    before,
    after,
    beforeOnly,
    afterOnly,
    associations: afterOnly.map((oid) => ({
      oid,
      relationship: ambiguous ? "ambiguous" : "observed",
      reasons: ambiguous ? issues : [],
    })),
    issues,
  };
}

function failed(result: GitCommandResult, args: readonly string[]): GitDiscoveryResult {
  return { kind: "failed", issues: [commandIssue(result, args)] };
}

function commandIssue(result: GitCommandResult, args: readonly string[]): AmbiguityReason {
  if (result.error === "unavailable")
    return { code: "git_unavailable", detail: limited(result.stderr) };
  if (result.error === "unsupported_path_encoding") {
    return { code: "unsupported_path_encoding", command: commandName(args) };
  }
  if (result.error === "aborted") {
    return { code: "git_command_aborted", command: commandName(args) };
  }
  if (result.error === "timed_out" || result.killed) {
    return { code: "git_command_timed_out", command: commandName(args) };
  }
  return { code: "git_command_failed", command: commandName(args), exitCode: result.code };
}

function malformed(args: readonly string[], error: unknown): AmbiguityReason {
  return {
    code: "malformed_git_output",
    command: commandName(args),
    detail:
      error instanceof MalformedStatusError || error instanceof Error
        ? error.message
        : String(error),
  };
}

function commandName(args: readonly string[]): string {
  return `git ${args.slice(0, 3).join(" ")}`;
}

function limited(value: string): string | undefined {
  const text = value.slice(0, 500);
  return text || undefined;
}

function isOutsideRepositoryDiagnostic(stderr: string): boolean {
  return stderr.toLowerCase().includes("not a git repository");
}

function stripFinalLineFeed(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function splitLines(value: string): string[] {
  const stripped = stripFinalLineFeed(value);
  return stripped === "" ? [] : stripped.split("\n");
}

function headOid(head: HeadState): CommitOid | undefined {
  return head.kind === "unborn" ? undefined : head.oid;
}

function attachedBranch(head: HeadState): string | undefined {
  return head.kind === "attached" || head.kind === "unborn" ? head.branchRef : undefined;
}

function sameIdentity(left: WorktreeIdentity, right: WorktreeIdentity): boolean {
  return (
    left.rootDirectory === right.rootDirectory &&
    left.gitDirectory === right.gitDirectory &&
    left.repository.commonDirectory === right.repository.commonDirectory &&
    left.repository.objectFormat === right.repository.objectFormat
  );
}

function sameHead(left: HeadState, right: HeadState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "detached" && right.kind === "detached") return left.oid === right.oid;
  if (left.kind === "unborn" && right.kind === "unborn") return left.branchRef === right.branchRef;
  return (
    left.kind === "attached" &&
    right.kind === "attached" &&
    left.branchRef === right.branchRef &&
    left.oid === right.oid
  );
}

function deduplicateIssues(issues: readonly AmbiguityReason[]): AmbiguityReason[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = JSON.stringify(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
