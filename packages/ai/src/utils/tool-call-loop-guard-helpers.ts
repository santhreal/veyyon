import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { setSafeProperty } from "@veyyon/utils/type-guards";
import { INTENT_FIELD } from "@veyyon/wire";
import type { AssistantMessage, ToolResultMessage } from "../types";

export const LEGACY_INTENT_FIELD = "__intent";
export const RESULT_SUMMARY_LIMIT = 200;
export const ARGUMENT_SUMMARY_LIMIT = 400;

export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
	readonly readSubsumptionThreshold?: number;
}

export interface ReadTargetSpec {
	readonly basePath: string;
	readonly isRange: boolean;
	readonly ranges?: readonly { readonly start: number; readonly end: number }[];
}

export interface FileReadHistory {
	snapshotTag?: string;
	hasSelectorFree: boolean;
	ranges: Array<{ start: number; end: number }>;
}

export const MUTATING_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
	ast_edit: true,
	patch: true,
};

export const RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;
export const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
export const URI_SCHEME_PREFIX_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export function parseRangeChunk(chunk: string): { startLine: number; endLine: number } | null {
	const trimmed = chunk.trim();
	const match = trimmed.match(RANGE_CHUNK_RE);
	if (!match) return null;
	const startLine = Number.parseInt(match[1]!, 10);
	if (startLine < 1) return null;
	const sep = match[2] === ".." ? "-" : match[2];
	const rhs = match[3] ? Number.parseInt(match[3], 10) : undefined;
	let endLine: number;
	if (sep === "+") {
		endLine = rhs !== undefined && rhs >= 1 ? startLine + rhs - 1 : startLine;
	} else if (sep === "-") {
		endLine = rhs !== undefined ? rhs : Number.POSITIVE_INFINITY;
	} else {
		endLine = startLine;
	}
	return { startLine, endLine };
}

export function parseRangeSelector(sel: string): { start: number; end: number }[] | null {
	const chunks = sel.split(",");
	if (chunks.length === 0) return null;
	const ranges: { start: number; end: number }[] = [];
	for (const chunk of chunks) {
		const parsed = parseRangeChunk(chunk);
		if (!parsed) return null;
		ranges.push({ start: parsed.startLine, end: parsed.endLine });
	}
	return ranges;
}

export function parseReadTarget(target: string): ReadTargetSpec {
	const trimmed = target.trim();
	if (trimmed.length === 0) {
		return { basePath: "", isRange: false };
	}

	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon <= 0) {
		return { basePath: trimmed, isRange: false };
	}

	if (lastColon === 1 && WINDOWS_DRIVE_RE.test(trimmed)) {
		return { basePath: trimmed, isRange: false };
	}
	if (URI_SCHEME_PREFIX_RE.test(trimmed) && trimmed.indexOf(":") === lastColon) {
		return { basePath: trimmed, isRange: false };
	}

	const outerCandidate = trimmed.slice(lastColon + 1);
	if (outerCandidate.length === 0) {
		return { basePath: trimmed.slice(0, lastColon), isRange: false };
	}

	const outerTrimmedLower = outerCandidate.trim().toLowerCase();
	const outerIsRaw = outerTrimmedLower === "raw";
	const outerIsConflicts = outerTrimmedLower === "conflicts";
	const outerRange = parseRangeSelector(outerCandidate);

	if (!outerIsRaw && !outerIsConflicts && !outerRange) {
		return { basePath: trimmed, isRange: false };
	}

	let basePath = trimmed.slice(0, lastColon);

	const innerColon = basePath.lastIndexOf(":");
	if (innerColon > 0) {
		const innerCandidate = basePath.slice(innerColon + 1);
		const innerIsRaw = innerCandidate.trim().toLowerCase() === "raw";
		const innerRange = parseRangeSelector(innerCandidate);

		if (innerIsRaw && outerRange) {
			basePath = basePath.slice(0, innerColon);
			return {
				basePath,
				isRange: true,
				ranges: outerRange,
			};
		}
		if (innerRange && outerIsRaw) {
			basePath = basePath.slice(0, innerColon);
			return {
				basePath,
				isRange: true,
				ranges: innerRange,
			};
		}
	}

	if (outerRange) {
		return {
			basePath,
			isRange: true,
			ranges: outerRange,
		};
	}

	return { basePath, isRange: false };
}

export function parseReadTargets(pathArg: unknown): ReadTargetSpec[] {
	if (typeof pathArg !== "string") return [];
	return pathArg
		.split(";")
		.map(t => parseReadTarget(t))
		.filter(t => t.basePath.length > 0);
}

export function isTargetSubsumed(target: ReadTargetSpec, history: FileReadHistory | undefined): boolean {
	if (!history) return false;
	if (target.isRange && target.ranges !== undefined && target.ranges.length > 0) {
		return target.ranges.every(tr => history.ranges.some(r => r.start <= tr.start && r.end >= tr.end));
	}
	return !target.isRange && history.hasSelectorFree;
}

export function extractSnapshotTag(text: string): string | undefined {
	const tagMatch = text.match(/\[[^\]#]+#([0-9A-Fa-f]{4})\]/);
	return tagMatch ? tagMatch[1] : undefined;
}

export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
}

export interface RepeatedToolCallDetection {
	readonly kind: "repeated_tool_call";
	readonly toolName: string;
	readonly count: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

export function canonicalizeToolCallValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => canonicalizeToolCallValue(item));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		setSafeProperty(output, key, canonicalizeToolCallValue(input[key]));
	}
	return output;
}

export function summarizeText(text: string, limit: number): string {
	let summary = collapseWhitespace(text);
	if (summary.length > limit) {
		summary = `${summary.slice(0, limit)}…`;
	}
	return summary;
}

export function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";

	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		}
	}
	return summarizeText(textParts.join("\n"), RESULT_SUMMARY_LIMIT);
}
