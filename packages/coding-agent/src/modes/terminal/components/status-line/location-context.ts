import * as path from "node:path";
import {
	type ActiveRepoContext,
	findSingleDirectChildRepoSync,
	resolveWorktreeContext,
} from "../../../../utils/active-repo-context";
import { type GitRepository, resolveRepositorySync } from "../../../../utils/git-head";
import type { LocationWorktree } from "./location";

export interface LocationContext {
	projectDir: string;
	activeRepo: ActiveRepoContext | null;
	effectiveGitCwd: string;
	worktree: LocationWorktree | null;
	repository: GitRepository | null;
}

/** Filesystem-only location facts shared by launch and mounted status rows. */
export function resolveLocationContext(projectDir: string): LocationContext {
	const resolvedProjectDir = path.resolve(projectDir);
	const repository = resolveRepositorySync(resolvedProjectDir);

	if (repository) {
		const worktree = resolveWorktreeContext(repository);
		return {
			projectDir,
			activeRepo: null,
			effectiveGitCwd: projectDir,
			worktree,
			repository,
		};
	}

	const activeRepo = findSingleDirectChildRepoSync(resolvedProjectDir);
	if (activeRepo) {
		const effectiveGitCwd = activeRepo.repoRoot;
		const childRepo = resolveRepositorySync(effectiveGitCwd);
		return {
			projectDir,
			activeRepo,
			effectiveGitCwd,
			worktree: null,
			repository: childRepo,
		};
	}

	return {
		projectDir,
		activeRepo: null,
		effectiveGitCwd: projectDir,
		worktree: null,
		repository: null,
	};
}
