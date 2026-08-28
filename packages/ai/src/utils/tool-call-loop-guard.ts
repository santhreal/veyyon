import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { setSafeProperty } from "@veyyon/utils/type-guards";
import { INTENT_FIELD } from "@veyyon/wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
	/** Threshold of consecutive fully-subsumed / redundant read calls before steering (default 3). */
	readonly readSubsumptionThreshold?: number;
}

interface ReadTargetSpec {
	readonly basePath: string;
	readonly isRange: boolean;
	/**
	 * Every chunk of the selector, so `:5-16,960-973` is two ranges rather than
	 * one. Carrying only the first chunk judged the whole target subsumed on the
	 * strength of the first range alone, and recorded only that range in history.
	 */
	readonly ranges?: readonly { readonly start: number; readonly end: number }[];
}

interface FileReadHistory {
	snapshotTag?: string;
	hasSelectorFree: boolean;
	ranges: Array<{ start: number; end: number }>;
}

const MUTATING_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
	ast_edit: true,
	patch: true,
};

const RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const URI_SCHEME_PREFIX_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function parseRangeChunk(chunk: string): { startLine: number; endLine: number } | null {
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

function parseRangeSelector(sel: string): { start: number; end: number }[] | null {
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

function parseReadTarget(target: string): ReadTargetSpec {
	const trimmed = target.trim();
	if (trimmed.length === 0) {
		return { basePath: "", isRange: false };
	}

	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon <= 0) {
		return { basePath: trimmed, isRange: false };
	}

	// If the only colon is part of a Windows drive prefix (e.g. C:\path or C:/path)
	// or a URI scheme prefix with no other colon (e.g. skill://alpha), there is no selector.
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

	// Check for compound selector (e.g. `path:raw:2-4` or `path:2-4:raw`)
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

function parseReadTargets(pathArg: unknown): ReadTargetSpec[] {
	if (typeof pathArg !== "string") return [];
	return pathArg
		.split(";")
		.map(t => parseReadTarget(t))
		.filter(t => t.basePath.length > 0);
}

function isTargetSubsumed(target: ReadTargetSpec, history: FileReadHistory | undefined): boolean {
	if (!history) return false;
	if (target.isRange && target.ranges !== undefined && target.ranges.length > 0) {
		// Every chunk has to be covered. One uncovered chunk is new content, so the
		// read is not a repeat however well the rest of it was already read.
		return target.ranges.every(tr => history.ranges.some(r => r.start <= tr.start && r.end >= tr.end));
	}
	return !target.isRange && history.hasSelectorFree;
}

function extractSnapshotTag(text: string): string | undefined {
	const tagMatch = text.match(/\[[^\]#]+#([0-9A-Fa-f]{4})\]/);
	return tagMatch ? tagMatch[1] : undefined;
}

/** A completed assistant turn plus the tool results it produced. */
export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
}

/** Details needed to steer the model away from a repeated tool call. */
export interface RepeatedToolCallDetection {
	readonly kind: "repeated_tool_call";
	readonly toolName: string;
	readonly count: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

function canonicalizeToolCallValue(value: unknown): unknown {
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
		// A model-supplied `__proto__`/`constructor`/`prototype` key must land as an
		// own property, else a bare assignment would drop or prototype-mutate it and
		// distinct argument sets would collide into the same canonical hash (a false
		// repeated-tool-call detection).
		setSafeProperty(output, key, canonicalizeToolCallValue(input[key]));
	}
	return output;
}

function summarizeText(text: string, limit: number): string {
	let summary = collapseWhitespace(text);
	if (summary.length > limit) {
		summary = `${summary.slice(0, limit)}…`;
	}
	return summary;
}

function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
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

/** Detects consecutive identical assistant tool calls across model turns. */
export class ToolCallLoopGuard {
	#threshold: number;
	#readSubsumptionThreshold: number;
	#exemptTools: ReadonlySet<string>;
	#lastHash: string | undefined;
	#count = 0;
	#subsumedReadCount = 0;
	#fileReadHistories = new Map<string, FileReadHistory>();

	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		this.#readSubsumptionThreshold = Math.max(1, Math.trunc(options.readSubsumptionThreshold ?? 3));
		this.#exemptTools = new Set(options.exemptTools);
	}

	/** Records one completed turn and returns the threshold hit, if any. */
	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length !== 1 || this.#exemptTools.has(toolCalls[0]!.name)) {
			this.#lastHash = undefined;
			this.#count = 0;
			this.#subsumedReadCount = 0;
			return null;
		}

		const toolCall = toolCalls[0]!;

		if (
			MUTATING_TOOLS[toolCall.name] ||
			(toolCall.name === "bash" && typeof (toolCall.arguments as Record<string, unknown>)?.command === "string")
		) {
			this.#fileReadHistories.clear();
			this.#subsumedReadCount = 0;
		}

		// 1. Check verbatim identical tool-call argument hash
		const canonicalArgs = JSON.stringify(canonicalizeToolCallValue(toolCall.arguments));
		const hash = `${toolCall.name}:${canonicalArgs}`;
		if (hash === this.#lastHash) {
			this.#count++;
		} else {
			this.#lastHash = hash;
			this.#count = 1;
		}

		// Exactly the threshold turn, not every turn past it: the redirect is
		// steering, and a steer repeated on every subsequent call is noise the
		// model pays for on each request.
		if (this.#count === this.#threshold) {
			return {
				kind: "repeated_tool_call",
				toolName: toolCall.name,
				count: this.#count,
				resultSummary: summarizeToolResult(turn.toolResults, toolCall.id),
				argumentsSummary: summarizeText(canonicalArgs, ARGUMENT_SUMMARY_LIMIT),
			};
		}

		// 2. Check read tool subsumption / redundant read loops
		if (toolCall.name === "read") {
			const targets = parseReadTargets((toolCall.arguments as Record<string, unknown>)?.path);
			const resultText = summarizeToolResult(turn.toolResults, toolCall.id);
			const currentTag = extractSnapshotTag(resultText);
			// Are all requested targets already subsumed by earlier reads?
			const allSubsumed =
				targets.length > 0 &&
				targets.every(t => {
					const history = this.#fileReadHistories.get(t.basePath);
					return isTargetSubsumed(t, history);
				});

			if (allSubsumed) {
				this.#subsumedReadCount++;
			} else {
				this.#subsumedReadCount = 0;
			}

			// Update read history for each target
			for (const target of targets) {
				let history = this.#fileReadHistories.get(target.basePath);
				if (!history || (currentTag && history.snapshotTag && currentTag !== history.snapshotTag)) {
					history = {
						snapshotTag: currentTag,
						hasSelectorFree: false,
						ranges: [],
					};
					this.#fileReadHistories.set(target.basePath, history);
				}
				if (currentTag) history.snapshotTag = currentTag;
				if (target.isRange && target.ranges !== undefined) {
					history.ranges.push(...target.ranges);
				} else if (!target.isRange) {
					history.hasSelectorFree = true;
				}
			}
			if (this.#subsumedReadCount === this.#readSubsumptionThreshold) {
				return {
					kind: "repeated_tool_call",
					toolName: "read",
					count: this.#subsumedReadCount,
					resultSummary: "Requested lines are already present in previous turn context",
					argumentsSummary: summarizeText(canonicalArgs, ARGUMENT_SUMMARY_LIMIT),
				};
			}
		} else {
			this.#subsumedReadCount = 0;
		}

		return null;
	}
}
