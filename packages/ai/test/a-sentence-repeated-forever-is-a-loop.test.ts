/**
 * A sentence-length verbatim repeat is a loop, and the guard has to see it.
 *
 * WHY THIS SUITE EXISTS. A real session streamed this, ~50 times, with no
 * newline between the repeats and no tool call to disarm anything:
 *
 *     Display :20 is free. I'll start Xvfb there, then launch aria-desktop against it.
 *
 * Nothing stopped it. The output-loop guard was already watching assistant text
 * (`model.loopGuard.checkAssistantContent` defaults to true) and its first
 * detector is "verbatim tail repetition", which is exactly this shape. It could
 * not fire, for two independent reasons that both had to be wrong:
 *
 *   1. The unit is 80 chars and `VERBATIM_MAX_UNIT` probed only up to 60, so the
 *      repeating unit was never a candidate at any point.
 *   2. `VERBATIM_TAIL_WINDOW` was 250, which holds 3 repeats of an 80-char unit
 *      where the detector requires 4 — so raising the cap alone would still have
 *      missed it.
 *
 * The only fallback was the near-duplicate SEGMENT path, which needs 8 segments
 * of up to 700 chars before it may fire: 5600 chars, about 70 repeats. The real
 * runaway was cut off at roughly 50, which is why the operator saw a loop the
 * product never once complained about.
 *
 * THE CLASS, not the incident. The bug was a length threshold, so a test pinning
 * the 80-char sentence would leave 81 through 120 open and re-close nothing. The
 * sweep below drives repeats at unit lengths across and past the old cap, and
 * asserts a BOUND on how much garbage may stream before the guard trips — a test
 * that only checks "eventually errored" cannot tell a 4-repeat trip from the
 * 70-repeat segment path that was technically always there.
 *
 * WHAT THIS SUITE DOES NOT CATCH. A repeat longer than the new cap
 * (`VERBATIM_MAX_UNIT`) still reaches only the slow segment path; the cap is a
 * number, not a proof, and the boundary case below pins where it now sits. It
 * also does not cover text AFTER a tool call in the same stream: the guard sets
 * `textArmed = false` on `toolcall_start` and never re-arms, which is a separate
 * hole with its own test below asserting the current behaviour honestly rather
 * than pretending it is covered.
 */
import { describe, expect, test } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { THINKING_LOOP_ERROR_MARKER, withGeminiThinkingLoopGuard } from "@veyyon/ai/utils/thinking-loop";

/** The exact sentence from the real runaway. 80 characters. */
const REAL_LOOP_UNIT = "Display :20 is free. I\u2019ll start Xvfb there, then launch aria-desktop against it.";

const model = {
	api: "openai-completions",
	provider: "deepseek",
	id: "deepseek-reasoner",
} as unknown as Model<Api>;

function billedPartial(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		usage: {
			input: 1200,
			output: 340,
			cacheRead: 0,
			cacheWrite: 800,
			totalTokens: 2340,
			cost: { input: 0.0036, output: 0.0017, cacheRead: 0, cacheWrite: 0.003, total: 0.0083 },
		},
		stopReason: "stop",
	} as unknown as AssistantMessage;
}

interface Run {
	readonly tripped: boolean;
	/** Characters of the runaway that reached the consumer before the guard cut it. */
	readonly streamedChars: number;
	readonly errorMessage: string | undefined;
	readonly errorId: string | undefined;
	readonly content: AssistantMessage["content"];
}

/**
 * Stream `unit` back to back `repeats` times as assistant text through the REAL
 * guard, one delta per repeat, and report what the consumer actually received.
 *
 * One delta per repeat is the honest shape: a provider emits the sentence over
 * several deltas, and the detector works off a rolling tail, so feeding it as
 * one giant string would let a whole runaway arrive in a single push and prove
 * less than nothing about when detection happens.
 */
async function streamRepeats(unit: string, repeats: number, opts?: { toolCallFirst?: boolean }): Promise<Run> {
	const partial = billedPartial();
	const guarded = withGeminiThinkingLoopGuard(model, { loopGuard: { checkAssistantContent: true } }, () => {
		const inner = new AssistantMessageEventStream();
		inner.push({ type: "start", partial });
		if (opts?.toolCallFirst) {
			inner.push({ type: "toolcall_start", contentIndex: 0, toolCallId: "call-1", toolName: "bash", partial });
		}
		inner.push({ type: "text_start", contentIndex: 1, partial });
		for (let i = 0; i < repeats; i++) {
			inner.push({ type: "text_delta", contentIndex: 1, delta: unit, partial });
		}
		inner.push({ type: "done", reason: "stop", message: partial });
		inner.end({ ...partial, stopReason: "stop" });
		return inner;
	});

	let streamedChars = 0;
	for await (const event of guarded) {
		if (event.type === "text_delta") streamedChars += event.delta.length;
	}
	const result = await guarded.result();
	return {
		tripped: result.stopReason === "error",
		streamedChars,
		errorMessage: result.errorMessage,
		errorId: result.errorId,
		content: result.content,
	};
}

/** Filler that never repeats a unit, for the negative controls. */
function distinctSentences(count: number, width: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		const body = `Step ${i} inspects module_${i}.ts and records finding ${i * 7} against budget ${i * 13}.`;
		out.push(body.padEnd(width, ".").slice(0, width));
	}
	return out;
}

describe("a sentence repeated forever is a loop", () => {
	/** The incident itself, byte for byte. */
	test("the real 80-char runaway trips the guard", async () => {
		const run = await streamRepeats(REAL_LOOP_UNIT, 40);

		expect(run.tripped).toBe(true);
		expect(run.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
		expect(AIError.is(run.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
		// The runaway is replay garbage: it must not be committed as content.
		expect(run.content).toEqual([]);
	});

	/**
	 * THE BOUND, which is the part that distinguishes a real fix from the segment
	 * path that was always technically present. The verbatim detector needs 4
	 * repeats, so the trip must land near 4 and nowhere near the 70 the segment
	 * warm-up required. Asserted as a hard ceiling on streamed characters.
	 */
	test("it trips within a few repeats, not after thousands of characters", async () => {
		const run = await streamRepeats(REAL_LOOP_UNIT, 40);

		expect(run.tripped).toBe(true);
		// 4 repeats to satisfy the detector, plus slack for the delta that carries
		// the hit. 5600 chars was the old segment-path warm-up; anything in that
		// range means the cheap detector is still blind and this is the slow path.
		expect(run.streamedChars).toBeLessThanOrEqual(REAL_LOOP_UNIT.length * 6);
		expect(run.streamedChars).toBeGreaterThan(0);
	});

	/**
	 * The class. A length threshold that is wrong at 80 is wrong across a range,
	 * so every unit length here must trip — including the ones that sit above the
	 * old cap of 60 and would each have been a fresh incident.
	 */
	test.each([12, 40, 59, 60, 61, 80, 99, 120])("a %i-char unit repeated is caught", async width => {
		const unit = `Retrying the ${width}-char probe against the display now, then launching. `
			.padEnd(width, "~")
			.slice(0, width);
		const run = await streamRepeats(unit, 40);

		expect({ width, tripped: run.tripped }).toEqual({ width, tripped: true });
	});

	/**
	 * The encoding arm. "Does this unit carry a letter or an emoji" is answered
	 * once per window by walking back from the end, and a code-unit walk reads an
	 * emoji as two lone surrogates that match no Unicode property — so a repeat
	 * whose only content is astral looks like punctuation and is skipped. Both
	 * ends of that judgement are pinned here: an astral unit above the OLD cap
	 * trips, and a unit that genuinely carries no letter at all does not, because
	 * repeated numeric or ruled output is legitimate and must stay legitimate.
	 */
	test("a repeat whose only content character is an emoji is caught", async () => {
		const unit = `${"[12:04:11] 0.0 ".padEnd(67, "-")}\u{1F30A} `;
		expect(unit).toHaveLength(70);
		const run = await streamRepeats(unit, 40);

		expect(run.tripped).toBe(true);
	});

	test("a repeat carrying no letter or emoji at all is left alone", async () => {
		const run = await streamRepeats("[12:04:11] 3.1415926 ---- 99.5% (2/3) ", 40);

		expect(run.tripped).toBe(false);
	});

	/**
	 * The negative control that matters most: raising a repetition threshold buys
	 * false positives if it is raised carelessly. Prose that never repeats a unit
	 * must stream through untouched at the same lengths the sweep above trips on.
	 */
	test.each([40, 80, 120])("distinct prose at %i chars per sentence is left alone", async width => {
		const partial = billedPartial();
		const sentences = distinctSentences(40, width);
		const guarded = withGeminiThinkingLoopGuard(model, { loopGuard: { checkAssistantContent: true } }, () => {
			const inner = new AssistantMessageEventStream();
			inner.push({ type: "start", partial });
			inner.push({ type: "text_start", contentIndex: 0, partial });
			for (const sentence of sentences) {
				inner.push({ type: "text_delta", contentIndex: 0, delta: sentence, partial });
			}
			inner.push({ type: "done", reason: "stop", message: partial });
			inner.end({ ...partial, stopReason: "stop" });
			return inner;
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of guarded) events.push(event);
		const result = await guarded.result();

		expect({ width, stopReason: result.stopReason }).toEqual({ width, stopReason: "stop" });
		expect(events.filter(event => event.type === "text_delta")).toHaveLength(sentences.length);
	});

	/**
	 * Honest coverage of the second hole rather than a claim it is closed. The
	 * guard disarms text detection on the first tool-call event and never re-arms,
	 * so the identical runaway after a tool call in the same stream is NOT caught.
	 * Pinned so the day someone re-arms it, this test fails and is updated on
	 * purpose instead of the behaviour changing unobserved.
	 */
	test("a runaway after a tool call in the same stream is currently NOT caught", async () => {
		const run = await streamRepeats(REAL_LOOP_UNIT, 40, { toolCallFirst: true });

		expect(run.tripped).toBe(false);
	});
});
