// WHY: `read` priced its window against a compiled constant nothing could
// reach. The line budget was scaled into a byte budget at 512 bytes a line, so
// the 300-line default allowed 150KB inline while every other tool result was
// held to the 50KB `tools.artifactSpillThreshold` budget. One default read of
// packages/coding-agent/CHANGELOG.md returned 19,768 tokens, more than the whole
// tool prelude, and a tool result is re-sent on every later request of the
// session. `read CHANGELOG.md:50` cost 23,643.
//
// The class this closes: a read whose line bound came from the default rather
// than from the caller, on every path that substitutes the default (a bare
// path, an offset with no count, an open-ended range, and an open-ended member
// of a multi-range selector). A caller who names a line count still gets those
// lines, because that is a request and not a default. The suite derives the cap
// from the setting, so a path that goes back to a compiled constant goes red.
//
// What it does not catch: a new selector form is only covered once it is listed
// in SELECTORS below, and the artifact read path shares the budget owner but is
// exercised by the artifact suites rather than here.
//
// A directory listing is included because it is the same class: the unsliced
// listing priced itself against the compiled constant, and the sliced listing
// carried no byte bound at all.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createTools, type Tool } from "@veyyon/coding-agent/tools";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/** 400 lines of 400 characters: 160KB, over any inline budget under test. */
const LINE_COUNT = 400;
const LINE_WIDTH = 400;
const FIXTURE = "prose.md";

/** Selector forms that state no line count, so the tool supplies the default. */
const SELECTORS = ["", ":50", ":50-", ":1-2,50-"];

// The truncation notice is rendered by the layer `createTools` installs, not by
// the tool class, so a suite that constructs `ReadTool` directly cannot see the
// bytes a real caller is told about.
async function toolFor(cwd: string, spillThresholdKb?: number, name = "read"): Promise<Tool> {
	const session = makeToolSession({
		cwd,
		settings: {
			get: (key: string) => (key === "tools.artifactSpillThreshold" ? spillThresholdKb : undefined),
		},
	});
	const tools = await createTools(session, [name]);
	const tool = tools.find(entry => entry.name === name);
	if (!tool) throw new Error(`${name} tool missing`);
	return tool;
}

async function readText(tool: Tool, target: string): Promise<string> {
	const result = await tool.execute("probe", { path: target } as never, undefined, undefined, undefined);
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block)
		.map(block => block.text)
		.join("\n");
}

/**
 * A ustar archive of empty members, built here so the archive-listing case needs no
 * external tar binary and no committed binary fixture.
 */
function tarOfEmptyMembers(names: readonly string[]): Buffer {
	const blocks: Buffer[] = [];
	for (const name of names) {
		const header = Buffer.alloc(512);
		header.write(name, 0, 100, "utf-8");
		header.write("0000644\0", 100, 8, "utf-8");
		header.write("0000000\0", 108, 8, "utf-8");
		header.write("0000000\0", 116, 8, "utf-8");
		header.write("00000000000\0", 124, 12, "utf-8");
		header.write("00000000000\0", 136, 12, "utf-8");
		header.write("        ", 148, 8, "utf-8");
		header.write("0", 156, 1, "utf-8");
		header.write("ustar\0", 257, 6, "utf-8");
		header.write("00", 263, 2, "utf-8");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf-8");
		blocks.push(header);
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}

let dir: string;

describe("a read with no line bound costs what a tool result may cost", () => {
	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-budget-"));
		const line = "x".repeat(LINE_WIDTH);
		await fs.writeFile(path.join(dir, FIXTURE), `${Array.from({ length: LINE_COUNT }, () => line).join("\n")}\n`);
		await fs.writeFile(path.join(dir, "short.md"), "one\ntwo\nthree\n");
		await fs.writeFile(
			path.join(dir, "book.ipynb"),
			JSON.stringify({
				cells: Array.from({ length: LINE_COUNT }, () => ({
					cell_type: "code",
					source: [`${line}\n`],
					metadata: {},
					outputs: [],
					execution_count: null,
				})),
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5,
			}),
		);
		const wide = path.join(dir, "many");
		await fs.mkdir(wide);
		// 400 entries of 80-character names: a listing far past any budget under test.
		await Promise.all(
			Array.from({ length: 400 }, (_, index) =>
				fs.writeFile(path.join(wide, `${String(index).padStart(4, "0")}-${"n".repeat(74)}.txt`), "x"),
			),
		);
		await fs.writeFile(
			path.join(dir, "wide.tar"),
			tarOfEmptyMembers(
				Array.from({ length: 400 }, (_, index) => `many/${String(index).padStart(4, "0")}-${"n".repeat(74)}.txt`),
			),
		);
	});

	afterAll(async () => {
		await removeWithRetries(dir);
	});

	it("holds every default-bounded selector form to the configured budget", async () => {
		const budgetKb = 8;
		const tool = await toolFor(dir, budgetKb);
		for (const selector of SELECTORS) {
			const text = await readText(tool, `${FIXTURE}${selector}`);
			const bytes = Buffer.byteLength(text, "utf-8");
			// One line of slack: the budget bounds collected content, and the
			// notice and header are added after it.
			expect(bytes).toBeLessThan(budgetKb * 1024 + LINE_WIDTH * 3);
			expect(bytes).toBeGreaterThan(budgetKb * 512);
		}
	});

	it("holds a rendered notebook to the configured budget too", async () => {
		// The notebook, document, archive-entry, URL and internal-resource reads
		// share one in-memory window, which priced itself against the compiled
		// constant while every other tool result followed the setting.
		const small = Buffer.byteLength(await readText(await toolFor(dir, 8), "book.ipynb"), "utf-8");
		const large = Buffer.byteLength(await readText(await toolFor(dir, 64), "book.ipynb"), "utf-8");
		expect(small).toBeLessThan(8 * 1024 + LINE_WIDTH * 3);
		expect(large).toBeGreaterThan(small * 4);
	});

	it("scales the window with the configured budget rather than a compiled constant", async () => {
		const small = Buffer.byteLength(await readText(await toolFor(dir, 8), FIXTURE), "utf-8");
		const large = Buffer.byteLength(await readText(await toolFor(dir, 64), FIXTURE), "utf-8");
		expect(large).toBeGreaterThan(small * 4);
		expect(small).toBeLessThan(8 * 1024 + LINE_WIDTH * 3);
		expect(large).toBeLessThan(64 * 1024 + LINE_WIDTH * 3);
	});

	it("returns every line a caller asked for by count", async () => {
		const text = await readText(await toolFor(dir, 8), `${FIXTURE}:1-${LINE_COUNT}`);
		expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(LINE_COUNT * LINE_WIDTH);
		expect(text).toContain(`${LINE_COUNT}:`);
	});

	it("states the selector that pages the rest of a capped read", async () => {
		const text = await readText(await toolFor(dir, 8), FIXTURE);
		const notice = /\[Showing lines 1-(\d+) of (\d+) \((?<size>[\d.]+KB) limit\)\. Use :(\d+) to continue/.exec(text);
		expect(notice).not.toBeNull();
		const shown = Number(notice?.[1]);
		const next = Number(notice?.[4]);
		expect(next).toBe(shown + 1);
		expect(Number(notice?.[2])).toBe(LINE_COUNT + 1);
	});

	it("names the lines it showed when a multi-range member is capped", async () => {
		const text = await readText(await toolFor(dir, 8), `${FIXTURE}:1-2,50-`);
		const notice = /\[Lines 50-(\d+) reached the [\d.]+KB output budget\. Use :(\d+) to continue\]/.exec(text);
		expect(notice).not.toBeNull();
		expect(Number(notice?.[2])).toBe(Number(notice?.[1]) + 1);
		expect(text).toContain("1:");
	});

	it("leaves a file inside the budget whole and unannotated", async () => {
		const text = await readText(await toolFor(dir, 8), "short.md");
		expect(text).toContain("three");
		expect(text).not.toContain("output budget");
		expect(text).not.toContain("limit). Use :");
	});

	it("holds a directory listing to the configured budget", async () => {
		const small = Buffer.byteLength(await readText(await toolFor(dir, 8), "many"), "utf-8");
		const large = Buffer.byteLength(await readText(await toolFor(dir, 64), "many"), "utf-8");
		expect(small).toBeLessThan(8 * 1024 + 512);
		expect(large).toBeGreaterThan(small * 2);
	});

	it("holds an archive listing to the configured budget", async () => {
		const small = Buffer.byteLength(await readText(await toolFor(dir, 8), "wide.tar:many"), "utf-8");
		const large = Buffer.byteLength(await readText(await toolFor(dir, 64), "wide.tar:many"), "utf-8");
		expect(small).toBeLessThan(8 * 1024 + 512);
		expect(large).toBeGreaterThan(small * 2);
	});

	it("bounds a sliced directory listing and names the line that continues it", async () => {
		const text = await readText(await toolFor(dir, 8), "many:1-400");
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(8 * 1024 + 512);
		const notice = /\[(\d+) more lines? in listing\. Use :(\d+) to continue\]/.exec(text);
		expect(notice).not.toBeNull();
		// The continuation selector names the first listing line the result did not carry, so the
		// shown rows plus one is exactly where the next read starts.
		const shown = text.slice(0, notice?.index).trimEnd().split("\n").length;
		expect(Number(notice?.[2])).toBe(shown + 1);
		expect(Number(notice?.[1])).toBe(401 - shown);
	});

	it("holds a glob path list to the configured budget", async () => {
		// `search` in files mode renders a path list, which is a tool result like any other: the
		// entry limit bounds how many paths render, the budget bounds what they cost.
		const listBytes = async (kb: number): Promise<number> => {
			const search = await toolFor(dir, kb, "search");
			const result = await search.execute(
				"probe",
				{ type: "files", input: "many/*.txt", limit: 400 } as never,
				undefined,
				undefined,
				undefined,
			);
			return Buffer.byteLength(
				result.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block)
					.map(block => block.text)
					.join("\n"),
				"utf-8",
			);
		};
		const small = await listBytes(8);
		const large = await listBytes(64);
		expect(small).toBeLessThan(8 * 1024 + 512);
		expect(large).toBeGreaterThan(small * 2);
	});
});
