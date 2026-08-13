export type CommitOid = string & { readonly __commitOid: unique symbol };
export type AbsolutePath = string & { readonly __absolutePath: unique symbol };

export interface RepositoryIdentity {
  commonDirectory: AbsolutePath;
  objectFormat: string;
}

export interface WorktreeIdentity {
  repository: RepositoryIdentity;
  gitDirectory: AbsolutePath;
  rootDirectory: AbsolutePath;
}

export type HeadState =
  | { kind: "attached"; branchRef: string; branchName: string; oid: CommitOid }
  | { kind: "detached"; oid: CommitOid }
  | { kind: "unborn"; branchRef: string; branchName: string };

export interface RemoteObservation {
  name: string;
  fetchUrls: readonly string[];
  pushUrls: readonly string[];
  pushUsesFetchUrls: boolean;
}

export interface UpstreamCandidate {
  mergeRef: string;
  trackingRef?: string;
  remoteName?: string;
  remoteRef?: string;
}

export type UpstreamState =
  | { kind: "none" }
  | {
      kind: "configured";
      trackingRef: string;
      remoteName: string;
      remoteRef: string;
      oid?: CommitOid;
      ahead?: number;
      behind?: number;
    }
  | {
      kind: "gone";
      trackingRef: string;
      remoteName: string;
      remoteRef: string;
    }
  | { kind: "ambiguous"; candidates: readonly UpstreamCandidate[] };

export type ChangedPathKind = "ordinary" | "renamed" | "copied" | "unmerged" | "untracked";

export interface ChangedPath {
  kind: ChangedPathKind;
  path: string;
  originalPath?: string;
  indexStatus?: string;
  worktreeStatus?: string;
  submoduleStatus?: string;
}

export interface WorkingTreeStatus {
  dirty: boolean;
  paths: readonly ChangedPath[];
  counts: {
    staged: number;
    unstaged: number;
    untracked: number;
    unmerged: number;
    submodule: number;
  };
}

export type AmbiguityReason =
  | { code: "git_unavailable"; detail?: string }
  | { code: "git_command_failed"; command: string; exitCode: number }
  | { code: "git_command_timed_out"; command: string }
  | { code: "git_command_aborted"; command: string }
  | { code: "malformed_git_output"; command: string; detail: string }
  | { code: "unsupported_path_encoding"; command: string }
  | { code: "state_changed_during_observation" }
  | { code: "multiple_upstream_merge_refs"; refs: readonly string[] }
  | { code: "upstream_ref_gone"; ref: string }
  | { code: "repository_changed_between_observations" }
  | { code: "worktree_changed_between_observations" }
  | { code: "head_missing_at_range_boundary"; boundary: "before" | "after" }
  | { code: "range_endpoint_unavailable"; oid: string }
  | { code: "head_moved_non_fast_forward" }
  | { code: "branch_changed_between_observations" }
  | { code: "detached_head_during_interaction" }
  | { code: "preexisting_dirty_changes_may_have_been_committed" };

export interface GitObservation {
  identity: WorktreeIdentity;
  head: HeadState;
  remotes: readonly RemoteObservation[];
  origin?: RemoteObservation;
  upstream: UpstreamState;
  workingTree: WorkingTreeStatus;
  observedAt: string;
  issues: readonly AmbiguityReason[];
}

export type GitDiscoveryResult =
  | { kind: "outside_repository"; cwd: AbsolutePath }
  | { kind: "unsupported_repository"; reason: "bare" | "no_worktree" }
  | { kind: "observed"; observation: GitObservation }
  | { kind: "failed"; issues: readonly AmbiguityReason[] };

export interface CommitRangeResult {
  relation: "unchanged" | "fast_forward" | "rewound" | "diverged" | "unrelated" | "unavailable";
  before?: CommitOid;
  after?: CommitOid;
  beforeOnly: readonly CommitOid[];
  afterOnly: readonly CommitOid[];
  associations: readonly {
    oid: CommitOid;
    relationship: "observed" | "ambiguous";
    reasons: readonly AmbiguityReason[];
  }[];
  issues: readonly AmbiguityReason[];
}

export interface LocalGitTracker {
  observe(cwd: string, options?: { signal?: AbortSignal }): Promise<GitDiscoveryResult>;
  compare(
    before: GitObservation,
    after: GitObservation,
    options?: { signal?: AbortSignal; requireBranchScopedAttribution?: boolean },
  ): Promise<CommitRangeResult>;
}
