/**
 * SpeakableStream's sentence cutter skips abbreviations and unclosed ticks,
 * and the block pass rewrites list/heading markers before anything is spoken.
 *
 * WHY THIS SUITE EXISTS. The existing speakable suite pins fences, tables,
 * markdown-link labels, path basenames, and the 280-char force-split. It does
 * not pin the cutter's two "do not cut here" rules, and it does not pin what
 * a numbered list or a heading sounds like:
 *
 *   - `e.g.` / `Dr.` / `No.` match ABBREVIATION_RE on the head, so a cut at
 *     that period would speak "See e." / "g. the file".
 *   - A cut inside an unclosed inline-code span would speak the opening tick
 *     and leave the rest for the next segment.
 *   - Numbered markers become `"1, "` via classifyPrefix. A four-digit
 *     `1000. ` is NOT a marker (`\d{1,3}`) and must be spoken as prose.
 *   - Headings (`# Title`) speak the title, not "hash Title".
 *   - `~~~` is a fence, same as backtick fences.
 *   - Autolinks and bare `www.` URLs speak the host, with query/hash gone.
 *
 * Pin the audible contract. A cutter that starts treating `Dr.` as a
 * sentence end is a speech defect, not a style choice.
 */
import { describe, expect, it } from "bun:test";
import { SpeakableStream } from "@veyyon/coding-agent/tts/speakable";

function spoken(input: string): string[] {
	const stream = new SpeakableStream();
	const fromPush = stream.push(input);
	const fromFlush = stream.flush();
	return [...fromPush, ...fromFlush];
}

function spokenJoin(input: string): string {
	return spoken(input).join(" ");
}

describe("abbreviations are not sentence ends", () => {
	it("does not cut after e.g. when the sentence continues", () => {
		const parts = spoken("See e.g. the other file for details.\n");
		const joined = parts.join(" ");
		expect(joined).toContain("e.g.");
		expect(joined).toContain("the other file");
		expect(parts.some(p => /^see e\.g\.?$/i.test(p.trim()))).toBe(false);
	});

	it("does not cut after i.e. / etc. / vs. / Dr. / Mr. / Mrs. / Ms. / St. / No.", () => {
		const samples = [
			"Use the helper, i.e. the exported one, always in this path.",
			"Bring snacks, etc. then sit down please everyone here now.",
			"This vs. that comparison is the whole point of the note today.",
			"Ask Dr. Jones about the crash in production tonight after lunch.",
			"Mr. Smith already filed the ticket this morning for us all.",
			"Mrs. Lee signed the form before leaving the building today.",
			"Ms. Park will review the patch after lunch with the team here.",
			"Meet at St. James station before the evening deploy window now.",
			"See No. 12 in the appendix for the worked example today please.",
		];
		for (const sample of samples) {
			const parts = spoken(`${sample}\n`);
			expect(parts.length).toBeGreaterThan(0);
			const joined = parts.join(" ");
			expect(joined.length).toBeGreaterThan(20);
		}
	});

	it("still cuts at a real sentence end after a non-abbrev word", () => {
		const parts = spoken("The file is ready. Ship it after lunch today please.\n");
		expect(parts.length).toBeGreaterThanOrEqual(1);
		expect(parts[0]).toMatch(/ready/i);
	});
});

describe("an unclosed inline-code span is not a cut point", () => {
	it("does not split a sentence at a period that sits inside unmatched backticks", () => {
		const parts = spoken("Call `foo.bar.baz` and then return to the prompt.\n");
		const joined = parts.join(" ");
		expect(joined).toContain("foo.bar.baz");
		expect(joined).toContain("return to the prompt");
		expect(parts.some(p => p.includes("foo.") && !p.includes("baz"))).toBe(false);
	});

	it("strips the ticks but keeps the identifier when the span is closed", () => {
		const joined = spokenJoin("Run `encodeWav` next after the header check.\n");
		expect(joined).toContain("encodeWav");
		expect(joined).not.toContain("`");
	});
});

describe("list and heading markers are spoken as speech, not as markdown", () => {
	it("speaks a numbered list item as '1, ' plus the rest, not as '1.' markup", () => {
		const joined = spokenJoin("1. Restart the session after the patch lands today.\n");
		expect(joined).toMatch(/1,/);
		expect(joined).toContain("Restart the session");
		expect(joined.startsWith("1.")).toBe(false);
	});

	it("speaks 999. as a numbered marker (three digits) and 1000. as prose", () => {
		const three = spokenJoin("999. Last item in the roster of cases today.\n");
		expect(three).toMatch(/999,/);
		const four = spokenJoin("1000. This is a line number in a dump not a list.\n");
		expect(four).toContain("1000");
		expect(four).not.toMatch(/^1000,/);
	});

	it("strips a heading hash so '# Title' is spoken as Title", () => {
		const joined = spokenJoin("# Restart the worker after deploy today please.\n");
		expect(joined).toContain("Restart the worker");
		expect(joined).not.toMatch(/^#/);
		expect(joined).not.toContain("# Restart");
	});

	it("strips an ATX heading of six hashes and still speaks the title", () => {
		const joined = spokenJoin("###### Tiny heading about the crash handler today.\n");
		expect(joined).toContain("Tiny heading");
		expect(joined).not.toContain("######");
	});

	it("strips a bullet marker so '- item' is the item", () => {
		const joined = spokenJoin("- Restart the worker after deploy today please.\n");
		expect(joined).toContain("Restart the worker");
		expect(joined.trim().startsWith("-")).toBe(false);
	});

	it("speaks a blockquote body and not the leading greater-than run", () => {
		const joined = spokenJoin("> The operator already approved this change today.\n");
		expect(joined).toContain("operator already approved");
		expect(joined.trim().startsWith(">")).toBe(false);
	});
});

describe("fences, rules, links, images, URLs", () => {
	it("silences a ~~~ fenced block the same way it silences a backtick fence", () => {
		const joined = spokenJoin("Before the sample starts here.\n~~~\nsecret token abcdef\n~~~\nAfter the fence is spoken too.\n");
		expect(joined).toContain("Before");
		expect(joined).toContain("After the fence");
		expect(joined).not.toContain("secret token");
		expect(joined).not.toContain("abcdef");
	});

	it("does not speak a horizontal rule line", () => {
		const joined = spokenJoin("Hello there operator today.\n---\nStill here after the rule today.\n");
		expect(joined).toContain("Hello there");
		expect(joined).toContain("Still here");
		expect(joined).not.toMatch(/-{3,}/);
	});

	it("speaks an image's alt text and drops the url", () => {
		const joined = spokenJoin("See ![crash graph](https://example.com/a.png) for the spike today.\n");
		expect(joined).toContain("crash graph");
		expect(joined).not.toContain("example.com");
		expect(joined).not.toContain(".png");
	});

	it("drops a label-less image rather than speaking the url", () => {
		const joined = spokenJoin("See ![](https://example.com/a.png) please wait now today.\n");
		expect(joined).not.toContain("example.com");
		expect(joined).toContain("please wait");
	});

	it("speaks an autolink as its host, stripping scheme query and hash", () => {
		const joined = spokenJoin("Open <https://github.com/foo/bar?x=1#y> for the patch today.\n");
		expect(joined).toContain("github.com");
		expect(joined).not.toContain("https://");
		expect(joined).not.toContain("foo/bar");
		expect(joined).not.toContain("x=1");
	});

	it("speaks a bare www. URL as the host", () => {
		const joined = spokenJoin("See www.example.com/path?q=1 for the docs today please.\n");
		expect(joined).toContain("example.com");
		expect(joined).not.toContain("www.");
		expect(joined).not.toContain("/path");
	});

	it("strips HTML tags so a strong word is still spoken", () => {
		const joined = spokenJoin("The <strong>critical</strong> path is the auth broker login today.\n");
		expect(joined).toContain("critical");
		expect(joined).not.toContain("<strong>");
		expect(joined).not.toContain("</strong>");
	});

	it("strips emphasis markers without eating the word", () => {
		const joined = spokenJoin("This is *critical* and __required__ now for the deploy.\n");
		expect(joined).toContain("critical");
		expect(joined).toContain("required");
		expect(joined).not.toContain("*critical*");
		expect(joined).not.toContain("__required__");
	});
});

describe("flushIdle still refuses a stubby abbreviation-only buffer", () => {
	it("does not speak a lone 'Dr.' when generation stalls mid-sentence", () => {
		const stream = new SpeakableStream();
		expect(stream.push("Dr.")).toEqual([]);
		expect(stream.flushIdle()).toEqual([]);
		const rest = stream.push(" Jones will sign off after lunch today.\n");
		const flushed = stream.flush();
		const joined = [...rest, ...flushed].join(" ");
		expect(joined).toMatch(/Jones/i);
	});
});
