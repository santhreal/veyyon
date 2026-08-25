/**
 * speakable.test.ts already pins `e.g.`, ATX headings, bullets, `1. First` →
 * `1, First`, closed `` `parseConfig` ``, backtick fences, bold/italic, and
 * a silent HR. These cases are not in that file:
 *
 *   - `Dr.` is in ABBREVIATION_RE; `e.g.` is not a title abbrev
 *   - numbered markers are `\d{1,3}` so `1000.` is prose, `999.` is a list
 *   - `~~~` is a fence, distinct from the backtick fence suite
 *   - a period inside closed ticks (`foo.bar.baz`) is not a sentence end
 *   - autolink / bare `www.` speak the host, not the URL
 *   - flushIdle of a lone `Dr.` must stay silent (abbrev, not a thought)
 */
import { describe, expect, it } from "bun:test";
import { SpeakableStream } from "@veyyon/coding-agent/tts/speakable";

function spoken(input: string): string[] {
	const stream = new SpeakableStream();
	return [...stream.push(input), ...stream.flush()];
}

function spokenJoin(input: string): string {
	return spoken(input).join(" ");
}

describe("title abbreviations the e.g. suite does not cover", () => {
	it("does not cut after Dr. when the surname follows", () => {
		const parts = spoken("Ask Dr. Jones about the crash in production tonight after lunch.\n");
		expect(parts.some(p => /^ask dr\.?$/i.test(p.trim()))).toBe(false);
		expect(parts.join(" ")).toMatch(/Jones/i);
	});

	it("does not speak a lone Dr. from flushIdle when generation stalls", () => {
		const stream = new SpeakableStream();
		expect(stream.push("Dr.")).toEqual([]);
		expect(stream.flushIdle()).toEqual([]);
		const rest = [...stream.push(" Jones will sign off after lunch today.\n"), ...stream.flush()];
		expect(rest.join(" ")).toMatch(/Jones/i);
	});
});

describe("list digit cap and ticks with interior periods", () => {
	it("treats 999. as a numbered marker and 1000. as prose", () => {
		expect(spokenJoin("999. Last item in the roster of cases today.\n")).toMatch(/999,/);
		const four = spokenJoin("1000. This is a line number in a dump not a list.\n");
		expect(four).toContain("1000");
		expect(four).not.toMatch(/^1000,/);
	});

	it("does not split at a period inside closed ticks", () => {
		const parts = spoken("Call `foo.bar.baz` and then return to the prompt.\n");
		expect(parts.some(p => p.includes("foo.") && !p.includes("baz"))).toBe(false);
		expect(parts.join(" ")).toContain("foo.bar.baz");
	});
});

describe("fence and URL forms the existing suite does not name", () => {
	it("silences a ~~~ fence the same way as a backtick fence", () => {
		const joined = spokenJoin("Before the sample starts here.\n~~~\nsecret token abcdef\n~~~\nAfter the fence is spoken too.\n");
		expect(joined).toContain("Before");
		expect(joined).toContain("After the fence");
		expect(joined).not.toContain("secret token");
	});

	it("speaks an autolink as the host, dropping scheme query and hash", () => {
		const joined = spokenJoin("Open <https://github.com/foo/bar?x=1#y> for the patch today.\n");
		expect(joined).toContain("github.com");
		expect(joined).not.toContain("https://");
		expect(joined).not.toContain("x=1");
	});

	it("speaks a bare www. URL as the host", () => {
		const joined = spokenJoin("See www.example.com/path?q=1 for the docs today please.\n");
		expect(joined).toContain("example.com");
		expect(joined).not.toContain("www.");
		expect(joined).not.toContain("/path");
	});
});
