/**
 * A padded range read says so in the result, not only in the docs.
 *
 * WHY THIS SUITE EXISTS. `read file:1-3` returns six lines: three requested and three of trailing
 * context, because a narrow range is usually one line short of the anchor the next call needs. The
 * padding is deliberate and it is documented in `docs/tools/read.md`. Documenting it was not enough. A
 * dogfooding agent flagged `read /etc/passwd:1-3` returning six lines as over-delivery, was told the
 * behaviour was documented, and flagged the same read again: the surprise happens at CALL TIME, where
 * the result looked like the selector had been ignored and nothing in the output said otherwise.
 *
 * So the result now discloses it. These tests assert the notice's exact bytes, because a vague or
 * mis-counted notice is worse than none: a reader who is told "plus 3 lines of trailing context" and
 * counts four has lost the ability to trust the number at all. The counts are checked against the line
 * numbers the same output rendered, so the notice cannot drift from the content it describes.
 *
 * The negative cases matter as much. An exact read must stay unannotated, or every whole-file read
 * grows a line of noise, and `:raw` must stay byte-verbatim because its whole purpose is paste-back
 * output. Both are asserted here rather than left to the padding tests, which only ever look at what
 * WAS padded.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool, type ReadToolDetails } from "@veyyon/coding-agent/tools/read";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	// Structural summarization would replace literal lines, and this suite is about line accounting.
	settings.set("read.summarize.enabled", false);
	return makeToolSession({
		cwd,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
	});
}

/** The 1-based line numbers actually rendered, read from each `N:` line prefix. */
function renderedLineNumbers(text: string): number[] {
	const nums: number[] = [];
	for (const line of text.split("\n")) {
		const match = line.match(/^(\d+):/);
		if (match) nums.push(Number(match[1]));
	}
	return nums;
}

/** The disclosure line, or undefined when the result carries none. */
function paddingNotice(text: string): string | undefined {
	return text.split("\n").find(line => line.startsWith("[Showing lines "));
}

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-padding-notice-"));
	filePath = path.join(tmpDir, "numbered.txt");
	await fs.writeFile(
		filePath,
		Array.from({ length: 20 }, (_, i) => `content_${String(i + 1).padStart(3, "0")}_x`).join("\n"),
	);
});

afterEach(async () => {
	await removeWithRetries(tmpDir);
});

async function read(selector: string): Promise<string> {
	const tool = new ReadTool(createSession(tmpDir));
	return textOutput(await tool.execute(`call-${selector}`, { path: `${filePath}:${selector}` }));
}

describe("a range padded only at the end", () => {
	/**
	 * THE case from the dogfood report, in its exact shape: a range starting at line 1 gets no leading
	 * context (an open-ended read from the top already starts there) and three trailing lines.
	 */
	it("names the requested range and the trailing padding, and the count matches the lines shown", async () => {
		const text = await read("1-3");

		expect(renderedLineNumbers(text)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(paddingNotice(text)).toBe(
			"[Showing lines 1-6: you requested lines 1-3, plus 3 lines of trailing context]",
		);
	});

	it("says the same thing for a wider range, because the padding is a constant not a fraction", async () => {
		const text = await read("1-5");

		expect(renderedLineNumbers(text)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(paddingNotice(text)).toBe(
			"[Showing lines 1-8: you requested lines 1-5, plus 3 lines of trailing context]",
		);
	});
});

describe("a range padded on both sides", () => {
	/**
	 * Both paddings in one notice, and they are reported separately: a reader who sees "lines 4-11" for a
	 * request of 5-8 has to be able to tell which end moved, because the answer decides whether the next
	 * selector should start earlier or end later.
	 */
	it("reports the leading and the trailing padding separately", async () => {
		const text = await read("5-8");

		expect(renderedLineNumbers(text)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
		expect(paddingNotice(text)).toBe(
			"[Showing lines 4-11: you requested lines 5-8, plus 1 line of leading context and 3 lines of trailing context]",
		);
	});

	/** A single requested line reads as "line 7", not "lines 7-7", which is how a person writes it. */
	it("describes a one-line request in the singular", async () => {
		const text = await read("7-7");

		expect(renderedLineNumbers(text)).toEqual([6, 7, 8, 9, 10]);
		expect(paddingNotice(text)).toBe(
			"[Showing lines 6-10: you requested line 7, plus 1 line of leading context and 3 lines of trailing context]",
		);
	});
});

describe("padding clamped by the file", () => {
	/**
	 * The notice is computed from what was actually shown, not from the constants. A range that runs into
	 * the end of the file gets fewer trailing lines than three, and saying "3" there would be a lie the
	 * reader can check in one glance.
	 */
	it("counts only the trailing lines the file could supply", async () => {
		const text = await read("18-19");

		expect(renderedLineNumbers(text)).toEqual([17, 18, 19, 20]);
		expect(paddingNotice(text)).toBe(
			"[Showing lines 17-20: you requested lines 18-19, plus 1 line of leading context and 1 line of trailing context]",
		);
	});

	/** A range that ends exactly at EOF gets no trailing padding, so only the leading half is reported. */
	it("reports leading padding alone when there is nothing after the range", async () => {
		const text = await read("19-20");

		expect(renderedLineNumbers(text)).toEqual([18, 19, 20]);
		expect(paddingNotice(text)).toBe(
			"[Showing lines 18-20: you requested lines 19-20, plus 1 line of leading context]",
		);
	});
});

describe("a read that was not padded", () => {
	/**
	 * The notice exists to explain a surprise. Where there is none it must be absent, or every read in a
	 * session carries a line of boilerplate the model pays for and learns to ignore.
	 */
	it("carries no notice for a whole-file read", async () => {
		const tool = new ReadTool(createSession(tmpDir));
		const text = textOutput(await tool.execute("call-whole", { path: filePath }));

		expect(renderedLineNumbers(text)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
		expect(paddingNotice(text)).toBeUndefined();
	});

	/**
	 * `raw` is the verbatim-extraction contract: exactly the requested lines, no numbering, nothing added.
	 * A notice would corrupt output whose purpose is to be pasted back into a tool.
	 */
	it("adds nothing at all to a raw range", async () => {
		const text = await read("raw:1-3");

		expect(text.split("\n").filter(line => line.length > 0)).toEqual([
			"content_001_x",
			"content_002_x",
			"content_003_x",
		]);
		expect(paddingNotice(text)).toBeUndefined();
	});
});

describe("an open-ended read from a line", () => {
	/**
	 * `:15` with no end constrains only the start, so it gets the leading line and no trailing padding.
	 * The notice has to describe THAT shape too: it names one requested line and one padding side, rather
	 * than inventing an end for a range the caller left open.
	 */
	it("reports the leading padding alone and names a single requested line", async () => {
		const text = await read("15");

		expect(renderedLineNumbers(text)).toEqual([14, 15, 16, 17, 18, 19, 20]);
		expect(paddingNotice(text)).toBe("[Showing lines 14-20: you requested line 15, plus 1 line of leading context]");
	});
});

describe("where the notice sits", () => {
	/**
	 * Last, after a blank line, so it never interleaves with the numbered body a model may be about to
	 * anchor an edit against. A notice spliced between content lines would make the output ambiguous about
	 * which lines are file content.
	 */
	it("is the final line of the result, separated from the body", async () => {
		const text = await read("5-8");
		const lines = text.split("\n");

		expect(lines.at(-1)).toBe(
			"[Showing lines 4-11: you requested lines 5-8, plus 1 line of leading context and 3 lines of trailing context]",
		);
		expect(lines.at(-2)).toBe("");
		expect(lines.at(-3)).toBe("11:content_011_x");
	});
});
