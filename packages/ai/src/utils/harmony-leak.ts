import type { AssistantMessage, Model, ToolCall } from "../types";

const MARKER_RE = /\bto=functions\.[A-Za-z_]\w*/g;
const HARMONY_RE = /<\|(start|end|channel|message|call|return)\|>/g;

const CHANNEL_WORD_RE = /\b(?:analysis|commentary|assistant|user|system|developer|tool)\s+to=functions\./;

const GLITCH_RE = /\b(?:changedFiles|RTLU|Jsii(?:_commentary)?|\x4aapgolly)\b/;

const BODY_CASCADE_RE = /to=functions\.\w+\s+code\b[\s\S]{0,200}?to=functions\./;

const FAKE_RESULT_RE = /to=functions\.\w+[\s\S]{0,80}?code_output\s*\nCell\s+\d+:/;

const FENCE_RE = /^\s*(?:```+|~~~+)/;

const SCRIPT_CLASS =
	"\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u0400-\u04FF\u0E00-\u0E7F\u10A0-\u10FF\u0530-\u058F\u0C80-\u0CFF\u0C00-\u0C7F\u0900-\u097F\u0600-\u06FF\u0D00-\u0D7F";
const SCRIPT_RUN_RE = new RegExp(`[${SCRIPT_CLASS}]{2,}`, "u");

interface RecoveryConfig {
	sentinel: string;
	accepts: (input: string) => boolean;
}
const RECOVERY_REGISTRY: Record<string, RecoveryConfig> = {
	edit: {
		sentinel: "\n*** Abort\n",
		accepts: input => input.replace(/^\s+/, "").startsWith("@"),
	},
	eval: {
		sentinel: "\n*** Abort\n",
		accepts: () => true,
	},
};

const SIGNAL_ORDER = ["M", "C", "G", "S", "B", "R", "T"] as const;

export type HarmonySignalClass = "H" | (typeof SIGNAL_ORDER)[number];

export type HarmonySurface = "assistant_text" | "assistant_thinking" | "tool_arg";

export interface HarmonySignal {
	classes: HarmonySignalClass[];
	start: number;
	end: number;
	text: string;
}

export interface HarmonyDetection {
	surface: HarmonySurface;
	contentIndex?: number;
	toolName?: string;
	toolCallId?: string;
	signals: HarmonySignal[];
}

export interface HarmonyAuditEvent {
	action: "truncate_resume" | "abort_retry" | "escalated";
	surface: HarmonySurface;
	signal: string;
	retryN: number;
	model: string;
	provider: string;
	toolName?: string;
	removedLen: number;
	removedSha8: string;
	removedPreview: string;
	removedBlob?: string;
}

export interface HarmonyRecoveredToolCall {
	message: AssistantMessage;
	removed: string;
}

export function isHarmonyLeakMitigationTarget(model: Model): boolean {
	return model.provider === "openai-codex";
}

export function signalListLabel(signals: readonly HarmonySignal[]): string {
	const seen: string[] = [];
	for (const signal of signals) {
		const label = signal.classes.join("+");
		if (!seen.includes(label)) seen.push(label);
	}
	return seen.join(",") || "none";
}

export function detectHarmonyLeak(
	text: string,
	surface: HarmonySurface,
	options: {
		parsedEnd?: number;
		contentIndex?: number;
		toolName?: string;
		toolCallId?: string;
	} = {},
): HarmonyDetection | undefined {
	const fences = computeFenceRanges(text);
	const signals: HarmonySignal[] = [];

	for (const match of text.matchAll(HARMONY_RE)) {
		const start = match.index ?? 0;
		if (isInsideFence(fences, start)) continue;
		signals.push(makeSignal(["H"], start, start + match[0].length, match[0]));
	}

	for (const match of text.matchAll(MARKER_RE)) {
		const start = match.index ?? 0;
		if (isInsideFence(fences, start)) continue;
		const end = start + match[0].length;
		const classes: HarmonySignalClass[] = ["M"];

		const adjacent = text.slice(Math.max(0, start - 64), Math.min(text.length, end + 16));
		const near = text.slice(Math.max(0, start - 16), Math.min(text.length, end + 16));
		const forward = text.slice(start, Math.min(text.length, start + 240));

		if (CHANNEL_WORD_RE.test(adjacent)) classes.push("C");
		if (GLITCH_RE.test(near)) classes.push("G");
		if (hasScriptMismatchNear(text, start, end)) classes.push("S");
		if (BODY_CASCADE_RE.test(forward)) classes.push("B");
		if (FAKE_RESULT_RE.test(forward)) classes.push("R");
		if (options.parsedEnd !== undefined && start >= options.parsedEnd) classes.push("T");

		if (classes.length > 1) {
			signals.push(makeSignal(classes, start, end, match[0]));
		}
	}

	if (signals.length === 0) return undefined;
	if (surface === "tool_arg" && !signals.some(s => s.classes.includes("T"))) return undefined;
	signals.sort((a, b) => a.start - b.start || a.end - b.end);
	return {
		surface,
		contentIndex: options.contentIndex,
		toolName: options.toolName,
		toolCallId: options.toolCallId,
		signals,
	};
}

export function detectHarmonyLeakInAssistantMessage(
	message: AssistantMessage,
	toolArgParseEnd?: (toolCall: ToolCall) => number | undefined,
): HarmonyDetection | undefined {
	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];
		if (block.type === "text") {
			const d = detectHarmonyLeak(block.text, "assistant_text", { contentIndex: i });
			if (d) return d;
		} else if (block.type === "thinking") {
			const d = detectHarmonyLeak(block.thinking, "assistant_thinking", { contentIndex: i });
			if (d) return d;
		} else if (block.type === "toolCall") {
			const argText = getToolArgumentText(block);
			if (argText !== undefined) {
				const d = detectHarmonyLeak(argText, "tool_arg", {
					contentIndex: i,
					toolName: block.name,
					toolCallId: block.id,
					parsedEnd: toolArgParseEnd?.(block),
				});
				if (d) return d;
			}
		}
	}
	return undefined;
}

export function recoverHarmonyToolCall(
	message: AssistantMessage,
	detection: HarmonyDetection,
): HarmonyRecoveredToolCall | undefined {
	if (detection.surface !== "tool_arg" || detection.contentIndex === undefined) return undefined;
	const block = message.content[detection.contentIndex];
	if (block?.type !== "toolCall") return undefined;

	const config = RECOVERY_REGISTRY[block.name];
	if (!config) return undefined;

	const input = block.arguments?.input;
	if (typeof input !== "string") return undefined;
	if (!config.accepts(input)) return undefined;

	const offset = detection.signals[0]?.start;
	if (offset === undefined) return undefined;

	const truncated = truncateAtLineAndAppendSentinel(input, offset, config.sentinel);
	if (truncated === undefined) return undefined;

	const cleanToolCall: ToolCall = {
		...block,
		arguments: { ...block.arguments, input: truncated.clean },
	};
	const cleanMessage: AssistantMessage = {
		...message,
		content: [cleanToolCall],
		providerPayload: undefined,
		stopReason: "toolUse",
		errorMessage: undefined,
	};
	return { message: cleanMessage, removed: truncated.removed };
}

export function extractHarmonyRemoved(message: AssistantMessage, detection: HarmonyDetection): string {
	if (detection.contentIndex === undefined) return "";
	const block = message.content[detection.contentIndex];
	if (!block) return "";
	const start = detection.signals[0]?.start ?? 0;
	if (block.type === "text") return block.text.slice(start);
	if (block.type === "thinking") return block.thinking.slice(start);
	if (block.type === "toolCall") {
		const text = getToolArgumentText(block);
		return text ? text.slice(start) : "";
	}
	return "";
}

export function createHarmonyAuditEvent(params: {
	action: HarmonyAuditEvent["action"];
	detection: HarmonyDetection;
	model: Model;
	retryN: number;
	removed: string;
}): HarmonyAuditEvent {
	return {
		action: params.action,
		surface: params.detection.surface,
		signal: signalListLabel(params.detection.signals),
		retryN: params.retryN,
		model: params.model.id,
		provider: params.model.provider,
		toolName: params.detection.toolName,
		removedLen: params.removed.length,
		removedSha8: sha8(params.removed),
		removedPreview: redactedJunkPreview(params.removed),
		removedBlob: Bun.env.VEYYON_HARMONY_DEBUG === "1" ? params.removed : undefined,
	};
}

function makeSignal(classes: HarmonySignalClass[], start: number, end: number, text: string): HarmonySignal {
	if (classes[0] === "H") return { classes: ["H"], start, end, text };
	const sorted: HarmonySignalClass[] = [];
	for (const cls of SIGNAL_ORDER) {
		if (classes.includes(cls)) sorted.push(cls);
	}
	return { classes: sorted, start, end, text };
}

function computeFenceRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let inFence = false;
	let fenceStart = 0;
	let lineStart = 0;
	while (lineStart <= text.length) {
		const newline = text.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? text.length : newline;
		const line = text.slice(lineStart, lineEnd);
		if (FENCE_RE.test(line)) {
			if (inFence) {
				ranges.push([fenceStart, lineEnd]);
				inFence = false;
			} else {
				fenceStart = lineStart;
				inFence = true;
			}
		}
		if (newline === -1) break;
		lineStart = newline + 1;
	}
	if (inFence) ranges.push([fenceStart, text.length]);
	return ranges;
}

function isInsideFence(ranges: Array<[number, number]>, position: number): boolean {
	for (const [start, end] of ranges) {
		if (position >= start && position < end) return true;
		if (start > position) break;
	}
	return false;
}

function hasScriptMismatchNear(text: string, start: number, end: number): boolean {
	const near = text.slice(Math.max(0, start - 32), Math.min(text.length, end + 32));
	if (!SCRIPT_RUN_RE.test(near)) return false;
	const surrounding = text.slice(Math.max(0, start - 200), Math.min(text.length, end + 200));
	if (surrounding.length === 0) return false;
	let ascii = 0;
	for (let i = 0; i < surrounding.length; i++) {
		if (surrounding.charCodeAt(i) < 128) ascii++;
	}
	return ascii / surrounding.length >= 0.85;
}

function getToolArgumentText(toolCall: ToolCall): string | undefined {
	if (typeof toolCall.arguments?.input === "string") return toolCall.arguments.input;
	try {
		return JSON.stringify(toolCall.arguments);
	} catch {
		return undefined;
	}
}

function truncateAtLineAndAppendSentinel(
	input: string,
	offset: number,
	sentinel: string,
): { clean: string; removed: string } | undefined {
	const lineStart = offset <= 0 ? 0 : input.lastIndexOf("\n", offset - 1) + 1;
	if (lineStart === 0) return undefined; // would cut everything
	const head = input.slice(0, lineStart).replace(/\s+$/, "");
	if (head.length === 0) return undefined;
	return {
		clean: head + sentinel,
		removed: input.slice(lineStart),
	};
}

function sha8(text: string): string {
	return Bun.sha(text, "hex").slice(0, 8);
}

const PREVIEW_KEEP_RE = new RegExp(`[${SCRIPT_CLASS}\\s】【”“…」「、。]`, "u");
const PREVIEW_TOKEN_RE =
	/^(?:to=functions\.[A-Za-z_]\w*|analysis|commentary|assistant|user|system|developer|tool|changedFiles|RTLU|Jsii(?:_commentary)?|\x4aapgolly)/;

function redactedJunkPreview(text: string): string {
	const source = text.slice(0, 64);
	let out = "";
	for (let i = 0; i < source.length; ) {
		const tok = PREVIEW_TOKEN_RE.exec(source.slice(i));
		if (tok) {
			out += tok[0];
			i += tok[0].length;
			continue;
		}
		const ch = source[i] ?? "";
		out += PREVIEW_KEEP_RE.test(ch) ? ch : "·";
		i++;
	}
	return out;
}
