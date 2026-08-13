import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeGitCommandRunner, type GitCommandRunner } from "../../src/git/command-runner.js";
import { createLocalGitTracker } from "../../src/git/local-git-tracker.js";
import type { GitObservation } from "../../src/git/types.js";

const temporaryDirectories: string[] = [];
const tracker = createLocalGitTracker(createNodeGitCommandRunner());

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("LocalGitTracker.observe", () => {
  it("does not misclassify an operational discovery failure as outside a repository", async () => {
    const runner: GitCommandRunner = {
      run() {
        return Promise.resolve({ stdout: "", stderr: "permission denied", code: 2, killed: false });
      },
    };

    const result = await createLocalGitTracker(runner).observe(process.cwd());
    expect(result).toMatchObject({
      kind: "failed",
      issues: [{ code: "git_command_failed", exitCode: 2 }],
    });
  });

  it("distinguishes an outside directory and an unborn repository", async () => {
    const outside = temporaryDirectory();
    await expect(tracker.observe(outside)).resolves.toMatchObject({ kind: "outside_repository" });

    const repository = initializeRepository();
    const observation = await observe(repository);
    expect(observation.head).toEqual({
      kind: "unborn",
      branchRef: "refs/heads/main",
      branchName: "main",
    });
    expect(observation.workingTree.dirty).toBe(false);
  });

  it("observes a repository whose root path contains a newline", async () => {
    const parent = temporaryDirectory();
    const repository = join(parent, "repository\nname");
    mkdirSync(repository);
    initializeRepositoryAt(repository);

    const observation = await observe(repository);
    expect(observation.identity.rootDirectory).toBe(realpathSync(repository));
  });

  it("uses the common Git directory for repositories and private Git directories for worktrees", async () => {
    const repository = initializeRepository();
    commit(repository, "base");
    const linked = join(temporaryDirectory(), "linked tree");
    git(repository, "worktree", "add", "-b", "linked", linked);

    const mainObservation = await observe(join(repository, "nested"));
    const linkedObservation = await observe(linked);
    expect(mainObservation.identity.repository.commonDirectory).toBe(
      linkedObservation.identity.repository.commonDirectory,
    );
    expect(mainObservation.identity.gitDirectory).not.toBe(linkedObservation.identity.gitDirectory);
    expect(linkedObservation.identity.rootDirectory).toBe(realpathSync(linked));
  });

  it("captures exact origin, all remote URLs, upstream state, and dirty paths", async () => {
    const repository = initializeRepository();
    commit(repository, "base");
    git(repository, "remote", "add", "origin", "https://example.test/fetch-one.git");
    git(repository, "remote", "set-url", "--add", "origin", "https://example.test/fetch-two.git");
    git(
      repository,
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "ssh://example.test/push-one.git",
    );
    git(
      repository,
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "ssh://example.test/push-two.git",
    );
    git(repository, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repository, "branch", "--set-upstream-to=origin/main", "main");
    writeFileSync(join(repository, "odd\n name.txt"), "untracked");

    const observation = await observe(repository);
    expect(observation.origin).toEqual({
      name: "origin",
      fetchUrls: ["https://example.test/fetch-one.git", "https://example.test/fetch-two.git"],
      pushUrls: ["ssh://example.test/push-one.git", "ssh://example.test/push-two.git"],
      pushUsesFetchUrls: false,
    });
    expect(observation.upstream).toMatchObject({
      kind: "configured",
      trackingRef: "refs/remotes/origin/main",
      remoteName: "origin",
      remoteRef: "refs/heads/main",
      ahead: 0,
      behind: 0,
    });
    expect(observation.workingTree.paths).toContainEqual({
      kind: "untracked",
      path: "odd\n name.txt",
    });
  });

  it("records observation time after the consistency checks complete", async () => {
    const repository = initializeRepository();
    commit(repository, "base");
    const delegate = createNodeGitCommandRunner();
    let completedCommands = 0;
    const countingRunner: GitCommandRunner = {
      async run(args, options) {
        const result = await delegate.run(args, options);
        completedCommands += 1;
        return result;
      },
    };
    const timedTracker = createLocalGitTracker(countingRunner, {
      now: () => new Date(completedCommands * 1_000),
    });

    const result = await timedTracker.observe(repository);
    expect(result).toMatchObject({
      kind: "observed",
      observation: { observedAt: new Date(completedCommands * 1_000).toISOString() },
    });
  });

  it("keeps a configured upstream when ahead/behind traversal fails", async () => {
    const repository = initializeRepository();
    commit(repository, "base");
    git(repository, "remote", "add", "origin", "https://example.test/repository.git");
    git(repository, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repository, "branch", "--set-upstream-to=origin/main", "main");

    const delegate = createNodeGitCommandRunner();
    const failingRunner: GitCommandRunner = {
      run(args, options) {
        if (args[0] === "rev-list" && args.includes("--count")) {
          return Promise.resolve({ stdout: "", stderr: "graph failed", code: 2, killed: false });
        }
        return delegate.run(args, options);
      },
    };
    const result = await createLocalGitTracker(failingRunner).observe(repository);
    expect(result).toMatchObject({
      kind: "observed",
      observation: {
        upstream: { kind: "configured", trackingRef: "refs/remotes/origin/main" },
        issues: [{ code: "git_command_failed", exitCode: 2 }],
      },
    });
  });

  it("represents a gone upstream and multiple merge refs without guessing", async () => {
    const repository = initializeRepository();
    commit(repository, "base");
    git(repository, "remote", "add", "origin", "https://example.test/repository.git");
    git(repository, "config", "branch.main.remote", "origin");
    git(repository, "config", "branch.main.merge", "refs/heads/main");

    const gone = await observe(repository);
    expect(gone.upstream).toMatchObject({ kind: "gone", trackingRef: "refs/remotes/origin/main" });
    expect(gone.issues).not.toContainEqual({
      code: "upstream_ref_gone",
      ref: "refs/remotes/origin/main",
    });

    git(repository, "config", "--add", "branch.main.merge", "refs/heads/other");
    const ambiguous = await observe(repository);
    expect(ambiguous.upstream).toMatchObject({ kind: "ambiguous" });
    expect(ambiguous.issues).toContainEqual({
      code: "multiple_upstream_merge_refs",
      refs: ["refs/heads/main", "refs/heads/other"],
    });
  });
});

describe("LocalGitTracker.compare", () => {
  it("returns deterministic observed commits for a clean linear fast-forward", async () => {
    const repository = initializeRepository();
    commit(repository, "base");
    const before = await observe(repository);
    const first = commit(repository, "first");
    const second = commit(repository, "second");
    const after = await observe(repository);

    const range = await tracker.compare(before, after);
    expect(range.relation).toBe("fast_forward");
    expect(range.beforeOnly).toEqual([]);
    expect(range.afterOnly).toEqual([first, second]);
    expect(range.associations).toEqual([
      { oid: first, relationship: "observed", reasons: [] },
      { oid: second, relationship: "observed", reasons: [] },
    ]);
  });

  it("marks commits from a dirty baseline as ambiguous", async () => {
    const repository = initializeRepository();
    const base = commit(repository, "base");
    writeFileSync(join(repository, "preexisting.txt"), "dirty");
    const before = await observe(repository);
    const old = commit(repository, "old", true);
    git(repository, "reset", "--hard", base);
    const replacement = commit(repository, "replacement");
    const after = await observe(repository);

    const range = await tracker.compare(before, after);
    expect(range.relation).toBe("fast_forward");
    expect(range.beforeOnly).toEqual([]);
    expect(range.afterOnly).toEqual([replacement]);
    expect(range.issues).toContainEqual({
      code: "preexisting_dirty_changes_may_have_been_committed",
    });
    expect(range.associations[0]?.relationship).toBe("ambiguous");
    expect(old).not.toBe(replacement);
  });

  it("exposes both sides of divergence and branch-change ambiguity", async () => {
    const repository = initializeRepository();
    const base = commit(repository, "base");
    const beforeOnly = commit(repository, "old-tip");
    const before = await observe(repository);
    git(repository, "checkout", "-B", "replacement", base);
    const afterOnly = commit(repository, "new-tip");
    const after = await observe(repository);

    const range = await tracker.compare(before, after);
    expect(range.relation).toBe("diverged");
    expect(range.beforeOnly).toEqual([beforeOnly]);
    expect(range.afterOnly).toEqual([afterOnly]);
    expect(range.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "head_moved_non_fast_forward",
        "branch_changed_between_observations",
      ]),
    );
    expect(range.associations[0]?.relationship).toBe("ambiguous");
  });

  it("only treats detached HEAD as ambiguous when branch-scoped attribution is required", async () => {
    const repository = initializeRepository();
    commit(repository, "base");
    git(repository, "checkout", "--detach");
    const before = await observe(repository);
    const next = commit(repository, "detached");
    const after = await observe(repository);

    const unscoped = await tracker.compare(before, after);
    expect(unscoped.associations).toEqual([{ oid: next, relationship: "observed", reasons: [] }]);

    const scoped = await tracker.compare(before, after, { requireBranchScopedAttribution: true });
    expect(scoped.issues).toContainEqual({ code: "detached_head_during_interaction" });
    expect(scoped.associations[0]?.relationship).toBe("ambiguous");
  });

  it("handles unborn boundaries without inventing confident attribution", async () => {
    const repository = initializeRepository();
    const before = await observe(repository);
    const first = commit(repository, "first");
    const after = await observe(repository);

    const range = await tracker.compare(before, after);
    expect(range.relation).toBe("unavailable");
    expect(range.afterOnly).toEqual([first]);
    expect(range.issues).toContainEqual({
      code: "head_missing_at_range_boundary",
      boundary: "before",
    });
    expect(range.associations[0]?.relationship).toBe("ambiguous");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-ledger-git-"));
  temporaryDirectories.push(directory);
  return directory;
}

function initializeRepository(): string {
  const repository = temporaryDirectory();
  initializeRepositoryAt(repository);
  return repository;
}

function initializeRepositoryAt(repository: string): void {
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Pi Ledger Test");
  git(repository, "config", "user.email", "pi-ledger@example.test");
  mkdirSync(join(repository, "nested"));
}

function commit(repository: string, message: string, includeAll = false): string {
  const path = join(repository, `${message}.txt`);
  writeFileSync(path, message);
  git(repository, "add", includeAll ? "-A" : `${message}.txt`);
  git(repository, "commit", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  }).trimEnd();
}

async function observe(cwd: string): Promise<GitObservation> {
  const result = await tracker.observe(cwd);
  if (result.kind !== "observed") throw new Error(`Expected observation, received ${result.kind}`);
  return result.observation;
}
