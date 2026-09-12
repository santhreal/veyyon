import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { diff, repo, status } from "../../utils/git";
import type { ClientSessionState } from "../turns";
import type { ChangedFile, ChangeScope, ChangeStatus, ChangesView } from "../wire";
import type { ActionHandler, ActionHandlersMap } from "./types";

/**
 * What one changes snapshot carries at most.
 *
 * A working tree has no size limit, a frame does: a snapshot over
 * `MAX_FRAME_BYTES` is refused rather than written, and the diff of a
 * generated directory or a vendored tree reaches that on its own. The window
 * draws at most 2,000 changed rows per file, so a diff past this budget is
 * already past what a reader reaches, and JSON escaping of diff text inflates
 * what the budget costs on the wire.
 */
export const CHANGES_MAX_DIFF_BYTES = 4 * 1024 * 1024;
export const CHANGES_MAX_FILES = 2_000;

/**
 * The working tree or the index as git reports it now.
 *
 * A view rather than a frame, because two callers publish it: the action a
 * client sends, and the re-statement the host makes when a turn that edited
 * files goes idle.
 */
export async function changesView(cwd: string, state: ClientSessionState): Promise<ChangesView> {
	const selectedScope = state.selectedChangeScope;
	const scope: ChangeScope = selectedScope === "Staged" ? "Staged" : "WorkingTree";

	const gitRepo = await repo.resolve(cwd);
	if (!gitRepo) {
		state.revision += 1;
		return {
			revision: state.revision,
			repository: null,
			scope,
			files: [],
			diff: "",
			diff_truncated: false,
			files_withheld: 0,
		};
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
	let filesWithheld = 0;
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

			if (files.length >= CHANGES_MAX_FILES) {
				filesWithheld += 1;
				continue;
			}

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

			if (files.length >= CHANGES_MAX_FILES) {
				filesWithheld += 1;
				continue;
			}

			let additions = 0;
			let deletions = 0;
			const stats = numstatMap.get(filePath);
			if (stats) {
				additions = stats.additions;
				deletions = stats.deletions;
			} else if (changeStatus === "Untracked") {
				additions = await countLines(path.resolve(gitRepo.repoRoot, filePath));
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

	const budgeted = budgetDiff(unifiedDiff);
	state.revision += 1;
	return {
		revision: state.revision,
		repository: gitRepo.repoRoot,
		scope,
		files,
		diff: budgeted.diff,
		diff_truncated: budgeted.truncated,
		files_withheld: filesWithheld,
	};
}

/**
 * Cuts a unified diff to `CHANGES_MAX_DIFF_BYTES` on the last boundary that
 * fits: a file header, else a hunk header, else a line.
 *
 * A cut inside a hunk body would leave a hunk header stating line counts the
 * lines beneath it no longer meet, and the window's parser reads those counts
 * to number every row that follows.
 */
function budgetDiff(unifiedDiff: string): { diff: string; truncated: boolean } {
	if (Buffer.byteLength(unifiedDiff, "utf8") <= CHANGES_MAX_DIFF_BYTES) {
		return { diff: unifiedDiff, truncated: false };
	}

	const head = Buffer.from(unifiedDiff, "utf8").subarray(0, CHANGES_MAX_DIFF_BYTES);
	for (const boundary of ["\ndiff --git ", "\n@@ ", "\n"]) {
		const cut = head.lastIndexOf(boundary);
		// The newline the boundary opens with terminates the last line kept, so
		// the cut keeps it and drops the boundary itself.
		if (cut > 0) return { diff: head.subarray(0, cut + 1).toString("utf8"), truncated: true };
	}
	return { diff: "", truncated: true };
}

/**
 * Counts the lines in a file without holding it in memory.
 *
 * An untracked file's additions are its line count, and this is the one path
 * here that reads file content: a working tree can carry an untracked file
 * larger than a string this runtime can allocate, so the bytes stream past a
 * counter rather than landing in one.
 */
async function countLines(filePath: string): Promise<number> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(filePath, "r");
		const stats = await handle.stat();
		if (!stats.isFile() || stats.size === 0) return 0;

		const buffer = Buffer.allocUnsafe(64 * 1024);
		let lines = 0;
		let lastByte = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			for (let i = 0; i < bytesRead; i += 1) {
				if (buffer[i] === 0x0a) lines += 1;
			}
			lastByte = buffer[bytesRead - 1] ?? 0;
		}
		return lastByte === 0x0a ? lines : lines + 1;
	} catch {
		return 0;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

const handleRefreshChanges: ActionHandler = async ctx => {
	try {
		ctx.reply.snapshot({ Changes: await changesView(ctx.cwd, ctx.clientState) });
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Change",
			code: "VCS_ERROR",
			message: errorMessage(error),
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
		ctx.reply.snapshot({ Changes: await changesView(ctx.cwd, ctx.clientState) });
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Change",
			code: "VCS_ERROR",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

export const changesActionHandlers: ActionHandlersMap = {
	RefreshChanges: handleRefreshChanges as ActionHandler<never>,
	SelectChangeScope: handleSelectChangeScope as ActionHandler<never>,
};
