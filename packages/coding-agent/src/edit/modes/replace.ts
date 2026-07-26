/**
 * Fuzzy matching utilities for the edit tool.
 *
 * Provides both character-level and line-level fuzzy matching with progressive
 * fallback strategies for finding text in files.
 */
import type { AgentToolResult } from "@veyyon/agent-core";
import { levenshteinDistance } from "@veyyon/utils";
import { type } from "arktype";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { routeWriteThroughBridge } from "../../tools/acp-bridge";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { outputMeta } from "../../tools/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/plan-mode-guard";
import { generateDiffString, replaceText } from "../diff";
import { DEFAULT_FUZZY_THRESHOLD, EditMatchError, findMatch, formatOccurrenceError } from "../match";
import {
	countLeadingWhitespace,
	detectLineEnding,
	normalizeForFuzzy,
	normalizeToLF,
	normalizeUnicode,
	restoreLineEndings,
} from "../normalize";
import { readEditFileTextWithBom, serializeEditFileText } from "../read-file";
import type { EditToolDetails, LspBatchRequest } from "../renderer";
import { pruneOversizedEditSnapshots } from "../snapshot-details";

export const replaceEditEntrySchema = type({
	old_text: "string",
	new_text: "string",
	"all?": "boolean",
});

export const replaceEditSchema = type({
	path: "string",
	edits: replaceEditEntrySchema.array(),
});

export type ReplaceEditEntry = typeof replaceEditEntrySchema.infer;
export type ReplaceParams = typeof replaceEditSchema.infer;

export interface ExecuteReplaceSingleOptions {
	session: ToolSession;
	path: string;
	params: ReplaceEditEntry;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	allowFuzzy: boolean;
	fuzzyThreshold: number;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

export async function executeReplaceSingle(
	options: ExecuteReplaceSingleOptions,
): Promise<AgentToolResult<EditToolDetails, ReplaceEditEntry>> {
	const {
		session,
		path,
		params,
		signal,
		batchRequest,
		allowFuzzy,
		fuzzyThreshold,
		writethrough,
		beginDeferredDiagnosticsForPath,
	} = options;
	const { old_text, new_text, all } = params;

	enforcePlanModeWrite(session, path);

	if (old_text.length === 0) {
		throw new Error("old_text must not be empty.");
	}

	const absolutePath = resolvePlanPath(session, path);
	// Recover the BOM from raw bytes: the text reader drops a leading UTF-8 BOM,
	// so a plain read + stripBom would rewrite the file without it (regression:
	// "should preserve UTF-8 BOM after edit").
	const { bom, content } = await readEditFileTextWithBom(absolutePath, path);
	const originalEnding = detectLineEnding(content);
	const normalizedContent = normalizeToLF(content);
	const normalizedOldText = normalizeToLF(old_text);
	const normalizedNewText = normalizeToLF(new_text);

	const result = replaceText(normalizedContent, normalizedOldText, normalizedNewText, {
		fuzzy: allowFuzzy,
		all: all ?? false,
		threshold: fuzzyThreshold,
	});

	if (result.count === 0) {
		const matchOutcome = findMatch(normalizedContent, normalizedOldText, {
			allowFuzzy,
			threshold: fuzzyThreshold,
		});

		if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
			throw new Error(formatOccurrenceError(path, matchOutcome));
		}

		throw new EditMatchError(path, normalizedOldText, matchOutcome.closest, {
			allowFuzzy,
			threshold: fuzzyThreshold,
			fuzzyMatches: matchOutcome.fuzzyMatches,
		});
	}

	if (normalizedContent === result.content) {
		throw new Error(`Edits to ${path} resulted in no changes being made.`);
	}

	const finalContent = await serializeEditFileText(
		absolutePath,
		path,
		bom + restoreLineEndings(result.content, originalEnding),
	);

	// Route through ACP bridge when available; skips internal artifacts.
	let diagnostics: FileDiagnosticsResult | undefined;
	if (await routeWriteThroughBridge(session, path, absolutePath, finalContent, signal)) {
		// bridge handled the write; diagnostics not available via writethrough
	} else {
		diagnostics = await writethrough(absolutePath, finalContent, signal, Bun.file(absolutePath), batchRequest, dst =>
			dst === absolutePath ? beginDeferredDiagnosticsForPath(absolutePath) : undefined,
		);
		invalidateFsScanAfterWrite(absolutePath);
	}

	const diffResult = generateDiffString(normalizedContent, result.content, undefined, { path });
	const resultText =
		result.count > 1
			? `Successfully replaced ${result.count} occurrences in ${path}.`
			: `Successfully replaced text in ${path}.`;

	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();

	return {
		content: [{ type: "text", text: resultText }],
		details: pruneOversizedEditSnapshots({
			diff: diffResult.diff,
			path: absolutePath,
			firstChangedLine: diffResult.firstChangedLine,
			diagnostics,
			meta,
			oldText: content,
			newText: finalContent,
		}),
	};
}
