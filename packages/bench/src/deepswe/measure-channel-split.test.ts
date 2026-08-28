/**
 * The instrument behind `DEFAULT_TOOL_CALL_STRUCTURE_SHARE`.
 *
 * WHY THIS SUITE EXISTS. `measure-channel-split.ts` produces one number, and that
 * number decides whether argot's structure handles pay at all: at a share of 1 a
 * tab-indented repository earns five structure handles, at a share of 0 it earns
 * none. A miscount here does not fail anything, it just moves the constant, and a
 * dictionary generated from a wrong constant looks entirely ordinary.
 *
 * So the classification is pinned part by part rather than end to end. Each test
 * drives the real reader in `transcript-corpus.ts` and the real folding here, over
 * the exact event shapes a veyyon transcript holds, and asserts real occurrence
 * counts rather than that something was found.
 * The negative cases matter as much as the positive ones: counting a tool RESULT
 * would credit argot for text no handle can shorten, and counting a user turn
 * would measure the human.
 */

import { describe, expect, test } from "bun:test";
import { applyCounts, emptySplit, finalizeSplit, foldEmission, measureEvents } from "./measure-channel-split";
import { emissionsOf, emptyCounts } from "./transcript-corpus";

/** An assistant turn carrying the given content parts. */
function assistantTurn(content: unknown[]): unknown {
	return { type: "message", message: { role: "assistant", content } };
}

describe("classifying what an assistant emitted", () => {
	test("structure inside a tool-call argument lands in the tool-call channel", () => {
		// The channel `emittedTokenCost` was built for. Three newline-plus-indent
		// runs go in, three come out on the escaped side and none on the raw side.
		const split = measureEvents([
			assistantTurn([{ type: "toolCall", name: "edit", arguments: { content: "a\n\tb\n\t\tc\n" } }]),
		]);

		expect(split.toolCallArguments.occurrences).toBe(3);
		expect(split.plainMessage.occurrences).toBe(0);
		expect(split.shareInToolCallArguments).toBe(1);
	});

	test("structure in message text lands in the plain-message channel", () => {
		// The channel that had never been counted, and the reason the share is not 1.
		const split = measureEvents([assistantTurn([{ type: "text", text: "here:\n\tconst a = 1;\n" }])]);

		expect(split.plainMessage.occurrences).toBe(2);
		expect(split.toolCallArguments.occurrences).toBe(0);
		expect(split.shareInToolCallArguments).toBe(0);
	});

	test("thinking counts as plain message, because it is billed output", () => {
		// Thinking is the majority of what a real agent emits outside tool calls
		// (18,980 parts against 811 text parts in the measured corpus), and it is
		// charged at output rates. Skipping it would push the share toward 1 and
		// quietly restore the assumption the instrument exists to test.
		const split = measureEvents([assistantTurn([{ type: "thinking", thinking: "plan:\n\t- read\n\t- write\n" }])]);

		expect(split.plainMessage.occurrences).toBe(3);
		expect(split.thinkingParts).toBe(1);
		expect(split.shareInToolCallArguments).toBe(0);
	});

	test("nested and array-valued tool arguments are walked, not just top-level strings", () => {
		// A tool that takes a list of edits keeps its newlines one level down. Reading
		// only the top level would drop exactly the largest arguments an agent sends.
		const split = measureEvents([
			assistantTurn([
				{
					type: "toolCall",
					name: "multiEdit",
					arguments: { edits: [{ new: "x\n\ty\n" }, { new: "p\n\t\tq\n" }], dryRun: false },
				},
			]),
		]);

		expect(split.toolCallArguments.occurrences).toBe(4);
	});
});

describe("what must not be counted", () => {
	test("a tool result is input, not output", () => {
		// The whole file a `read` returns is structure the model never emitted and
		// never pays for. Counting it would swamp the measurement: tool results are
		// the largest text in any transcript.
		const split = measureEvents([
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "a\n\tb\n\t\tc\n" }] } },
		]);

		expect(split.toolCallArguments.occurrences).toBe(0);
		expect(split.plainMessage.occurrences).toBe(0);
		expect(split.assistantMessages).toBe(0);
	});

	test("a user turn is not the agent", () => {
		const split = measureEvents([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "fix:\n\tthis\n" }] } },
		]);

		expect(split.plainMessage.occurrences).toBe(0);
	});

	test("non-message events are ignored rather than misread", () => {
		// A transcript is mostly not messages: titles, settings snapshots, model
		// changes. They carry text with newlines and none of it is model output.
		const split = measureEvents([
			{ type: "title", title: "a\n\tb" },
			{ type: "settings_snapshot", settings: { instructions: "x\n\t\ty" } },
			{ type: "session", cwd: "/tmp/a\n\tb" },
		]);

		expect(split.plainMessage.occurrences).toBe(0);
		expect(split.toolCallArguments.occurrences).toBe(0);
	});

	test("malformed events do not throw", () => {
		// Transcripts are appended to live and a killed process leaves partial
		// records. The instrument has to survive them, since refusing to run is how a
		// measurement gets skipped instead of fixed.
		const split = measureEvents([null, 42, "message", { type: "message" }, { type: "message", message: null }]);

		expect(split.assistantMessages).toBe(0);
	});
});

describe("the share the constant is taken from", () => {
	test("is the ratio of occurrences, and it sits between the two channels", () => {
		// Three runs in a tool call and one in text is 75%, computed rather than
		// eyeballed. Getting this arithmetic backwards would invert the constant and
		// therefore the sign of every structure handle's value.
		const split = measureEvents([
			assistantTurn([{ type: "toolCall", name: "write", arguments: { content: "a\n\tb\n\t\tc\n" } }]),
			assistantTurn([{ type: "text", text: "done\n" }]),
		]);

		expect(split.toolCallArguments.occurrences).toBe(3);
		expect(split.plainMessage.occurrences).toBe(1);
		expect(split.shareInToolCallArguments).toBe(0.75);
	});

	test("an empty corpus reports zero rather than a divide-by-zero", () => {
		// A share of NaN would propagate into the constant and every price with it.
		// Zero is also honest here: nothing was emitted into either channel.
		const split = measureEvents([]);

		expect(split.shareInToolCallArguments).toBe(0);
		expect(split.tokenShareInToolCallArguments).toBe(0);
		expect(split.assistantMessages).toBe(0);
	});

	test("the escaped total exceeds the raw total, which is the whole reason the split matters", () => {
		// If these two were equal the channel would not matter and the constant would
		// be pointless. The gap is what the mix interpolates across.
		const split = measureEvents([
			assistantTurn([{ type: "toolCall", name: "write", arguments: { content: "a\n\t\t\t\tb\n" } }]),
		]);

		expect(split.toolCallArguments.escapedTokens).toBeGreaterThan(split.toolCallArguments.rawTokens);
	});

	test("folding accumulates across turns instead of overwriting", () => {
		// The real corpus is 23,467 turns folded into one split. A fold that reset per
		// turn would report the last transcript's share as the whole corpus's.
		const split = emptySplit();
		const counts = emptyCounts();
		for (const turn of [
			assistantTurn([{ type: "toolCall", name: "w", arguments: { c: "a\n\tb" } }]),
			assistantTurn([{ type: "toolCall", name: "w", arguments: { c: "a\n\tb" } }]),
		]) {
			for (const emission of emissionsOf(turn, counts)) foldEmission(split, emission);
		}
		applyCounts(split, counts);
		finalizeSplit(split);

		expect(split.toolCallArguments.occurrences).toBe(2);
		expect(split.assistantMessages).toBe(2);
	});
});
