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
	/** Threshold of consecutive fully-subsumed / redundant read calls before steering (default 2). */
	readonly readSubsumptionThreshold?: number;
}

interface ReadTargetSpec {
	readonly basePath: string;
	readonly isRange: boolean;
	readonly startLine?: number;
	readonly endLine?: number;
}

interface FileReadHistory {
	snapshotTag?: string;
	hasFullVerbatim: boolean;
	hasSummary: boolean;
	ranges: Array<{ start: number; end: number }>;
}

const MUTATING_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
	ast_edit: true,
	patch: true,
};

function parseReadTarget(target: string): ReadTargetSpec {
	const trimmed = target.trim();
	const colonIdx = trimmed.indexOf(":");
	if (colonIdx === -1) {
		return { basePath: trimmed, isRange: false };
	}
	const basePath = trimmed.slice(0, colonIdx);
	const sel = trimmed.slice(colonIdx + 1).toLowerCase();
	if (sel === "raw" || sel === "conflicts" || sel.length === 0) {
		return { basePath, isRange: false };
	}
	const rangeMatch = sel.match(/^(\d+)(?:-(\d+))?/);
	if (rangeMatch) {
		const startLine = Number.parseInt(rangeMatch[1]!, 10);
		const endLine = rangeMatch[2] ? Number.parseInt(rangeMatch[2]!, 10) : startLine;
		return { basePath, isRange: true, startLine, endLine };
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
	if (history.hasSummary) return false;
	if (history.hasFullVerbatim) return true;
	if (target.isRange && target.startLine !== undefined && target.endLine !== undefined) {
		const start = target.startLine;
		const end = target.endLine;
		return history.ranges.some(r => r.start <= start && r.end >= end);
	}
	return false;
}

function extractSnapshotTag(text: string): string | undefined {
	const tagMatch = text.match(/\[[^\]#]+#([0-9A-Fa-f]{4})\]/);
	return tagMatch ? tagMatch[1] : undefined;
}

function resultIsStructuralSummary(text: string): boolean {
	return (
		text.includes("re-issue ONLY the ranges you need") ||
		text.includes("structural summary") ||
		text.includes("recovery selector")
	);
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
		this.#readSubsumptionThreshold = Math.max(1, Math.trunc(options.readSubsumptionThreshold ?? 2));
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

		if (this.#count >= this.#threshold) {
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
			const isSummary = resultIsStructuralSummary(resultText);
			const currentTag = extractSnapshotTag(resultText);
			// Are all requested targets already subsumed by earlier verbatim reads?
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
						hasFullVerbatim: false,
						hasSummary: isSummary,
						ranges: [],
					};
					this.#fileReadHistories.set(target.basePath, history);
				}
				if (currentTag) history.snapshotTag = currentTag;
				history.hasSummary = isSummary;
				if (!isSummary) {
					if (target.isRange && target.startLine !== undefined && target.endLine !== undefined) {
						history.ranges.push({ start: target.startLine, end: target.endLine });
					} else {
						history.hasFullVerbatim = true;
					}
				}
			}

			if (this.#subsumedReadCount >= this.#readSubsumptionThreshold) {
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
