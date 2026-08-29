import type { ToolCall } from "../types";
import type {
	FileReadHistory,
	RepeatedToolCallDetection,
	ToolCallLoopGuardOptions,
	ToolCallLoopTurn,
} from "./tool-call-loop-guard-helpers";
import {
	ARGUMENT_SUMMARY_LIMIT,
	canonicalizeToolCallValue,
	extractSnapshotTag,
	isTargetSubsumed,
	MUTATING_TOOLS,
	parseReadTargets,
	summarizeText,
	summarizeToolResult,
} from "./tool-call-loop-guard-helpers";

export type { RepeatedToolCallDetection, ToolCallLoopTurn };

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

		const canonicalArgs = JSON.stringify(canonicalizeToolCallValue(toolCall.arguments));
		const hash = `${toolCall.name}:${canonicalArgs}`;
		if (hash === this.#lastHash) {
			this.#count++;
		} else {
			this.#lastHash = hash;
			this.#count = 1;
		}

		if (this.#count === this.#threshold) {
			return {
				kind: "repeated_tool_call",
				toolName: toolCall.name,
				count: this.#count,
				resultSummary: summarizeToolResult(turn.toolResults, toolCall.id),
				argumentsSummary: summarizeText(canonicalArgs, ARGUMENT_SUMMARY_LIMIT),
			};
		}

		if (toolCall.name === "read") {
			const targets = parseReadTargets((toolCall.arguments as Record<string, unknown>)?.path);
			const resultText = summarizeToolResult(turn.toolResults, toolCall.id);
			const currentTag = extractSnapshotTag(resultText);
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
