/**
 * WHY: a selector-free `read` of parseable code returns a structural summary,
 * and that summary carried no budget at all. A summary is a projection over the
 * WHOLE file, so a declaration-dense file keeps nearly every line: a bare read
 * of `packages/catalog/src/discovery/cursor-gen/agent_pb.ts` returned 326.5KB,
 * about 82,000 tokens in one tool result, re-sent on every later request of the
 * session. Five generated files in this repository returned over 295KB each,
 * and a hand-written one (`openai-compat.ts`) returned 54.5KB. The
 * `tools.artifactSpillThreshold` budget every other read window follows was
 * never consulted.
 *
 * The class this closes: a `read`-owned surface with no byte budget. `read` is
 * exempt from the shared spill layer by design, so each surface it renders --
 * file window, directory listing, archive listing, notebook, URL body, sqlite,
 * and this summary -- must carry the budget itself and state the selector that
 * pages the rest.
 *
 * The per-line column cap is asserted here for the same reason: a generated
 * file whose descriptor sits on one 200KB line would otherwise end the summary
 * at that line, since a single unit over the budget stops the render. Clipping
 * the line to `tools.outputMaxColumns` (as every other read window already
 * does) lets the summary continue through the declarations that follow it.
 *
 * What it does not catch: a summary of a file the parser cannot fold at all
 * (that read falls to the plain window path, covered by the read-budget suite),
 * and the TUI frame's own render caps.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createTools, type Tool } from "@veyyon/coding-agent/tools";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/** Enough declarations that the whole projection exceeds the largest budget under test. */
const DENSE_DECLARATIONS = 1000;
/** A body of this many lines is folded: `read.summarize.minBodyLines` defaults to 4. */
const BODY_LINES = 6;
const GIANT_LINE_BYTES = 200 * 1024;
/** Named so a summary that resumed after the giant line can be recognized. */
const AFTER_GIANT = "declaredAfterTheGiantLine";

function denseSource(count: number): string {
	const parts: string[] = [];
	for (let index = 0; index < count; index++) {
		const name = `handlerNumber${String(index).padStart(4, "0")}`;
		parts.push(`export function ${name}(input: string): string {`);
		for (let line = 0; line < BODY_LINES; line++) {
			parts.push(`\tconst step${line} = input.concat("${name}-${line}");`);
		}
		parts.push(`\treturn step0;`);
		parts.push(`}`);
		parts.push("");
	}
	return `${parts.join("\n")}\n`;
}

async function toolFor(cwd: string, thresholdKb: number, maxColumns?: number): Promise<Tool> {
	const settings = Settings.isolated();
	settings.set("tools.artifactSpillThreshold", thresholdKb);
	if (maxColumns !== undefined) settings.set("tools.outputMaxColumns", maxColumns);
	const tools = await createTools(makeToolSession({ cwd, settings, skipPythonPreflight: true }), ["read"]);
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

describe("a structural summary costs what a tool result may cost", () => {
	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "summary-budget-"));
		await fs.writeFile(path.join(dir, "dense.ts"), denseSource(DENSE_DECLARATIONS));
		await fs.writeFile(path.join(dir, "small.ts"), denseSource(12));
		const giant = `export const descriptor = "${"d".repeat(GIANT_LINE_BYTES)}";\n`;
		await fs.writeFile(
			path.join(dir, "giant.ts"),
			`${denseSource(12)}${giant}export function ${AFTER_GIANT}(input: string): string {\n${Array.from(
				{ length: BODY_LINES },
				(_, line) => `\tconst step${line} = input.concat("${line}");`,
			).join("\n")}\n\treturn step0;\n}\n`,
		);
	});

	afterAll(async () => {
		await removeWithRetries(dir);
	});

	it("summarizes the dense fixture, so the rest of this suite measures a summary", async () => {
		const text = await readText(await toolFor(dir, 64), "dense.ts");
		expect(text).toContain("elided");
		expect(text).toContain("handlerNumber0000");
	});

	it("holds a summary to the configured budget instead of rendering the whole projection", async () => {
		const small = Buffer.byteLength(await readText(await toolFor(dir, 8), "dense.ts"), "utf-8");
		const large = Buffer.byteLength(await readText(await toolFor(dir, 64), "dense.ts"), "utf-8");
		// The budget bounds the summary body; the elision footer and the budget
		// notice are added after it, so allow one notice of slack.
		expect(small).toBeLessThan(8 * 1024 + 512);
		expect(large).toBeGreaterThan(small * 4);
		expect(large).toBeLessThan(64 * 1024 + 512);
	});

	it("states the line that continues a capped summary", async () => {
		const text = await readText(await toolFor(dir, 8), "dense.ts");
		const notice = /\[Summary reached the (?<size>[\d.]+KB) output budget\. Use :(?<next>\d+) to continue\]/.exec(
			text,
		);
		expect(notice).not.toBeNull();
		expect(notice?.groups?.size).toBe("8.0KB");
		const next = Number(notice?.groups?.next);
		// The continuation line is a real line of the file, past what was shown
		// and inside the fixture: a summary that stopped at line 0, or at a line
		// beyond the file, names a selector that reads nothing.
		expect(next).toBeGreaterThan(1);
		expect(next).toBeLessThan(DENSE_DECLARATIONS * (BODY_LINES + 3));
		expect(text).not.toContain(`${next}:`);
	});

	it("leaves a summary inside the budget unannotated", async () => {
		const text = await readText(await toolFor(dir, 64), "small.ts");
		expect(text).toContain("handlerNumber0000");
		expect(text).not.toContain("output budget");
	});

	it("clips a line wider than the column cap instead of ending the summary at it", async () => {
		const text = await readText(await toolFor(dir, 64, 200), "giant.ts");
		expect(text).toContain(AFTER_GIANT);
		expect(text).not.toContain("output budget");
		expect(text).not.toContain("d".repeat(400));
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(64 * 1024);
	});

	it("still holds a summary with a giant line to a small budget", async () => {
		const text = await readText(await toolFor(dir, 8, 200), "giant.ts");
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(8 * 1024 + 512);
	});
});
