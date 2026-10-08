/**
 * WHY: Harmony leak detection exempts text inside a ```/~~~ code fence, because a reply that quotes a
 * leak (a bug report, a fixture, a document) is not a leak. The defect class is a fence boundary
 * computed wrong: a whitespace-only line taken for an opener, an opener form the scan misses, an
 * unclosed fence that stops exempting, a closed fence that keeps exempting, CRLF line ends that hide an
 * opener, or one trigger kind (a control token, or a marker with any one co-signal) that skips the
 * fence check. Every trigger is swept through every opener form, line ending and placement, on every
 * surface that trigger trips on. The co-signal table is typed over the signal union, so a new signal
 * class fails the type check until it has a trigger row here.
 *
 * Not caught: fence pairings no reply relies on, such as a ``` opener closed by ~~~, and the trigger
 * windows of each co-signal pattern beyond the one form each row uses.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolCall } from "@veyyon/ai";
import {
	detectHarmonyLeakInAssistantMessage,
	type HarmonySignalClass,
	type HarmonySurface,
} from "@veyyon/ai/utils/harmony-leak";

interface Trigger {
	/** The text that trips detection on its own. */
	text: string;
	/** The signal text the detection reports, located by its first occurrence. */
	signal: string;
	classes: HarmonySignalClass[];
	surfaces: HarmonySurface[];
}

const PROSE_SURFACES: HarmonySurface[] = ["assistant_text", "assistant_thinking"];

const CONTROL_TOKENS = ["start", "end", "channel", "message", "call", "return"] as const;

const CO_SIGNAL_TRIGGERS: Record<Exclude<HarmonySignalClass, "H" | "M">, Omit<Trigger, "classes" | "signal">> = {
	C: { text: "analysis to=functions.edit", surfaces: PROSE_SURFACES },
	G: { text: "to=functions.edit RTLU", surfaces: PROSE_SURFACES },
	S: { text: "pad pad pad pad to=functions.edit 中文", surfaces: PROSE_SURFACES },
	B: { text: "to=functions.edit code then to=functions.read", surfaces: PROSE_SURFACES },
	R: { text: "to=functions.edit\ncode_output\nCell 1:", surfaces: PROSE_SURFACES },
	// A tool argument trips only past its parse boundary; the resolver below puts it at 0.
	T: { text: "to=functions.edit", surfaces: ["tool_arg"] },
};

const TRIGGERS: Trigger[] = [
	...CONTROL_TOKENS.map(
		(name): Trigger => ({ text: `<|${name}|>`, signal: `<|${name}|>`, classes: ["H"], surfaces: PROSE_SURFACES }),
	),
	...Object.entries(CO_SIGNAL_TRIGGERS).map(
		([cls, trigger]): Trigger => ({
			...trigger,
			signal: "to=functions.edit",
			classes: ["M", cls as HarmonySignalClass],
		}),
	),
];

const OPENERS = ["```", "````", "```ts", "~~~", "~~~~ python", "   ```", "\t~~~"];
const NOT_FENCES = ["``", "~~", "text ```", "` ``"];
const SEPARATORS = ["\n", "\r\n"];
const PROSE = "Plain prose line.";
const QUOTED = "quoted line";
const BLANK = " \t";

/** The fence run of an opener without its indent or info string, which is the closer markdown expects. */
function closerFor(opener: string): string {
	return /[`~]+/.exec(opener)![0];
}

/** Each placement of `trigger` around one fence, and whether detection must report it there. */
function placements(trigger: string, opener: string): Array<{ name: string; lines: string[]; trips: boolean }> {
	const closer = closerFor(opener);
	return [
		{ name: "bare", lines: [PROSE, trigger, PROSE], trips: true },
		{ name: "inside a closed fence", lines: [PROSE, opener, trigger, closer, PROSE], trips: false },
		{ name: "inside an unclosed fence", lines: [PROSE, opener, trigger], trips: false },
		{
			name: "inside a fence after a blank line",
			lines: [PROSE, BLANK, opener, trigger, closer, PROSE],
			trips: false,
		},
		{
			name: "inside a second fence",
			lines: [opener, QUOTED, closer, PROSE, opener, trigger, closer],
			trips: false,
		},
		{ name: "before a fence", lines: [PROSE, trigger, opener, QUOTED, closer], trips: true },
		{ name: "after a fence closes", lines: [PROSE, opener, QUOTED, closer, trigger], trips: true },
		{
			name: "after a fence that follows a blank line",
			lines: [PROSE, BLANK, opener, QUOTED, closer, trigger],
			trips: true,
		},
	];
}

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** `text` on `surface` at content index 1, behind a clean block of the other kind. */
function messageCarrying(surface: HarmonySurface, text: string): AssistantMessage {
	if (surface === "assistant_text") {
		return message([
			{ type: "thinking", thinking: PROSE },
			{ type: "text", text },
		]);
	}
	if (surface === "assistant_thinking") {
		return message([
			{ type: "text", text: PROSE },
			{ type: "thinking", thinking: text },
		]);
	}
	const toolCall: ToolCall = { type: "toolCall", id: "call_fence", name: "edit", arguments: { input: text } };
	return message([{ type: "text", text: PROSE }, toolCall]);
}

const parsedAtStart = () => 0;

function expectVerdict(surface: HarmonySurface, text: string, trigger: Trigger, trips: boolean): void {
	const detection = detectHarmonyLeakInAssistantMessage(messageCarrying(surface, text), parsedAtStart);
	if (!trips) {
		expect(detection).toBeUndefined();
		return;
	}
	const start = text.indexOf(trigger.signal);
	expect(detection).toEqual({
		surface,
		contentIndex: 1,
		toolName: surface === "tool_arg" ? "edit" : undefined,
		toolCallId: surface === "tool_arg" ? "call_fence" : undefined,
		signals: [{ classes: trigger.classes, start, end: start + trigger.signal.length, text: trigger.signal }],
	});
}

describe("a harmony leak quoted in a code fence never trips detection", () => {
	for (const trigger of TRIGGERS) {
		for (const surface of trigger.surfaces) {
			const label = `${trigger.classes.join("+")} ${JSON.stringify(trigger.text)} on ${surface}`;

			it(`${label}: exempt inside every fence form, reported outside it`, () => {
				for (const separator of SEPARATORS) {
					for (const opener of OPENERS) {
						for (const placement of placements(trigger.text, opener)) {
							const text = placement.lines.join(separator);
							expectVerdict(surface, text, trigger, placement.trips);
						}
					}
				}
			});

			it(`${label}: a line that only resembles a fence exempts nothing`, () => {
				for (const separator of SEPARATORS) {
					for (const notFence of NOT_FENCES) {
						const text = [PROSE, notFence, trigger.text, notFence, PROSE].join(separator);
						expectVerdict(surface, text, trigger, true);
					}
				}
			});
		}
	}
});
