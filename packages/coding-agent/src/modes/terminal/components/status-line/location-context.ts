import * as path from "node:path";
import { type ActiveRepoContext, resolveActiveRepoContextSync } from "../../../../utils/active-repo-context";
import { linkedWorktreeFromFiles } from "../../../../utils/git-head";
import type { LocationWorktree } from "./location";

export interface LocationContext {
	projectDir: string;
	activeRepo: ActiveRepoContext | null;
	effectiveGitCwd: string;
	worktree: LocationWorktree | null;
}

function resolveWorktreeContext(cwd: string): LocationWorktree | null {
	const worktree = linkedWorktreeFromFiles(cwd);
	if (!worktree) return null;
	const base = path.basename(worktree.primaryRoot);
	const projectName = base.endsWith(".git") ? base.slice(0, -4) : base;
	if (!projectName) return null;
	return { projectName, worktreeName: path.basename(worktree.root) };
}

/** Filesystem-only location facts shared by launch and mounted status rows. */
export function resolveLocationContext(projectDir: string): LocationContext {
	const activeRepo = resolveActiveRepoContextSync(projectDir);
	const effectiveGitCwd = activeRepo?.repoRoot ?? projectDir;
	// A single-child repository retains its parent-to-child path instead of worktree collapse.
	const worktree = activeRepo ? null : resolveWorktreeContext(effectiveGitCwd);
	return { projectDir, activeRepo, effectiveGitCwd, worktree };
}
