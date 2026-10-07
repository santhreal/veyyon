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

interface LineRange {
	start: number;
	end: number;
}

interface ReadTargetSpec {
	readonly basePath: string;
	readonly isRange: boolean;
	/**
	 * Every chunk of the selector, so `:5-16,960-973` is two ranges rather than
	 * one. Carrying only the first chunk judged the whole target subsumed on the
	 * strength of the first range alone, and recorded only that range in history.
	 */
	readonly ranges?: readonly Readonly<LineRange>[];
}

interface FileReadHistory {
	snapshotTag?: string;
	hasSelectorFree: boolean;
	ranges: LineRange[];
}

const MUTATING_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
	ast_edit: true,
	patch: true,
};

const RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;

function parseRangeChunk(chunk: string): LineRange | null {
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
	return { start: startLine, end: endLine };
}

function parseRangeSelector(sel: string): LineRange[] | null {
	const ranges: LineRange[] = [];
	for (const chunk of sel.split(",")) {
		const range = parseRangeChunk(chunk);
		if (!range) return null;
		ranges.push(range);
	}
	return ranges;
}

/**
 * The target of a compound selector, `path:raw:2-4` or `path:2-4:raw`, where
 * `basePath` still ends in the inner selector; null when the inner and outer
 * selectors do not pair as `raw` plus a range.
 */
function compoundSelectorTarget(
	basePath: string,
	outerIsRaw: boolean,
	outerRange: LineRange[] | null,
): ReadTargetSpec | null {
	const innerColon = basePath.lastIndexOf(":");
	if (innerColon <= 0) return null;
	const inner = basePath.slice(innerColon + 1);
	let ranges: LineRange[] | null = null;
	if (outerRange) {
		if (inner.trim().toLowerCase() === "raw") ranges = outerRange;
	} else if (outerIsRaw) {
		ranges = parseRangeSelector(inner);
	}
	return ranges ? { basePath: basePath.slice(0, innerColon), isRange: true, ranges } : null;
}

function parseReadTarget(target: string): ReadTargetSpec {
	const trimmed = target.trim();
	// A Windows drive colon (`C:\path`) or URI scheme colon (`skill://alpha`) is followed by a
	// separator, which no selector starts with, so such a path keeps that colon below.
	const colon = trimmed.lastIndexOf(":");
	if (colon <= 0) return { basePath: trimmed, isRange: false };

	const outer = trimmed.slice(colon + 1);
	if (outer.length === 0) return { basePath: trimmed.slice(0, colon), isRange: false };

	const outerMode = outer.trim().toLowerCase();
	const outerIsRaw = outerMode === "raw";
	const outerRange = parseRangeSelector(outer);
	// Not a selector this tool reads, so the colon is part of the path.
	if (!outerIsRaw && outerMode !== "conflicts" && !outerRange) return { basePath: trimmed, isRange: false };

	const basePath = trimmed.slice(0, colon);
	const compound = compoundSelectorTarget(basePath, outerIsRaw, outerRange);
	if (compound) return compound;
	return outerRange ? { basePath, isRange: true, ranges: outerRange } : { basePath, isRange: false };
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

/** The message's only tool call, or undefined when it made none or several. */
function soleToolCall(message: AssistantMessage): ToolCall | undefined {
	let found: ToolCall | undefined;
	for (const part of message.content) {
		if (part.type !== "toolCall") continue;
		if (found) return undefined;
		found = part;
	}
	return found;
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
		const toolCall = soleToolCall(turn.message);
		if (!toolCall || this.#exemptTools.has(toolCall.name)) {
			this.#lastHash = undefined;
			this.#count = 0;
			this.#subsumedReadCount = 0;
			return null;
		}

		if (
			MUTATING_TOOLS[toolCall.name] ||
			(toolCall.name === "bash" && typeof toolCall.arguments?.command === "string")
		) {
			this.#fileReadHistories.clear();
			this.#subsumedReadCount = 0;
		}

		// 1. Check verbatim identical tool-call argument hash
		const canonicalArgs = JSON.stringify(canonicalizeToolCallValue(toolCall.arguments));
		const hash = `${toolCall.name}:${canonicalArgs}`;
		this.#count = hash === this.#lastHash ? this.#count + 1 : 1;
		this.#lastHash = hash;

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
		if (toolCall.name !== "read") {
			this.#subsumedReadCount = 0;
			return null;
		}
		return this.#recordRead(toolCall, turn.toolResults, canonicalArgs);
	}

	/** Counts a read whose every target earlier reads already cover, then records its targets. */
	#recordRead(
		toolCall: ToolCall,
		toolResults: readonly ToolResultMessage[],
		canonicalArgs: string,
	): RepeatedToolCallDetection | null {
		const targets = parseReadTargets(toolCall.arguments?.path);
		const currentTag = extractSnapshotTag(summarizeToolResult(toolResults, toolCall.id));
		const allSubsumed =
			targets.length > 0 && targets.every(t => isTargetSubsumed(t, this.#fileReadHistories.get(t.basePath)));
		this.#subsumedReadCount = allSubsumed ? this.#subsumedReadCount + 1 : 0;
		for (const target of targets) this.#recordReadTarget(target, currentTag);
		if (this.#subsumedReadCount !== this.#readSubsumptionThreshold) return null;
		return {
			kind: "repeated_tool_call",
			toolName: "read",
			count: this.#subsumedReadCount,
			resultSummary: "Requested lines are already present in previous turn context",
			argumentsSummary: summarizeText(canonicalArgs, ARGUMENT_SUMMARY_LIMIT),
		};
	}

	/** Adds `target` to its file's read history, starting the history over when the file's snapshot tag changed. */
	#recordReadTarget(target: ReadTargetSpec, currentTag: string | undefined): void {
		let history = this.#fileReadHistories.get(target.basePath);
		if (!history || (currentTag && history.snapshotTag && currentTag !== history.snapshotTag)) {
			history = { snapshotTag: currentTag, hasSelectorFree: false, ranges: [] };
			this.#fileReadHistories.set(target.basePath, history);
		}
		if (currentTag) history.snapshotTag = currentTag;
		if (!target.isRange) history.hasSelectorFree = true;
		else if (target.ranges !== undefined) history.ranges.push(...target.ranges);
	}
}
