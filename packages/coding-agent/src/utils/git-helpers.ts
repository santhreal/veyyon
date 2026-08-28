export interface GitCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface GitRepository {
	commonDir: string;
	gitDir: string;
	gitEntryPath: string;
	headPath: string;
	repoRoot: string;
	isReftable?: boolean;
}

export interface GitStatusSummary {
	staged: number;
	unstaged: number;
	untracked: number;
	truncated: boolean;
}

export type HunkSelection = {
	path: string;
	hunks: { type: "all" } | { type: "indices"; indices: number[] } | { type: "lines"; start: number; end: number };
};

export interface StageHunksOptions {
	readonly diffCached?: boolean;
	readonly rawDiff?: string;
	readonly signal?: AbortSignal;
}
export interface HunkSelectionValidationError {
	readonly path: string;
	readonly message: string;
}

export interface DiffOptions {
	readonly allowFailure?: boolean;
	readonly base?: string;
	readonly binary?: boolean;
	readonly cached?: boolean;
	readonly env?: Record<string, string | undefined>;
	readonly files?: readonly string[];
	readonly head?: string;
	readonly nameOnly?: boolean;
	readonly noIndex?: { left: string; right: string };
	readonly numstat?: boolean;
	readonly signal?: AbortSignal;
	readonly stat?: boolean;
}

export interface StatusOptions {
	readonly pathspecs?: readonly string[];
	readonly porcelainV1?: boolean;
	readonly signal?: AbortSignal;
	readonly untrackedFiles?: "all" | "no" | "normal";
	readonly z?: boolean;
}

export interface CommitAuthor {
	readonly date?: string;
	readonly email: string;
	readonly name: string;
}

export interface CommitDetails {
	readonly author: CommitAuthor;
	readonly message: string;
}

export interface CommitOptions {
	readonly allowEmpty?: boolean;
	readonly author?: CommitAuthor;
	readonly files?: readonly string[];
	readonly signal?: AbortSignal;
}

export interface PushOptions {
	readonly forceWithLease?: boolean;
	readonly refspec?: string;
	readonly remote?: string;
	readonly signal?: AbortSignal;
}

export interface PatchOptions {
	readonly cached?: boolean;
	readonly check?: boolean;
	readonly env?: Record<string, string | undefined>;
	readonly reverse?: boolean;
	readonly threeWay?: boolean;
	readonly signal?: AbortSignal;
}

export interface RestoreOptions {
	readonly files?: readonly string[];
	readonly signal?: AbortSignal;
	readonly source?: string;
	readonly staged?: boolean;
	readonly worktree?: boolean;
}

export interface FetchOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface CloneOptions {
	readonly ref?: string;
	readonly sha?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface GitHeadBase extends GitRepository {
	headContent: string;
}

export interface GitRefHead extends GitHeadBase {
	branchName: string | null;
	commit: string | null;
	kind: "ref";
	ref: string;
}

export interface GitDetachedHead extends GitHeadBase {
	commit: string | null;
	kind: "detached";
}

export type GitHeadState = GitRefHead | GitDetachedHead;

export type GitOperationKind = "am" | "bisect" | "cherry-pick" | "merge" | "rebase" | "revert";

export interface GitInProgressOperation {
	kind: GitOperationKind;
	branch: string | null;
}

export interface GitWorktreeEntry {
	branch?: string;
	detached: boolean;
	head?: string;
	path: string;
}
