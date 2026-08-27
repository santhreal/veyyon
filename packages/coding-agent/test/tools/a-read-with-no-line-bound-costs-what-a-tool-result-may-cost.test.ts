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
async function toolFor(cwd: string, spillThresholdKb?: number): Promise<Tool> {
	const session = makeToolSession({
		cwd,
		settings: {
			get: (key: string) => (key === "tools.artifactSpillThreshold" ? spillThresholdKb : undefined),
		},
	});
	const tools = await createTools(session, ["read"]);
	const read = tools.find(tool => tool.name === "read");
	if (!read) throw new Error("read tool missing");
	return read;
}

async function readText(tool: Tool, target: string): Promise<string> {
	const result = await tool.execute("probe", { path: target } as never, undefined, undefined, undefined);
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block)
		.map(block => block.text)
		.join("\n");
}

let dir: string;

describe("a read with no line bound costs what a tool result may cost", () => {
	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-budget-"));
		const line = "x".repeat(LINE_WIDTH);
		await fs.writeFile(path.join(dir, FIXTURE), `${Array.from({ length: LINE_COUNT }, () => line).join("\n")}\n`);
		await fs.writeFile(path.join(dir, "short.md"), "one\ntwo\nthree\n");
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
});
