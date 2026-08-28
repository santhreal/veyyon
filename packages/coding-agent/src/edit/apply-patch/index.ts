import { errorMessage } from "@veyyon/utils";
import { ApplyPatchError } from "../diff";
import { type ApplyPatchOptions, type ApplyPatchResult, applyPatch, type PatchInput } from "../modes/patch";
import { parseApplyPatch } from "./parser";

export * from "./parser";

export interface ApplyCodexPatchResult {
	results: ApplyPatchResult[];
	affected: {
		added: string[];
		modified: string[];
		deleted: string[];
	};
}

export class PartialApplyPatchError extends ApplyPatchError {
	constructor(
		readonly results: ApplyPatchResult[],
		readonly affected: ApplyCodexPatchResult["affected"],
		readonly failedPath: string,
		readonly unappliedPaths: string[],
		readonly cause: unknown,
	) {
		super(PartialApplyPatchError.#formatMessage(affected, failedPath, unappliedPaths, cause));
		this.name = "PartialApplyPatchError";
	}

	static #formatMessage(
		affected: ApplyCodexPatchResult["affected"],
		failedPath: string,
		unappliedPaths: string[],
		cause: unknown,
	): string {
		const appliedPaths = affected.added.concat(affected.modified, affected.deleted);
		const lines = [`Failed to apply ${failedPath}: ${errorMessage(cause)}`];
		if (appliedPaths.length > 0) {
			lines.push(`Files already applied: ${appliedPaths.join(", ")}.`);
		}
		if (unappliedPaths.length > 0) {
			lines.push(
				`Files NOT applied: ${unappliedPaths.join(", ")}; re-read the affected files and re-issue only the failed and unapplied files.`,
			);
		}
		return lines.join("\n");
	}
}

export async function applyCodexPatch(patchText: string, options: ApplyPatchOptions): Promise<ApplyCodexPatchResult> {
	const hunks = parseApplyPatch(patchText);

	if (hunks.length === 0) {
		throw new ApplyPatchError("No files were modified.");
	}

	const results: ApplyPatchResult[] = [];
	const affected = {
		added: [] as string[],
		modified: [] as string[],
		deleted: [] as string[],
	};

	for (let i = 0; i < hunks.length; i++) {
		const hunk = hunks[i];
		try {
			const result = await applyPatch(hunk, options);
			results.push(result);
			recordAffected(affected, hunk, result);
		} catch (cause) {
			const unappliedPaths = hunks.slice(i + 1).map(h => h.path);
			throw new PartialApplyPatchError(results, affected, hunk.path, unappliedPaths, cause);
		}
	}

	return { results, affected };
}

function recordAffected(
	affected: ApplyCodexPatchResult["affected"],
	hunk: PatchInput,
	_result: ApplyPatchResult,
): void {
	switch (hunk.op) {
		case "create":
			affected.added.push(hunk.path);
			break;
		case "delete":
			affected.deleted.push(hunk.path);
			break;
		case "update":
			affected.modified.push(hunk.path);
			break;
	}
}

export function formatApplyCodexPatchSummary(affected: ApplyCodexPatchResult["affected"]): string {
	const lines = ["Success. Updated the following files:"];
	for (const p of affected.added) lines.push(`A ${p}`);
	for (const p of affected.modified) lines.push(`M ${p}`);
	for (const p of affected.deleted) lines.push(`D ${p}`);
	return lines.join("\n");
}
