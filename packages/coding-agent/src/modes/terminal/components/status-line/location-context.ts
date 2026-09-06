import {
	type ActiveRepoContext,
	resolveActiveRepoContextSync,
	resolveWorktreeContext,
} from "../../../../utils/active-repo-context";
import type { LocationWorktree } from "./location";

export interface LocationContext {
	projectDir: string;
	activeRepo: ActiveRepoContext | null;
	effectiveGitCwd: string;
	worktree: LocationWorktree | null;
}

/** Filesystem-only location facts shared by launch and mounted status rows. */
export function resolveLocationContext(projectDir: string): LocationContext {
	const activeRepo = resolveActiveRepoContextSync(projectDir);
	const effectiveGitCwd = activeRepo?.repoRoot ?? projectDir;
	// A single-child repository retains its parent-to-child path instead of worktree collapse.
	const worktree = activeRepo ? null : resolveWorktreeContext(effectiveGitCwd);
	return { projectDir, activeRepo, effectiveGitCwd, worktree };
}
