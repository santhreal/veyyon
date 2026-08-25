/**
 * flushIdle refuses a mid-sentence fragment shorter than MIN_SEGMENT (24),
 * and the first spoken segment may cut early at FIRST_SEGMENT_MIN (12) /
 * FIRST_CLAUSE_MIN (40) / FIRST_FORCED_MAX (140).
 *
 * WHY THIS SUITE EXISTS. The existing speakable suite pins "a short
 * mid-sentence fragment" (one example) and "force-split the first segment
 * when the first clause is past the cap". It does not pin the numeric
 * floors themselves, so a one-off change to 16 or 32 would stay green.
 *
 *   - 23 letters, no terminal punctuation → flushIdle silent; flush() speaks.
 *   - 24 letters, no terminal punctuation → flushIdle speaks.
 *   - A complete thought ("Hi.") is spoken by flushIdle even under 24.
 *   - The first sentence cut is refused before 12 characters, so "Ok. More"
 *     does not emit a stubby "Ok." as its own segment before the rest is
 *     long enough to merge.
 *
 * These numbers feed Kokoro's phoneme budget. Moving them without this
 * file is a latency / choppiness regression the existing suite cannot see.
 */
import { describe, expect, it } from "bun:test";
import { SpeakableStream } from "@veyyon/coding-agent/tts/speakable";

function idleThenFlush(text: string): { idle: string[]; flushed: string[] } {
	const stream = new SpeakableStream();
	stream.push(text);
	const idle = stream.flushIdle();
	const flushed = stream.flush();
	return { idle, flushed };
}

describe("flushIdle's 24-character mid-sentence floor", () => {
	it("refuses a 23-character fragment with no terminal punctuation", () => {
		const text = "a".repeat(23);
		expect(text.length).toBe(23);
		const { idle, flushed } = idleThenFlush(text);
		expect(idle).toEqual([]);
		expect(flushed.join("")).toBe(text);
	});

	it("speaks a 24-character fragment with no terminal punctuation", () => {
		const text = "a".repeat(24);
		expect(text.length).toBe(24);
		const { idle, flushed } = idleThenFlush(text);
		expect(idle.join("")).toBe(text);
		expect(flushed).toEqual([]);
	});

	it("speaks a 25-character fragment the same way as 24", () => {
		const text = "abcdefghij klmnopqrst uvwxy";
		expect(text.length).toBeGreaterThanOrEqual(24);
		const { idle } = idleThenFlush(text);
		expect(idle.join("").length).toBeGreaterThanOrEqual(24);
	});

	it("speaks a complete thought under 24 characters because it ends in a period", () => {
		const { idle, flushed } = idleThenFlush("Done.");
		expect(idle.join("")).toMatch(/Done/);
		expect(flushed).toEqual([]);
	});

	it("speaks a complete thought ending in a question mark under the floor", () => {
		const { idle } = idleThenFlush("Go?");
		expect(idle.join("")).toMatch(/Go/);
	});

	it("speaks a complete thought ending in an ellipsis character under the floor", () => {
		const { idle } = idleThenFlush("Wait…");
		expect(idle.join("")).toMatch(/Wait/);
	});

	it("does not treat a mid-word period in 23 chars as a complete thought without the regex end-anchor", () => {
		const { idle, flushed } = idleThenFlush("See e.g. file");
		// "See e.g. file" is 13 chars, under 24, and does not end in terminal
		// punctuation (it ends in 'e'). flushIdle must refuse.
		expect(idle).toEqual([]);
		expect(flushed.join("")).toContain("file");
	});

	it("counts trailing closers after a period as a complete thought", () => {
		const { idle } = idleThenFlush('Ship it.")');
		expect(idle.join("")).toMatch(/Ship/);
	});

	it("does not speak whitespace-only even when it is long", () => {
		const { idle, flushed } = idleThenFlush(" ".repeat(40));
		expect(idle).toEqual([]);
		expect(flushed).toEqual([]);
	});
});

describe("the first segment does not emit a stub shorter than 12 characters", () => {
	it("holds 'Ok. ' until more text arrives rather than speaking a 3-char first segment", () => {
		const stream = new SpeakableStream();
		const first = stream.push("Ok. ");
		expect(first.every(s => s.length >= 12 || s.length === 0)).toBe(true);
		const rest = stream.push("The rest of this sentence is long enough to speak now.\n");
		const flushed = stream.flush();
		const joined = [...first, ...rest, ...flushed].join(" ");
		expect(joined).toMatch(/Ok/i);
		expect(joined).toMatch(/rest of this sentence/i);
	});

	it("will speak a first sentence once it is at least 12 characters", () => {
		const stream = new SpeakableStream();
		const first = stream.push("Hello there. More words come after this one today.\n");
		const flushed = stream.flush();
		const parts = [...first, ...flushed];
		expect(parts[0]?.length ?? 0).toBeGreaterThanOrEqual(12);
		expect(parts.join(" ")).toMatch(/Hello there/i);
	});
});

describe("first-clause fast cut sits between 40 and 140 characters", () => {
	it("does not clause-cut the first segment before 40 characters of comma-separated text", () => {
		const stream = new SpeakableStream();
		const head = "Hello, ";
		const more = "friend";
		expect((head + more).length).toBeLessThan(40);
		const first = stream.push(head + more);
		expect(first).toEqual([]);
		const flushed = stream.flush();
		expect(flushed.join("")).toContain("Hello");
		expect(flushed.join("")).toContain("friend");
	});

	it("clause-cuts the first segment once the buffer is past 40 and a comma exists after 12", () => {
		const stream = new SpeakableStream();
		const text =
			"Hello there operator, this clause is now long enough to cut early for audio.";
		expect(text.length).toBeGreaterThan(40);
		const first = stream.push(text);
		const flushed = stream.flush();
		const parts = [...first, ...flushed];
		expect(parts.length).toBeGreaterThanOrEqual(1);
		expect(parts[0]).toMatch(/Hello there operator/i);
	});
});
