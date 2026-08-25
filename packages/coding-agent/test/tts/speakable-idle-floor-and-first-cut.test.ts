/**
 * speakable.test.ts pins "a short mid-sentence fragment" and "a short complete
 * thought" without the numeric floors. Remaining:
 *
 *   - 23 letters, no terminal → flushIdle silent
 *   - 24 letters, no terminal → flushIdle speaks
 *   - first sentence shorter than 12 chars is held ("Ok. ")
 *   - first-clause cut is refused before 40 characters
 */
import { describe, expect, it } from "bun:test";
import { SpeakableStream } from "@veyyon/coding-agent/tts/speakable";

function idleThenFlush(text: string): { idle: string[]; flushed: string[] } {
	const stream = new SpeakableStream();
	stream.push(text);
	return { idle: stream.flushIdle(), flushed: stream.flush() };
}

describe("flushIdle's 24-character mid-sentence floor", () => {
	it("refuses a 23-character fragment with no terminal punctuation", () => {
		const text = "a".repeat(23);
		const { idle, flushed } = idleThenFlush(text);
		expect(idle).toEqual([]);
		expect(flushed.join("")).toBe(text);
	});

	it("speaks a 24-character fragment with no terminal punctuation", () => {
		const text = "a".repeat(24);
		const { idle, flushed } = idleThenFlush(text);
		expect(idle.join("")).toBe(text);
		expect(flushed).toEqual([]);
	});
});

describe("the first segment does not emit a stub shorter than 12 characters", () => {
	it("holds 'Ok. ' until more text arrives rather than speaking a 3-char first segment", () => {
		const stream = new SpeakableStream();
		const first = stream.push("Ok. ");
		expect(first.every(s => s.length >= 12 || s.length === 0)).toBe(true);
		const rest = stream.push("The rest of this sentence is long enough to speak now.\n");
		const joined = [...first, ...rest, ...stream.flush()].join(" ");
		expect(joined).toMatch(/Ok/i);
		expect(joined).toMatch(/rest of this sentence/i);
	});
});

describe("first-clause fast cut sits at 40 characters", () => {
	it("does not clause-cut before 40 characters of comma-separated text", () => {
		const stream = new SpeakableStream();
		const text = "Hello, friend";
		expect(text.length).toBeLessThan(40);
		expect(stream.push(text)).toEqual([]);
		const flushed = stream.flush().join("");
		expect(flushed).toContain("Hello");
		expect(flushed).toContain("friend");
	});

	it("clause-cuts the first segment once the buffer is past 40 and a comma exists after 12", () => {
		const stream = new SpeakableStream();
		const text =
			"Hello there operator, this clause is now long enough to cut early for audio.";
		expect(text.length).toBeGreaterThan(40);
		const parts = [...stream.push(text), ...stream.flush()];
		expect(parts[0]).toMatch(/Hello there operator/i);
	});
});
