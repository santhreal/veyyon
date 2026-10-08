/**
 * WHY: a harmony leak is removed from its first signal onward: the audit text starts there, and a
 * recovered tool call keeps only the lines before it. Detection collects control tokens and markers
 * in separate passes, so a detection whose signals are not ordered by position cuts from a later
 * signal and leaves the earlier leak in the text the model and the tool receive. Every pair of signal
 * kinds is swept in both orders on every surface; the signals must come back ordered by position and
 * the cut must start at the earlier one.
 *
 * Not caught: three or more interleaved signals beyond the pairs below, and the order of two signals
 * that start at the same offset, which no pair of distinct triggers can produce.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolCall } from "@veyyon/ai";
import {
	detectHarmonyLeakInAssistantMessage,
	extractHarmonyRemoved,
	type HarmonySurface,
	recoverHarmonyToolCall,
} from "@veyyon/ai/utils/harmony-leak";

/** A trigger and the signal text the detection reports for it. */
interface Signal {
	text: string;
	signal: string;
}

const CONTROL: Signal = { text: "<|channel|>", signal: "<|channel|>" };
const CHANNEL_MARKER: Signal = { text: "analysis to=functions.edit", signal: "to=functions.edit" };
const GLITCH_MARKER: Signal = { text: "to=functions.read RTLU", signal: "to=functions.read" };
// On a tool argument every marker past the parse boundary carries `T`; a control token alone never trips.
const TRAILING_MARKER: Signal = { text: "to=functions.eval", signal: "to=functions.eval" };

const PAIRS: Record<HarmonySurface, Array<[Signal, Signal]>> = {
	assistant_text: [
		[CONTROL, CHANNEL_MARKER],
		[CHANNEL_MARKER, CONTROL],
		[CHANNEL_MARKER, GLITCH_MARKER],
		[GLITCH_MARKER, CHANNEL_MARKER],
	],
	assistant_thinking: [
		[CONTROL, CHANNEL_MARKER],
		[CHANNEL_MARKER, CONTROL],
		[CHANNEL_MARKER, GLITCH_MARKER],
		[GLITCH_MARKER, CHANNEL_MARKER],
	],
	tool_arg: [
		[CONTROL, TRAILING_MARKER],
		[TRAILING_MARKER, CONTROL],
		[TRAILING_MARKER, GLITCH_MARKER],
		[GLITCH_MARKER, TRAILING_MARKER],
	],
};

const HEAD = "@src/app.ts\nfirst kept line";

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

function messageCarrying(surface: HarmonySurface, text: string): AssistantMessage {
	if (surface === "assistant_text") return message([{ type: "text", text }]);
	if (surface === "assistant_thinking") return message([{ type: "thinking", thinking: text }]);
	const toolCall: ToolCall = { type: "toolCall", id: "call_cut", name: "edit", arguments: { input: text } };
	return message([toolCall]);
}

describe("a harmony leak is cut from its earliest signal", () => {
	for (const [surface, pairs] of Object.entries(PAIRS) as Array<[HarmonySurface, Array<[Signal, Signal]>]>) {
		for (const [first, second] of pairs) {
			it(`${first.text} then ${second.text} on ${surface}`, () => {
				const text = `${HEAD}\n${first.text}\nmiddle line\n${second.text}\ntrailing line`;
				const firstStart = text.indexOf(first.signal);
				const secondStart = text.indexOf(second.signal, firstStart + first.signal.length);
				const leaking = messageCarrying(surface, text);

				const detection = detectHarmonyLeakInAssistantMessage(leaking, () => 0);
				expect(detection?.signals.map(s => s.start)).toEqual([firstStart, secondStart]);
				expect(extractHarmonyRemoved(leaking, detection!)).toBe(text.slice(firstStart));

				if (surface !== "tool_arg") return;
				const firstLineStart = text.lastIndexOf("\n", firstStart) + 1;
				const recovered = recoverHarmonyToolCall(leaking, detection!);
				expect(recovered?.removed).toBe(text.slice(firstLineStart));
				expect(recovered?.message.content).toEqual([
					{ type: "toolCall", id: "call_cut", name: "edit", arguments: { input: `${HEAD}\n*** Abort\n` } },
				]);
			});
		}
	}
});
