import type { AgentToolResult } from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { MismatchError as HashlineMismatchError, HL_MOVE_KEYWORD } from "@veyyon/hashline";
import { errorMessage, isCancellation } from "@veyyon/utils";
import { createLspWritethrough, flushLspWritethroughBatch, type WritethroughCallback, writethroughNoop } from "../lsp";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";
import { budgetedFileCommit, sessionBudgetLimits } from "../session/cpu-limit";
import type { ToolSession } from "../tools";
import { abortedPartway } from "../tools/aborted-partway";
import { type EditMode, normalizeEditMode } from "../utils/edit-mode";
import type { EditTool } from "./edit-tool";
import type { hashlineEditParamsSchema } from "./hashline";
import type { ApplyPatchParams, applyPatchSchema } from "./modes/apply-patch";
import type { PatchParams, patchEditSchema } from "./modes/patch";
import type { ReplaceParams, replaceEditSchema } from "./modes/replace";
import type { EditToolDetails, EditToolPerFileResult, LspBatchRequest } from "./renderer";
import { pruneOversizedEditSnapshots } from "./snapshot-details";

export type TInput =
	| typeof replaceEditSchema
	| typeof patchEditSchema
	| typeof hashlineEditParamsSchema
	| typeof applyPatchSchema;

export type HashlineParams = typeof hashlineEditParamsSchema.infer;

export type EditParams = ReplaceParams | PatchParams | HashlineParams | ApplyPatchParams;

export type EditModeDefinition = {
	description: (session: ToolSession) => string;
	parameters: TInput;
	examples?: readonly ToolExample[];
	execute: (
		tool: EditTool,
		params: EditParams,
		signal: AbortSignal | undefined,
		batchRequest: LspBatchRequest | undefined,
		onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
	) => Promise<AgentToolResult<EditToolDetails, TInput>>;
};

export function resolveConfiguredEditMode(rawEditMode: string): EditMode | undefined {
	if (!rawEditMode || rawEditMode === "auto") {
		return undefined;
	}

	const editMode = normalizeEditMode(rawEditMode);
	if (!editMode) {
		throw new Error(`Invalid VEYYON_EDIT_VARIANT: ${rawEditMode}`);
	}

	return editMode;
}

export function resolveAllowFuzzy(session: ToolSession, rawValue: string): boolean {
	switch (rawValue) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		case "auto":
			return session.settings.get("edit.fuzzyMatch");
		default:
			throw new Error(`Invalid VEYYON_EDIT_FUZZY: ${rawValue}`);
	}
}

export function resolveFuzzyThreshold(session: ToolSession, rawValue: string): number {
	if (rawValue === "auto") {
		return session.settings.get("edit.fuzzyThreshold");
	}

	const threshold = Number.parseFloat(rawValue);
	if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
		throw new Error(`Invalid VEYYON_EDIT_FUZZY_THRESHOLD: ${rawValue}`);
	}

	return threshold;
}

export function createEditWritethrough(session: ToolSession): WritethroughCallback {
	const enableLsp = (session.enableLsp ?? true) && session.settings.get("lsp.enabled");
	const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnEdit");
	const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
	const dedup = enableDiagnostics && session.settings.get("lsp.diagnosticsDeduplicate");
	const commit = enableLsp
		? createLspWritethrough(session.cwd, {
				enableFormat,
				enableDiagnostics,
				transformDiagnostics: dedup
					? (path, result) => getDiagnosticsLedger(session).reduce(path, result)
					: undefined,
			})
		: writethroughNoop;
	return budgetedFileCommit(
		{
			sessionId: () => session.getSessionId?.() ?? null,
			limits: () => sessionBudgetLimits(session.settings),
		},
		commit,
	);
}

export function editAbortedPartway(
	unit: "file" | "entry",
	applied: readonly string[],
	pending: readonly string[],
	cause: unknown,
) {
	return abortedPartway(
		{
			operation: "Edit",
			unit: unit === "file" ? { one: "file", many: "files" } : { one: "entry", many: "entries" },
			done: applied,
			pending,
			doneLabel: "already applied",
			pendingLabel: "NOT applied",
			advice: "re-read the affected files before re-issuing",
		},
		cause,
	);
}

export async function flushAfterAbort(batchRequest: LspBatchRequest | undefined, cwd: string): Promise<void> {
	if (!batchRequest?.flush) return;
	await flushLspWritethroughBatch(batchRequest.id, cwd);
}

export async function executeApplyPatchPerFile(
	fileEntries: {
		path: string;
		run: (batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>;
	}[],
	outerBatchRequest: LspBatchRequest | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (fileEntries.length === 1) {
		return fileEntries[0].run(outerBatchRequest);
	}

	const perFileResults: EditToolPerFileResult[] = [];
	const contentTexts: string[] = [];
	let hasError = false;

	const filePaths = fileEntries.map(entry => entry.path);
	for (let i = 0; i < fileEntries.length; i++) {
		const { path, run } = fileEntries[i];
		if (signal?.aborted) {
			await flushAfterAbort(outerBatchRequest, cwd);
			throw editAbortedPartway("file", filePaths.slice(0, i), filePaths.slice(i), signal.reason);
		}
		const isLast = i === fileEntries.length - 1;
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await run(batchRequest);
			const details = result.details;
			perFileResults.push({
				path: details?.path ?? path,
				diff: details?.diff ?? "",
				firstChangedLine: details?.firstChangedLine,
				diagnostics: details?.diagnostics,
				op: details?.op,
				move: details?.move,
				sourcePath: details?.sourcePath,
				meta: details?.meta,
				oldText: details?.oldText,
				newText: details?.newText,
				snapshotsPruned: details?.snapshotsPruned,
			});
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			if (isCancellation(err)) {
				await flushAfterAbort(outerBatchRequest, cwd);
				throw editAbortedPartway("file", filePaths.slice(0, i), filePaths.slice(i), err);
			}
			const errorText = errorMessage(err);
			const displayErrorText = err instanceof HashlineMismatchError ? err.displayMessage : undefined;
			perFileResults.push({ path, diff: "", isError: true, errorText, displayErrorText });
			contentTexts.push(`Error editing ${path}: ${errorText}`);
			hasError = true;
			if (i > 0) {
				const appliedPaths = fileEntries
					.slice(0, i)
					.map(e => e.path)
					.join(", ");
				contentTexts.push(`Files already applied: ${appliedPaths}.`);
			}
			if (i + 1 < fileEntries.length) {
				const skippedPaths = fileEntries
					.slice(i + 1)
					.map(e => e.path)
					.join(", ");
				contentTexts.push(
					`Files NOT applied: ${skippedPaths}; re-read the affected files and re-issue only the failed and unapplied files.`,
				);
			}
			if (outerBatchRequest?.flush) {
				await flushLspWritethroughBatch(outerBatchRequest.id, cwd, signal);
			}
			break;
		}

		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: perFileResults
						.map(r => r.diff)
						.filter(Boolean)
						.join("\n"),
					firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
					perFileResults: perFileResults.slice(),
				},
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: pruneOversizedEditSnapshots({
			diff: perFileResults
				.map(r => r.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
			perFileResults,
		}),
		...(hasError ? { isError: true } : {}),
	};
}

export async function executeSinglePathEntries(
	path: string,
	runs: ((batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>)[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate: ((partialResult: AgentToolResult<EditToolDetails, TInput>) => void) | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (runs.length === 1) {
		return runs[0](outerBatchRequest);
	}

	const contentTexts: string[] = [];
	const diffTexts: string[] = [];
	let firstChangedLine: number | undefined;
	let hasError = false;
	let metadataPath: string | undefined;
	let hasFirstOldText = false;
	let firstOldText: string | undefined;
	let hasLastNewText = false;
	let lastNewText: string | undefined;
	let snapshotsPruned = false;

	const entryLabels = runs.map((_, index) => `entry ${index + 1}`);
	for (let i = 0; i < runs.length; i++) {
		if (signal?.aborted) {
			await flushAfterAbort(outerBatchRequest, cwd);
			throw editAbortedPartway("entry", entryLabels.slice(0, i), entryLabels.slice(i), signal.reason);
		}
		const isLast = i === runs.length - 1;
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await runs[i](batchRequest);
			const details = result.details;
			if (details?.diff) diffTexts.push(details.diff);
			firstChangedLine ??= details?.firstChangedLine;
			if (details?.path) {
				metadataPath ??= details.path;
			}
			if (details && "oldText" in details && !hasFirstOldText) {
				firstOldText = details.oldText;
				hasFirstOldText = true;
			}
			if (details && "newText" in details) {
				lastNewText = details.newText;
				hasLastNewText = true;
			}
			if (details?.snapshotsPruned) snapshotsPruned = true;
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			if (isCancellation(err)) {
				await flushAfterAbort(outerBatchRequest, cwd);
				throw editAbortedPartway("entry", entryLabels.slice(0, i), entryLabels.slice(i), err);
			}
			const errorText = errorMessage(err);
			contentTexts.push(`Error editing ${path} (entry ${i + 1} of ${runs.length}): ${errorText}`);
			if (i > 0) {
				contentTexts.push(i === 1 ? `Entry 1 was already applied.` : `Entries 1-${i} were already applied.`);
			}
			if (i + 1 < runs.length) {
				contentTexts.push(
					(i + 2 === runs.length
						? `Entry ${runs.length} was NOT applied`
						: `Entries ${i + 2}-${runs.length} were NOT applied`) +
						`; re-read the file and re-issue only the failed and unapplied entries.`,
				);
			}
			hasError = true;
			if (outerBatchRequest?.flush) {
				await flushLspWritethroughBatch(outerBatchRequest.id, cwd, signal);
			}
			break;
		}

		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: diffTexts.join("\n"),
					firstChangedLine,
				},
				...(hasError ? { isError: true } : {}),
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: pruneOversizedEditSnapshots({
			diff: diffTexts.join("\n"),
			firstChangedLine,
			path: metadataPath ?? path,
			...(snapshotsPruned
				? { snapshotsPruned: true as const }
				: {
						...(hasFirstOldText ? { oldText: firstOldText } : {}),
						...(hasLastNewText ? { newText: lastNewText } : {}),
					}),
		}),
		...(hasError ? { isError: true } : {}),
	};
}

export function extractApprovalPath(args: unknown): string {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const input = typeof record.input === "string" ? record.input : undefined;
	if (input) {
		const hashlineMatch = /^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/m.exec(input);
		if (hashlineMatch?.[1]) return hashlineMatch[1];

		const applyPatchMatch = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m.exec(input);
		if (applyPatchMatch?.[1]) return applyPatchMatch[1].trim();
	}

	const targetPath = record.path;
	return typeof targetPath === "string" && targetPath.length > 0 ? targetPath : "(unknown)";
}

export function editFilesystemTargets(args: unknown): string[] {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const targets: string[] = [];
	if (typeof record.path === "string" && record.path.length > 0) targets.push(record.path);
	const input = typeof record.input === "string" ? record.input : undefined;
	if (input) {
		for (const match of input.matchAll(/^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/gm)) {
			if (match[1]) targets.push(match[1]);
		}
		for (const match of input.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
			if (match[1]) targets.push(match[1].trim());
		}
		for (const match of input.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) {
			if (match[1]) targets.push(match[1].trim());
		}
		for (const match of input.matchAll(new RegExp(String.raw`^\s*${HL_MOVE_KEYWORD}\s+(.+)$`, "gm"))) {
			if (match[1]) targets.push(match[1].trim());
		}
	}
	return targets;
}
