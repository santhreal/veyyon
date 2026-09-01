import * as fs from "node:fs/promises";
import * as path from "node:path";
import { diff, repo, status } from "../../utils/git";
import type { ChangedFile, ChangeScope, ChangeStatus } from "../wire";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

async function emitChangesSnapshot(ctx: ActionContext): Promise<void> {
	const selectedScope = ctx.clientState.selectedChangeScope;
	const scope: ChangeScope = selectedScope === "Staged" ? "Staged" : "WorkingTree";

	const gitRepo = await repo.resolve(ctx.cwd);
	if (!gitRepo) {
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			Changes: {
				revision: ctx.clientState.revision,
				repository: null,
				scope,
				files: [],
				diff: "",
			},
		});
		return;
	}

	const isStaged = scope === "Staged";
	const [rawStatus, unifiedDiff, numstats] = await Promise.all([
		status(gitRepo.repoRoot, { porcelainV1: true, untrackedFiles: "all" }),
		diff(gitRepo.repoRoot, { cached: isStaged }),
		diff.numstat(gitRepo.repoRoot, { cached: isStaged }),
	]);

	const numstatMap = new Map<string, { additions: number; deletions: number }>();
	for (const entry of numstats) {
		numstatMap.set(entry.path, { additions: entry.additions, deletions: entry.deletions });
	}

	const files: ChangedFile[] = [];
	for (const line of rawStatus.split("\n")) {
		if (!line || line.length < 3) continue;

		const x = line[0];
		const y = line[1];
		const rawPathPart = line.slice(3).trim();
		if (!rawPathPart) continue;

		const unquote = (s: string) =>
			s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\") : s;
		let filePath = "";
		let previousPath: string | null = null;
		if (rawPathPart.includes(" -> ")) {
			const [origRaw, newRaw] = rawPathPart.split(" -> ");
			previousPath = unquote(origRaw.trim());
			filePath = unquote(newRaw.trim());
		} else {
			filePath = unquote(rawPathPart);
		}

		if (isStaged) {
			if (x === " " || x === "?" || x === "!") continue;
			let changeStatus: ChangeStatus;
			if (x === "M") changeStatus = "Modified";
			else if (x === "A") changeStatus = "Added";
			else if (x === "D") changeStatus = "Deleted";
			else if (x === "R") changeStatus = "Renamed";
			else if (x === "C") changeStatus = "Added";
			else if (x === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) changeStatus = "Conflicted";
			else changeStatus = "Modified";

			const stats = numstatMap.get(filePath) ?? { additions: 0, deletions: 0 };
			files.push({
				path: filePath,
				previous_path: previousPath,
				status: changeStatus,
				additions: stats.additions,
				deletions: stats.deletions,
			});
		} else {
			let changeStatus: ChangeStatus | null = null;
			if (x === "?" && y === "?") {
				changeStatus = "Untracked";
			} else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
				changeStatus = "Conflicted";
			} else if (y === "M") {
				changeStatus = "Modified";
			} else if (y === "D") {
				changeStatus = "Deleted";
			} else if (y === "A") {
				changeStatus = "Added";
			} else if (y === "R") {
				changeStatus = "Renamed";
			}

			if (!changeStatus) continue;

			let additions = 0;
			let deletions = 0;
			const stats = numstatMap.get(filePath);
			if (stats) {
				additions = stats.additions;
				deletions = stats.deletions;
			} else if (changeStatus === "Untracked") {
				try {
					const fullPath = path.resolve(gitRepo.repoRoot, filePath);
					const statInfo = await fs.stat(fullPath);
					if (statInfo.isFile()) {
						const content = await fs.readFile(fullPath, "utf8");
						if (content.length > 0) {
							const lines = content.split("\n");
							additions = content.endsWith("\n") ? lines.length - 1 : lines.length;
						}
					}
				} catch {
					additions = 0;
				}
			}

			files.push({
				path: filePath,
				previous_path: previousPath,
				status: changeStatus,
				additions,
				deletions,
			});
		}
	}

	ctx.clientState.revision += 1;
	ctx.reply.snapshot({
		Changes: {
			revision: ctx.clientState.revision,
			repository: gitRepo.repoRoot,
			scope,
			files,
			diff: unifiedDiff,
		},
	});
}

const handleRefreshChanges: ActionHandler = async ctx => {
	try {
		await emitChangesSnapshot(ctx);
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Change",
			code: "VCS_ERROR",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

interface SelectChangeScopePayload {
	scope?: string;
}

const handleSelectChangeScope: ActionHandler<SelectChangeScopePayload | undefined> = async (ctx, payload) => {
	if (!payload?.scope || (payload.scope !== "WorkingTree" && payload.scope !== "Staged")) {
		ctx.reply.failure({
			scope: "Change",
			code: "INVALID_ARGUMENTS",
			message: "SelectChangeScope requires scope to be 'WorkingTree' or 'Staged'",
			retryable: false,
		});
		return;
	}

	ctx.clientState.selectedChangeScope = payload.scope;
	try {
		await emitChangesSnapshot(ctx);
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Change",
			code: "VCS_ERROR",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

export const changesActionHandlers: ActionHandlersMap = {
	RefreshChanges: handleRefreshChanges as ActionHandler<never>,
	SelectChangeScope: handleSelectChangeScope as ActionHandler<never>,
};
