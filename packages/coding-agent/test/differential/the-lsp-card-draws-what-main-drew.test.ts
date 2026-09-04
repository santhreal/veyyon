/**
 * The LSP card draws what main's renderer drew.
 *
 * The pending row of every call shape is compared as terminal bytes and is identical. The result
 * card was RESTRUCTURED, so what survived is compared as bytes -- the rail colour every state asks
 * for, the request group, the section label, and a diagnostic row composed out of main's OWN
 * coloured runs -- and every deliberate difference is a pinned exception cell asserting BOTH arms
 * rather than a silent waiver:
 *
 *  - The header is a status row (`LSP: diagnostics`) with what the answer found as trailing meta,
 *    where main wrote `LSP diagnostics` as plain text and opened the body with a summary row of its
 *    own carrying a severity glyph, the counts and the expand hint.
 *  - A diagnostic is one row: location, severity, message. Main split the message onto a second row
 *    when expanded and dropped the severity label when collapsed.
 *  - An info is toned by what it means, where main drew every severity below a warning in the colour
 *    it drew a plain location in. Its severity label and message are still main's bytes, and an
 *    error, a warning and a hint are byte-identical rows.
 *  - References are one row per location, each naming the file and the position a host would open.
 *    Main grouped them by file, counted the locations per file, nested them two levels, spelled the
 *    position in words, and cut each file's tree separately when collapsed.
 *  - Symbols are one flat list at the indent the server nested them with. Main drew a connector per
 *    level, split the line number onto its own row when expanded, and dropped every nested symbol
 *    when collapsed.
 *  - A hover's signature carries the fence's own syntax highlighting; main's markdown block drew it
 *    as plain text. The text is identical byte for byte once the styling is stripped.
 *  - A hover's prose after the block is stated once. Main sliced its "after" text from the OPENING
 *    fence, so its card drew the whole block and the closing fence again as documentation.
 *  - An answer with no shape of its own is the server's own lines. Main drew the first line as a
 *    title row and the rest as a tree, labelled `Output` when expanded.
 *  - A failed call frames on the error rail. Main kept the neutral rail and put the failure in a
 *    body glyph only.
 *
 * WHAT THIS SUITE DOES NOT CATCH. It never calls `execute()`, so nothing here proves what a language
 * server answered or that the text a card reads is the text the tool produced:
 * `test/tools/lsp-regressions.test.ts` owns the tool half and `LspTool`'s own sanitization, and
 * `test/an-lsp-card-states-what-the-server-answered.test.ts` owns what the card claims for each
 * action. A card whose `details.action` changed meaning would be laid out identically by both arms.
 *
 * The comparison runs through `test/differential/harness.ts`, whose header states the frozen oracle,
 * the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import path from "node:path";
import type { RenderResultOptions } from "@veyyon/agent-core";
import type { LspParams } from "@veyyon/coding-agent/lsp/types";
import { type LspViewResult, lspToolView } from "@veyyon/coding-agent/lsp/view";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { lspToolRenderer } from "../oracles/lsp-main-renderer";
import { renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

/** A width no fixture reaches, so a render at it is the card before any cut. */
const UNCUT = 200;

const WIDTHS = [UNCUT, WIDTH, 40];

/** The frames a comparison is taken on: no frame at all, an even one and an odd one. */
const FRAMES = [undefined, 0, 3] as const;

/** The one column main opened a diagnostic's tree with beyond the columns the host spends. */
const MAIN_TREE_LEAD = 1;

const DIAGNOSTICS_TEXT = [
	"Diagnostics: 2 error(s), 1 warning(s)",
	"src/a.ts:12:3 [error] Type 'string' is not assignable to 'number'",
	"src/b.ts:7:9 [warning] 'value' is declared but never read",
].join("\n");

const REFERENCES_TEXT = [
	"Found 4 reference(s):",
	"  src/a.ts:12:3",
	"    const value = compute();",
	"  src/a.ts:44:10",
	"  src/b.ts:2:1",
	"  src/c.ts:99:5",
].join("\n");

const SYMBOLS_TEXT = [
	"Symbols in src/a.ts:",
	"C Widget @ line 4",
	"  ƒ render @ line 9",
	"  ƒ dispose @ line 21",
	"ƒ helper @ line 40",
].join("\n");

const HOVER_TEXT = [
	"Documentation for compute",
	"```ts",
	"function compute(input: string): number",
	"const cached: number",
	"```",
	"Returns the memoized result.",
].join("\n");

const STATUS_TEXT = ["Language servers: typescript (ready)", "  note: a client is live", "lspmux: active"].join("\n");

function result(text: string, action: string, options: { isError?: boolean } = {}): LspViewResult {
	return {
		content: [{ type: "text", text }],
		details: { action, success: options.isError !== true },
		...(options.isError === undefined ? {} : { isError: options.isError }),
	};
}

function hostOptions(expanded: boolean, frame: number | undefined, partial = false): RenderResultOptions {
	return { expanded, isPartial: partial, spinnerFrame: frame };
}

function viewRows(
	value: LspViewResult,
	args: LspParams | undefined,
	expanded: boolean,
	width = UNCUT,
	frame?: number,
	partial = false,
): string[] {
	return renderCompLines(
		drawToolView(lspToolView.renderResult(value, { expanded, partial, frame }, args), theme, frame),
		width,
	);
}

function oracleRows(
	value: LspViewResult,
	args: LspParams | undefined,
	expanded: boolean,
	width = UNCUT,
	frame?: number,
	partial = false,
): string[] {
	return renderCompLines(
		lspToolRenderer.renderResult(
			{ ...value, content: value.content ?? [] },
			hostOptions(expanded, frame, partial),
			theme,
			args,
		),
		width,
	);
}

function plain(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row));
}

/** One row's own text: what a reader sees, with the block's rail chrome dropped. */
function content(row: string): string {
	const glyph = theme.symbol("block.rail");
	const stripped = Bun.stripANSI(row);
	const at = stripped.indexOf(glyph);
	return (at < 0 ? stripped : stripped.slice(at + glyph.length)).trim();
}

/** The chrome a block opens every row with: the rail glyph in the state's colour, and one space. */
function railOf(row: string): string {
	const glyph = theme.symbol("block.rail");
	const at = row.indexOf(glyph);
	expect(at).toBeGreaterThanOrEqual(0);
	const rest = row.slice(at + glyph.length);
	// The escape that closes the rail's colour, then the space `renderOutputBlock` puts after it.
	const close = /^\u001b\[[0-9;]*m/.exec(rest)?.[0] ?? "";
	return row.slice(0, at + glyph.length + close.length + 1);
}

/** One row with its rail kept and the leading columns of its body dropped. */
function dedent(row: string, columns: number): string {
	const rail = railOf(row);
	const body = row.slice(rail.length);
	expect(body.slice(0, columns)).toBe(" ".repeat(columns));
	return `${rail}${body.slice(columns)}`;
}

/** The index of the row that labels the server's answer, which both arms draw. */
function responseAt(rows: readonly string[]): number {
	const at = plain(rows).findIndex(row => row.trimEnd().endsWith("Response"));
	expect(at).toBeGreaterThan(0);
	return at;
}

/** The rows a card states the request in: everything between its header and the answer's label. */
function requestRows(rows: readonly string[]): string[] {
	return rows.slice(1, responseAt(rows));
}

/** The coloured runs of a row, each one a span the card asked for. */
function runsOf(row: string): string[] {
	return row.match(/\u001b\[38;2;[0-9;]+m[^\u001b]*\u001b\[39m/g) ?? [];
}

/** The last coloured run of a row, which is where main put a diagnostic's message. */
function lastRun(row: string): string {
	const runs = runsOf(row);
	expect(runs.length).toBeGreaterThan(0);
	return runs[runs.length - 1]!;
}

/** How many coloured runs a row spends, which is how much styling it carries. */
function colourRuns(row: string): number {
	return (row.match(/\u001b\[38;2;[0-9;]+m/g) ?? []).length;
}

describe("lsp tool differential", () => {
	it("draws the pending row of every call shape", () => {
		const calls: LspParams[] = [
			{ action: "diagnostics", file: "src/a.ts" },
			{ action: "hover", file: "src/a.ts", line: 12, symbol: "compute" },
			{ action: "references", file: "src/a.ts", line: 12 },
			{ action: "rename", file: "src/a.ts", line: 12, symbol: "compute", new_name: "next" },
			{ action: "rename_file", file: "src/a.ts", new_name: "src/b.ts", apply: false },
			{ action: "symbols", query: "Widget" },
			{ action: "symbols", file: "src/a.ts", query: "Widget" },
			{ action: "request", payload: '{"method":"custom"}' },
			{ action: "symbols", file: "src/a.ts", query: "W".repeat(120) },
			{ action: "hover", file: path.join(homedir(), "repo", "src", "a.ts"), line: 12 },
			{ action: "definition", file: path.join(homedir(), "repo", "src", "a.ts") },
			// A call whose action a rebuilt transcript lost, which both arms word themselves.
			{} as LspParams,
			{ action: "status" },
			{ action: "definition", line: 40, symbol: "foo\tbar\nbaz" },
		];
		for (const args of calls) {
			for (const width of WIDTHS) {
				for (const frame of FRAMES) {
					const view = renderCompLines(
						drawToolView(lspToolView.renderCall(args, { expanded: false, frame }), theme, frame),
						width,
					);
					const oracle = renderCompLines(
						lspToolRenderer.renderCall(args, hostOptions(false, frame), theme),
						width,
					);
					expect(view).toEqual(oracle);
				}
			}
		}
	});

	it("keeps the rail colour every answered state asks for", () => {
		const cases: Array<{ value: LspViewResult; args?: LspParams }> = [
			{ value: result(DIAGNOSTICS_TEXT, "diagnostics"), args: { action: "diagnostics", file: "src/a.ts" } },
			{ value: result("Diagnostics: 0 error(s), 2 warning(s)\nsrc/b.ts:7:9 [warning] unused", "diagnostics") },
			{ value: result("OK", "diagnostics") },
			{ value: result(HOVER_TEXT, "hover") },
			{ value: result(REFERENCES_TEXT, "references") },
			{ value: result(SYMBOLS_TEXT, "symbols") },
			{ value: result(STATUS_TEXT, "status") },
		];
		for (const entry of cases) {
			for (const expanded of [false, true]) {
				const view = viewRows(entry.value, entry.args, expanded);
				const oracle = oracleRows(entry.value, entry.args, expanded);
				const rail = railOf(oracle[0] ?? "");
				expect(railOf(view[0] ?? "")).toBe(rail);
				// Every row of both arms carries that rail, so the whole card frames alike.
				for (const row of [...view, ...oracle]) expect(railOf(row)).toBe(rail);
			}
		}
	});

	it("states the request and the answer's label in main's own bytes", () => {
		const args: LspParams = {
			action: "rename",
			file: "src/a.ts",
			line: 12,
			symbol: "compute",
			query: "Widget",
			new_name: "next",
			apply: true,
		};
		const value = result("Renamed 3 occurrence(s)", "rename");
		for (const expanded of [false, true]) {
			const view = viewRows(value, args, expanded);
			const oracle = oracleRows(value, args, expanded);
			expect(requestRows(view)).toEqual(requestRows(oracle));
			expect(view[responseAt(view)]).toBe(oracle[responseAt(oracle)]);
		}
	});

	it("draws a diagnostic of every severity out of main's own coloured runs", () => {
		// One of each severity the tool words, and a message past the width a row truncates at.
		const value = result(
			[
				"Diagnostics: 2 error(s), 1 warning(s)",
				"src/a.ts:12:3 [error] Type 'string' is not assignable to 'number'",
				"src/b.ts:7:9 [warning] 'value' is declared but never read",
				"src/c.ts:1:1 [info] consider a named export",
				"src/d.ts:2:2 [hint] prefer const",
				`src/e.ts:3:3 [error] ${"very long message ".repeat(20)}`,
			].join("\n"),
			"diagnostics",
		);
		const view = viewRows(value, undefined, true);
		const oracle = oracleRows(value, undefined, true);
		// Main: a summary row, then a location row and a message row for each diagnostic.
		const oracleBody = oracle.slice(responseAt(oracle) + 1);
		const viewBody = view.slice(responseAt(view) + 1);
		expect(viewBody).toHaveLength(5);
		expect(oracleBody).toHaveLength(1 + viewBody.length * 2);
		// Every severity but one is main's own bytes: an error, a warning and a hint, plus a message
		// past the width a row truncates at, which both arms cut alike.
		for (const index of [0, 1, 3, 4]) {
			const location = oracleBody[1 + index * 2]!;
			const message = oracleBody[2 + index * 2]!;
			expect(viewBody[index]).toBe(`${dedent(location, MAIN_TREE_LEAD)} ${lastRun(message)}`);
		}

		// EXCEPTION. An info is toned by what it means, where main drew it in the colour it drew a
		// plain location in. Run 0 is the rail and run 1 the tree branch, so a row's words start at 2.
		expect(runsOf(viewBody[2]!)[2]).toBe(theme.fg("infoAccent", "src/c.ts:1:1"));
		expect(runsOf(oracleBody[5]!)[2]).toBe(theme.fg("accent", "src/c.ts:1:1"));
		// Its severity label and message are still main's own bytes.
		expect(runsOf(viewBody[2]!).slice(3)).toEqual([theme.fg("dim", "[info]"), lastRun(oracleBody[6]!)]);
	});

	it("draws a hover's signature at main's own column, with main's own text", () => {
		const value = result(HOVER_TEXT, "hover");
		const view = viewRows(value, undefined, true);
		const oracle = oracleRows(value, undefined, true);
		for (const line of ["function compute(input: string): number", "const cached: number"]) {
			const fromView = view.filter(row => content(row) === line);
			// Main drew the block twice; the second copy is the markdown block itself.
			const fromOracle = oracle.filter(row => content(row) === line);
			expect(fromView).toHaveLength(1);
			expect(fromOracle).toHaveLength(2);
			expect(Bun.stripANSI(fromView[0]!)).toBe(Bun.stripANSI(fromOracle[1]!));
		}
	});

	it("draws a symbol's kind and name in main's own coloured runs", () => {
		const value = result(SYMBOLS_TEXT, "symbols");
		// Collapsed, main drew a symbol as one row too, so the runs line up.
		const view = viewRows(value, undefined, false);
		const oracle = oracleRows(value, undefined, false);
		const viewRow = view[responseAt(view) + 1]!;
		const oracleRow = oracle[responseAt(oracle) + 2]!;
		expect(content(viewRow)).toBe("├─ C Widget line 4");
		expect(content(oracleRow)).toBe("├─ C Widget line 4");
		// The tree branch, the kind and the name are the same bytes; the trailing number is not.
		expect(runsOf(viewRow).slice(0, 3)).toEqual(runsOf(oracleRow).slice(0, 3));
		expect(lastRun(viewRow)).toBe(theme.fg("dim", "line 4"));
		expect(lastRun(oracleRow)).toBe(theme.fg("muted", "line 4"));
	});

	it("draws a hover's documentation in main's own bytes", () => {
		const value = result(HOVER_TEXT, "hover");
		const view = viewRows(value, undefined, true);
		const oracle = oracleRows(value, undefined, true);
		const line = "Documentation for compute";
		const fromView = view.find(row => content(row) === line)!;
		const fromOracle = oracle.find(row => content(row) === line)!;
		expect(fromView).toBe(dedent(fromOracle, MAIN_TREE_LEAD));
	});

	it("reads the request the result recorded when the call's own arguments are gone", () => {
		const value: LspViewResult = {
			content: [{ type: "text", text: "Renamed 3 occurrence(s)" }],
			details: {
				action: "rename",
				success: true,
				request: { action: "rename", file: "src/a.ts", line: 12, symbol: "compute", new_name: "next", apply: true },
			},
		};
		const view = viewRows(value, undefined, true);
		const oracle = oracleRows(value, undefined, true);
		expect(requestRows(view)).toEqual(requestRows(oracle));
		expect(plain(requestRows(view))).toEqual([
			"▏  src/a.ts",
			"▏  line 12",
			"▏  symbol: compute",
			"▏  new name: next",
			"▏  apply: true",
		]);
	});

	/**
	 * EXCEPTION CELL. The header is a status row and what the answer found is its trailing meta,
	 * where main wrote the operation as plain text and opened the body with a summary row of its own.
	 */
	it("states what the answer found beside the operation, where main opened the body with a summary row", () => {
		const value = result(DIAGNOSTICS_TEXT, "diagnostics");
		const oracle = plain(oracleRows(value, undefined, false));
		expect(oracle[0]).toBe("▏  LSP diagnostics");
		expect(oracle[2]).toBe("▏  ✗ 2 errors · 1 warning");

		const view = plain(viewRows(value, undefined, false));
		expect(view[0]).toBe("▏ LSP: diagnostics 2 errors · 1 warning");
		// The counts are stated once: the body opens on the first diagnostic.
		expect(view[2]).toContain("src/a.ts:12:3");
		expect(view.filter(row => row.includes("2 errors"))).toHaveLength(1);

		// One of each: both arms word the count singular.
		const one = result("Diagnostics: 1 error(s), 1 warning(s)\nsrc/a.ts:1:1 [error] bad", "diagnostics");
		expect(plain(oracleRows(one, undefined, false))[2]).toBe("▏  ✗ 1 error · 1 warning");
		expect(plain(viewRows(one, undefined, false))[0]).toBe("▏ LSP: diagnostics 1 error · 1 warning");

		// A clean answer states that it found nothing, where main dropped the counts entirely.
		const clean = result("Diagnostics: 0 error(s), 0 warning(s)", "diagnostics");
		expect(plain(oracleRows(clean, undefined, false))[2]).not.toContain("no issues");
		expect(plain(viewRows(clean, undefined, false))[0]).toBe("▏ LSP: diagnostics no issues");
	});

	/**
	 * EXCEPTION CELL. A diagnostic is one row, severity included, collapsed or expanded. Main split
	 * the message onto a second row when expanded and dropped the severity label when collapsed.
	 */
	it("keeps a diagnostic on one row with its severity, where main split the message off", () => {
		const value = result(DIAGNOSTICS_TEXT, "diagnostics");
		const oracleExpanded = plain(oracleRows(value, undefined, true));
		expect(oracleExpanded[3]).toBe("▏   ├─ src/a.ts:12:3 [error]");
		expect(oracleExpanded[4]).toBe("▏   │  Type 'string' is not assignable to 'number'");
		const oracleCollapsed = plain(oracleRows(value, undefined, false));
		expect(oracleCollapsed[3]).toBe("▏   ├─ src/a.ts:12:3 Type 'string' is not assignable to 'number'");

		for (const expanded of [false, true]) {
			const view = plain(viewRows(value, undefined, expanded));
			expect(view[2]).toBe("▏  ├─ src/a.ts:12:3 [error] Type 'string' is not assignable to 'number'");
			expect(view[3]).toBe("▏  └─ src/b.ts:7:9 [warning] 'value' is declared but never read");
		}
	});

	/**
	 * EXCEPTION CELL. References are one row per location, each naming the file and the position a
	 * host would open. Main grouped them by file, counted per file, nested them two levels and
	 * spelled the position in words.
	 */
	it("states one row per reference, where main grouped them by file", () => {
		const value = result(REFERENCES_TEXT, "references");
		const oracle = plain(oracleRows(value, undefined, true));
		expect(oracle[3]).toBe("▏   ├─ src/a.ts 2 references");
		expect(oracle[4]).toBe("▏   │  ├─ line 12, col 3");
		expect(oracle[5]).toBe("▏   │  │  at src/a.ts:12:3");

		const view = viewRows(value, undefined, true);
		expect(view.slice(responseAt(view) + 1).map(row => content(row).replace(/^[├└]─ /, ""))).toEqual([
			"src/a.ts:12:3",
			"src/a.ts:44:10",
			"src/b.ts:2:1",
			"src/c.ts:99:5",
		]);
	});

	/**
	 * EXCEPTION CELL. A collapsed reference card holds the rest back as one note on the closing
	 * branch of one list. Main cut every file's tree separately and wrote the expand hint into its
	 * summary row.
	 */
	it("holds references back as one note, where main cut each file's own tree", () => {
		const value = result(REFERENCES_TEXT, "references");
		const oracle = plain(oracleRows(value, undefined, false));
		expect(oracle[2]).toBe("▏   4 found▸ Ctrl+O expand");
		expect(oracle[5]).toBe("▏   │  └─ … 1 more");
		expect(oracle).toHaveLength(10);

		const view = plain(viewRows(value, undefined, false));
		expect(view).toHaveLength(6);
		expect(view[5]).toBe("▏  └─ … 1 more reference");
		// The count is stated in the header, so the note carries no hint of its own.
		expect(view[0]).toBe("▏ LSP: references 4 found");
		expect(view.some(row => row.includes("Ctrl+O"))).toBe(false);
	});

	/**
	 * EXCEPTION CELL. Symbols are one flat list at the server's own indent. Main drew a connector per
	 * level, split the line number onto its own row when expanded, and dropped every nested symbol
	 * when collapsed.
	 */
	it("keeps a symbol's own indent in one list, where main drew a connector per level", () => {
		const value = result(SYMBOLS_TEXT, "symbols");
		const oracle = plain(oracleRows(value, undefined, true));
		expect(oracle.slice(3)).toEqual([
			"▏   ├─ C Widget",
			"▏   │  line 4",
			"▏   │  ├─ ƒ render",
			"▏   │  │  line 9",
			"▏   │  └─ ƒ dispose",
			"▏   │     line 21",
			"▏   └─ ƒ helper",
			"▏      line 40",
		]);

		const view = plain(viewRows(value, undefined, true));
		// Which file the symbols are from heads the card, where main opened the body with it.
		expect(view[0]).toBe("▏ LSP: symbols in src/a.ts");
		expect(oracle[2]).toBe("▏  i in src/a.ts");
		expect(view.slice(2)).toEqual([
			"▏  ├─ C Widget line 4",
			"▏  ├─   ƒ render line 9",
			"▏  ├─   ƒ dispose line 21",
			"▏  └─ ƒ helper line 40",
		]);

		// Collapsed, main kept the top level only; the view keeps the head of the list and says so.
		const oracleCollapsed = plain(oracleRows(value, undefined, false));
		expect(oracleCollapsed.slice(3)).toEqual(["▏   ├─ C Widget line 4", "▏   └─ ƒ helper line 40"]);
		const viewCollapsed = plain(viewRows(value, undefined, false));
		expect(viewCollapsed.slice(2)).toEqual([
			"▏  ├─ C Widget line 4",
			"▏  ├─   ƒ render line 9",
			"▏  ├─   ƒ dispose line 21",
			"▏  └─ … 1 more symbol",
		]);
	});

	/**
	 * EXCEPTION CELL. Main sliced a hover's trailing prose from the OPENING fence, so its card drew
	 * the code block and the closing fence again as documentation. The view states each part once,
	 * and styles the signature with the fence's own language.
	 */
	it("states a hover's prose once, where main repeated the block after it", () => {
		const value = result(HOVER_TEXT, "hover");
		const oracle = oracleRows(value, undefined, true);
		expect(plain(oracle).slice(2)).toEqual([
			"▏  i ts",
			"▏   Documentation for compute",
			"▏     function compute(input: string): number",
			"▏     const cached: number",
			"▏   ts",
			"▏  function compute(input: string): number",
			"▏  const cached: number",
			"▏  ```",
			"▏  Returns the memoized result.",
		]);
		// Main's markdown block drew the signature as plain text.
		const oracleSignature = oracle.findLast(row => content(row) === "const cached: number")!;

		const view = viewRows(value, undefined, true);
		// The fence's language heads the card, where main opened the body with it.
		expect(plain(view)[0]).toBe("▏ LSP: hover ts");
		expect(plain(oracle)[2]).toBe("▏  i ts");
		expect(plain(view).slice(2)).toEqual([
			"▏  Documentation for compute",
			"▏  function compute(input: string): number",
			"▏  const cached: number",
			"▏  Returns the memoized result.",
		]);
		expect(view.some(row => content(row).includes("```"))).toBe(false);
		// The view styles it with the language the fence declared, which main's block did not read.
		const viewSignature = view.find(row => content(row) === "const cached: number")!;
		expect(Bun.stripANSI(viewSignature)).toBe(Bun.stripANSI(oracleSignature));
		expect(colourRuns(viewSignature)).toBeGreaterThan(colourRuns(oracleSignature));
	});

	/**
	 * EXCEPTION CELL. An answer with no shape of its own is the server's own lines. Main drew the
	 * first line as a title row and the rest as a tree, labelled `Output` when expanded.
	 */
	it("states the server's own lines, where main drew a title row and a tree", () => {
		const value = result(STATUS_TEXT, "status");
		const oracleExpanded = plain(oracleRows(value, undefined, true));
		expect(oracleExpanded.slice(2)).toEqual([
			"▏  i Output",
			"▏   ├─ Language servers: typescript (ready)",
			"▏   ├─   note: a client is live",
			"▏   └─ lspmux: active",
		]);
		const oracleCollapsed = plain(oracleRows(value, undefined, false));
		expect(oracleCollapsed[2]).toBe("▏  i Language servers: typescript (ready)▸ Ctrl+O expand");

		for (const expanded of [false, true]) {
			const view = plain(viewRows(value, undefined, expanded));
			expect(view.slice(2)).toEqual([
				"▏  Language servers: typescript (ready)",
				"▏    note: a client is live",
				"▏  lspmux: active",
			]);
			expect(view[0]).toBe("▏ LSP: status");
		}
	});

	/**
	 * EXCEPTION CELL. A failed call frames on the error rail and its header carries the failure
	 * glyph. Main kept the neutral rail and marked the failure in the body only.
	 */
	it("frames a failed call on the error rail, where main kept the neutral one", () => {
		const value = result("Error: no language server found", "hover", { isError: true });
		const view = viewRows(value, undefined, false);
		const oracle = oracleRows(value, undefined, false);
		expect(railOf(oracle[0] ?? "")).toBe(railOf(oracleRows(result("OK", "hover"), undefined, false)[0] ?? ""));
		expect(railOf(view[0] ?? "")).toBe(`${theme.fg("error", theme.symbol("block.rail"))} `);

		expect(plain(oracle)).toEqual(["▏ ✗ LSP hover", "▏  Response", "▏  ✗ Error: no language server found"]);
		expect(plain(view)).toEqual(["▏ ✗ LSP: hover", "▏  Response", "▏  Error: no language server found"]);
	});

	it("draws a card whose result carries no details at all", () => {
		const value: LspViewResult = { content: [{ type: "text", text: "No definition found" }] };
		const args: LspParams = { action: "definition", file: "src/a.ts", line: 3 };
		for (const expanded of [false, true]) {
			const view = viewRows(value, args, expanded);
			const oracle = oracleRows(value, args, expanded);
			expect(requestRows(view)).toEqual(requestRows(oracle));
			expect(railOf(view[0] ?? "")).toBe(railOf(oracle[0] ?? ""));
			expect(content(view[responseAt(view) + 1] ?? "")).toBe("No definition found");
		}
	});

	it("draws a result with no text at all in both arms", () => {
		const value: LspViewResult = { content: [] };
		const args: LspParams = { action: "hover", file: "src/a.ts" };
		for (const expanded of [false, true]) {
			const view = plain(viewRows(value, args, expanded));
			const oracle = plain(oracleRows(value, args, expanded));
			expect(view[0]).toContain("LSP");
			expect(oracle[0]).toContain("LSP");
			expect(view.length).toBeGreaterThan(1);
			expect(oracle.length).toBeGreaterThan(1);
		}
	});
});
