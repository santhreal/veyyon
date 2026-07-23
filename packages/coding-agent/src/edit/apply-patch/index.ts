/**
 * Multi-file orchestrator for the Codex `apply_patch` envelope.
 *
 * Decoupled from tool-registration: takes raw patch text + options, parses
 * it, and applies each hunk via the existing single-file `applyPatch` in
 * `../modes/patch.ts`. A future OpenAI freeform/grammar tool variant can
 * call this directly with the raw grammar output.
 *
 * Per spec §6.1, hunks are applied in order and NOT atomically — if hunk
 * N fails, hunks `0..N-1` are already on disk. We surface that by throwing
 * `PartialApplyPatchError`, which carries the applied results and names the
 * applied vs. unapplied files, so a mid-batch failure is never silent.
 */

import { errorMessage } from "@veyyon/utils";
import { ApplyPatchError } from "../diff";
import { type ApplyPatchOptions, type ApplyPatchResult, applyPatch, type PatchInput } from "../modes/patch";
import { parseApplyPatch } from "./parser";

export * from "./parser";

export interface ApplyCodexPatchResult {
	/** Single-file apply results in the order they were attempted. */
	results: ApplyPatchResult[];
	/** Affected file paths grouped by operation, for the §9.1 summary. */
	affected: {
		added: string[];
		modified: string[];
		deleted: string[];
	};
}

/**
 * Thrown when a hunk fails partway through a non-atomic `apply_patch` envelope.
 *
 * The envelope applies hunks in order and is NOT transactional (spec §6.1): by
 * the time hunk N fails, hunks `0..N-1` are already written to disk. A bare
 * error would hide that, leaving the caller to assume nothing changed and the
 * already-mutated files silently diverged. This error is the fix for that
 * silent partial application: it carries the successfully applied results and
 * the affected-path breakdown, and its message names exactly which files are
 * already on disk and which were never reached, so the caller can re-read the
 * applied files and re-issue only the failed and unapplied ones. It extends
 * {@link ApplyPatchError} so existing `instanceof ApplyPatchError` handling and
 * `rejects.toThrow` expectations still hold.
 */
export class PartialApplyPatchError extends ApplyPatchError {
	constructor(
		/** The single-file results that succeeded before the failure, in order. */
		readonly results: ApplyPatchResult[],
		/** Operation breakdown for the files already written to disk. */
		readonly affected: ApplyCodexPatchResult["affected"],
		/** The path of the hunk whose application threw. */
		readonly failedPath: string,
		/** Paths of hunks after the failure that were never attempted. */
		readonly unappliedPaths: string[],
		/** The underlying failure. */
		readonly cause: unknown,
	) {
		super(PartialApplyPatchError.formatMessage(affected, failedPath, unappliedPaths, cause));
		this.name = "PartialApplyPatchError";
	}

	private static formatMessage(
		affected: ApplyCodexPatchResult["affected"],
		failedPath: string,
		unappliedPaths: string[],
		cause: unknown,
	): string {
		const appliedPaths = [...affected.added, ...affected.modified, ...affected.deleted];
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

/**
 * Apply a full Codex `*** Begin Patch` envelope.
 *
 * Note: renames are reported under `modified` with the original path (spec
 * §9.1), not as a delete + add.
 *
 * Hunks apply in order and NOT atomically (spec §6.1). If a hunk fails, the
 * hunks before it are already on disk; rather than let a bare error hide that,
 * this throws {@link PartialApplyPatchError} carrying the applied results and
 * the applied-vs-unapplied path breakdown.
 */
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

/**
 * Format the A/M/D summary described in spec §9.1.
 */
export function formatApplyCodexPatchSummary(affected: ApplyCodexPatchResult["affected"]): string {
	const lines = ["Success. Updated the following files:"];
	for (const p of affected.added) lines.push(`A ${p}`);
	for (const p of affected.modified) lines.push(`M ${p}`);
	for (const p of affected.deleted) lines.push(`D ${p}`);
	return lines.join("\n");
}
