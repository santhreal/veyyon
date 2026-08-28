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
 * The line default is asserted for the same reason a selector-free file window
 * stops at `read.defaultLimit`: the caller named no line count, so the default
 * names it. Without that bound only bytes stopped a summary, and a
 * declaration-dense file spent the whole 50KB budget: measured over 4,039
 * summaries in this repository the median is 57 lines, 54 files exceed 300, and
 * those 54 cost 311,211 tokens between them.
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
/**
 * A line bound high enough that only the byte budget can stop the render.
 * `ReadTool` clamps `read.defaultLimit` to `DEFAULT_MAX_LINES` (3000), so this
 * is the ceiling, not an arbitrary large number.
 */
const LINES_OUT_OF_THE_WAY = 3000;

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

async function toolFor(
	cwd: string,
	thresholdKb: number,
	options: { maxColumns?: number; defaultLimit?: number } = {},
): Promise<Tool> {
	const settings = Settings.isolated();
	settings.set("tools.artifactSpillThreshold", thresholdKb);
	if (options.maxColumns !== undefined) settings.set("tools.outputMaxColumns", options.maxColumns);
	// A case that measures one bound raises the other out of the way, because a
	// summary stops at whichever it reaches first and a case that cannot say
	// which one stopped it proves neither.
	if (options.defaultLimit !== undefined) settings.set("read.defaultLimit", options.defaultLimit);
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
		const text = await readText(await toolFor(dir, 64, { defaultLimit: LINES_OUT_OF_THE_WAY }), "dense.ts");
		expect(text).toContain("elided");
		expect(text).toContain("handlerNumber0000");
	});

	it("holds a summary to the configured budget instead of rendering the whole projection", async () => {
		const byteBound = { defaultLimit: LINES_OUT_OF_THE_WAY };
		const small = Buffer.byteLength(await readText(await toolFor(dir, 8, byteBound), "dense.ts"), "utf-8");
		const large = Buffer.byteLength(await readText(await toolFor(dir, 64, byteBound), "dense.ts"), "utf-8");
		// The budget bounds the summary body; the elision footer and the budget
		// notice are added after it, so allow one notice of slack.
		expect(small).toBeLessThan(8 * 1024 + 512);
		expect(large).toBeGreaterThan(small * 4);
		expect(large).toBeLessThan(64 * 1024 + 512);
	});

	it("states the line that continues a summary the byte budget stopped", async () => {
		const text = await readText(await toolFor(dir, 8, { defaultLimit: LINES_OUT_OF_THE_WAY }), "dense.ts");
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

	it("stops a summary at the line default the caller never overrode, and says so", async () => {
		const text = await readText(await toolFor(dir, 1024, { defaultLimit: 40 }), "dense.ts");
		const notice = /\[Summary reached the (?<limit>\d+)-line default\. Use :(?<next>\d+) to continue\]/.exec(text);
		expect(notice).not.toBeNull();
		expect(notice?.groups?.limit).toBe("40");
		// Exactly the bound: 40 rendered units. The hashline header, the elision
		// footer and the notice are separate blocks, so the count is taken from the
		// units themselves rather than from the body's line count.
		const body = text.split("\n\n")[0] ?? "";
		const units = body.split("\n").filter(line => /^\d+[:-]/.test(line) || line === "…");
		expect(units.length).toBe(40);
		const next = Number(notice?.groups?.next);
		expect(next).toBeGreaterThan(1);
		expect(text).not.toContain(`${next}:`);
	});

	it("scales with the line default, so a summary is not billed by how dense the file is", async () => {
		const bytesAt = async (limit: number) =>
			Buffer.byteLength(await readText(await toolFor(dir, 1024, { defaultLimit: limit }), "dense.ts"), "utf-8");
		const [tight, loose] = [await bytesAt(40), await bytesAt(400)];
		expect(loose).toBeGreaterThan(tight * 4);
	});

	it("leaves a summary inside both bounds unannotated", async () => {
		const text = await readText(await toolFor(dir, 64), "small.ts");
		expect(text).toContain("handlerNumber0000");
		expect(text).not.toContain("output budget");
		expect(text).not.toContain("-line default");
	});

	it("clips a line wider than the column cap instead of ending the summary at it", async () => {
		const text = await readText(await toolFor(dir, 64, { maxColumns: 200 }), "giant.ts");
		expect(text).toContain(AFTER_GIANT);
		expect(text).not.toContain("output budget");
		expect(text).not.toContain("d".repeat(400));
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(64 * 1024);
	});

	it("still holds a summary with a giant line to a small budget", async () => {
		const text = await readText(await toolFor(dir, 8, { maxColumns: 200 }), "giant.ts");
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(8 * 1024 + 512);
	});
});
