/**
 * What an LSP card states, whoever draws it.
 *
 * WHY. The lsp renderer read the theme to decide what KIND of answer it had in hand: it matched the
 * theme's own error glyph against the result text and laid the card out from what it found, so the
 * card's structure depended on a preset a host chose. The view states the structure instead, and the
 * class this suite closes is a card whose shape is read out of prose: the action the tool reports
 * decides the shape, and every action the schema declares is swept below, so a new one turns this
 * red rather than silently falling to a wall of lines.
 *
 * WHAT THIS DOES NOT CATCH. Nothing here runs a language server, so no assertion proves what an
 * answer MEANS: `test/tools/lsp-regressions.test.ts` owns the tool half, including that the text a
 * card reads is the text the server produced. Appearance is the host's, so the bytes a terminal
 * draws are compared in `test/differential/the-lsp-card-draws-what-main-drew.test.ts` and not here.
 */

import { describe, expect, it } from "bun:test";
import { lspSchema } from "@veyyon/coding-agent/lsp/types";
import { type LspViewResult, lspToolView } from "@veyyon/coding-agent/lsp/view";
import type { FramedBlockView, HeadedBlockView, StatusRowView, ToolView, ViewLine, ViewSection } from "@veyyon/view";

const COLLAPSED = { expanded: false } as const;
const EXPANDED = { expanded: true } as const;

function framed(view: ToolView): FramedBlockView {
	expect(view.kind).toBe("framedBlock");
	return view as FramedBlockView;
}

function statusRow(view: ToolView): StatusRowView {
	expect(view.kind).toBe("statusRow");
	return view as StatusRowView;
}

function textOfLine(line: ViewLine): string {
	return line.map(span => span.text).join("");
}

function textOfSection(section: ViewSection): string[] {
	return section.lines.map(textOfLine);
}

/** Every row of a card's body, in order, with the group labels dropped. */
function bodyRows(view: ToolView): string[] {
	return framed(view).sections.flatMap(textOfSection);
}

/** The group a card labelled `Response`, which is where the server's answer sits. */
function responseSection(view: ToolView): ViewSection {
	const section = framed(view).sections.find(entry => entry.label === "Response");
	expect(section).toBeDefined();
	return section!;
}

function result(text: string, details?: LspViewResult["details"], isError?: boolean): LspViewResult {
	return {
		content: [{ type: "text", text }],
		...(details === undefined ? {} : { details }),
		...(isError === undefined ? {} : { isError }),
	};
}

/** Every action the tool's own schema declares, so a new one arrives covered. */
function declaredActions(): string[] {
	const source = lspSchema.get("action").expression;
	const actions = source.match(/[a-z_]+/g) ?? [];
	expect(actions).toContain("diagnostics");
	expect(actions).toContain("references");
	return [...new Set(actions)];
}

const DIAGNOSTICS_TEXT = [
	"Diagnostics: 2 error(s), 1 warning(s)",
	"src/a.ts:12:3 [error] Type 'string' is not assignable to 'number'",
	"src/a.ts:40:1 [error] Cannot find name 'foo'",
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

describe("an lsp card", () => {
	it("states the operation and the position the call asked about", () => {
		const row = statusRow(
			lspToolView.renderCall(
				{ action: "type_definition", file: "src/a.ts", line: 12, symbol: "compute" },
				COLLAPSED,
			),
		);
		expect(row.status).toBe("pending");
		expect(row.title).toBe("LSP");
		expect(row.description).toBe("type definition src/a.ts:12 (compute)");
	});

	it("states a rename's new name and whether it would be applied, beside the operation", () => {
		const row = statusRow(
			lspToolView.renderCall(
				{ action: "rename", file: "src/a.ts", line: 3, new_name: "next", apply: false },
				COLLAPSED,
			),
		);
		expect((row.meta ?? []).map(textOfLine)).toEqual(["new:next", "apply:false"]);
	});

	it("states a query with no position as the thing the call named", () => {
		const row = statusRow(lspToolView.renderCall({ action: "symbols", query: "Widget" }, COLLAPSED));
		expect(row.description).toBe("symbols Widget");
		// The query is the subject of the row, so it is not repeated as trailing detail.
		expect(row.meta).toBeUndefined();
	});

	it("states the request under the row that reports it", () => {
		const view = lspToolView.renderResult(
			result("No definition found", { action: "definition", success: true }),
			COLLAPSED,
			{ action: "definition", file: "src/a.ts", line: 12, symbol: "compute", apply: true },
		);
		expect(bodyRows(view)).toEqual(["src/a.ts", "line 12", "symbol: compute", "apply: true", "No definition found"]);
	});

	it("counts the diagnostics on the row and states one per line under it", () => {
		const view = lspToolView.renderResult(
			result(DIAGNOSTICS_TEXT, { action: "diagnostics", success: true }),
			EXPANDED,
		);
		const card = framed(view);
		expect((card.header.meta ?? []).map(textOfLine)).toEqual(["2 errors", "1 warning"]);
		expect(card.state).toBe("error");
		const rows = textOfSection(responseSection(view));
		expect(rows).toEqual([
			"src/a.ts:12:3 [error] Type 'string' is not assignable to 'number'",
			"src/a.ts:40:1 [error] Cannot find name 'foo'",
			"src/b.ts:7:9 [warning] 'value' is declared but never read",
		]);
	});

	it("names the file and the line of every diagnostic, so a host can open it there", () => {
		const view = lspToolView.renderResult(
			result(DIAGNOSTICS_TEXT, { action: "diagnostics", success: true }),
			EXPANDED,
		);
		const first = responseSection(view).lines[0]!;
		expect(first[0]).toMatchObject({ file: "src/a.ts", fileLine: 12, tone: "error" });
		const warning = responseSection(view).lines[2]!;
		expect(warning[0]).toMatchObject({ file: "src/b.ts", fileLine: 7, tone: "warning" });
	});

	it("reports warnings alone as a warning and no issues as a success", () => {
		const warned = framed(
			lspToolView.renderResult(
				result("Diagnostics: 0 error(s), 2 warning(s)\nsrc/b.ts:7:9 [warning] unused", {
					action: "diagnostics",
					success: true,
				}),
				EXPANDED,
			),
		);
		expect(warned.state).toBe("warning");
		expect((warned.header.meta ?? []).map(textOfLine)).toEqual(["2 warnings"]);

		const clean = framed(lspToolView.renderResult(result("OK", { action: "diagnostics", success: true }), COLLAPSED));
		expect(clean.state).toBe("success");
		expect((clean.header.meta ?? []).map(textOfLine)).toEqual(["no issues"]);
		// Nothing parsed as a diagnostic, so the card shows what the server sent rather than an empty group.
		expect(bodyRows(clean)).toEqual(["OK"]);
	});

	it("holds diagnostics back when collapsed and states how many, then reveals them expanded", () => {
		const collapsedCard = lspToolView.renderResult(
			result(
				[
					"Diagnostics: 5 error(s)",
					...Array.from({ length: 5 }, (_unused, index) => `src/a.ts:${index + 1}:1 [error] broken ${index}`),
				].join("\n"),
				{ action: "diagnostics", success: true },
			),
			COLLAPSED,
		);
		const collapsedSection = responseSection(collapsedCard);
		expect(collapsedSection.lines).toHaveLength(3);
		expect(collapsedSection.hidden).toEqual({
			count: 2,
			noun: { one: "diagnostic", many: "diagnostics" },
			revealable: true,
		});

		const expandedSection = responseSection(
			lspToolView.renderResult(
				result(
					[
						"Diagnostics: 5 error(s)",
						...Array.from({ length: 5 }, (_unused, index) => `src/a.ts:${index + 1}:1 [error] broken ${index}`),
					].join("\n"),
					{ action: "diagnostics", success: true },
				),
				EXPANDED,
			),
		);
		expect(expandedSection.lines).toHaveLength(5);
		expect(expandedSection.hidden).toBeUndefined();
	});

	it("states one row per reference, each naming its own file and line", () => {
		const view = lspToolView.renderResult(result(REFERENCES_TEXT, { action: "references", success: true }), EXPANDED);
		const card = framed(view);
		expect((card.header.meta ?? []).map(textOfLine)).toEqual(["4 found"]);
		const section = responseSection(view);
		expect(section.list).toBe(true);
		expect(textOfSection(section)).toEqual(["src/a.ts:12:3", "src/a.ts:44:10", "src/b.ts:2:1", "src/c.ts:99:5"]);
		expect(section.lines[3]![0]).toMatchObject({ file: "src/c.ts", fileLine: 99 });
	});

	it("keeps a symbol at the depth the server nested it", () => {
		const view = lspToolView.renderResult(result(SYMBOLS_TEXT, { action: "symbols", success: true }), EXPANDED);
		expect((framed(view).header.meta ?? []).map(textOfLine)).toEqual(["in src/a.ts"]);
		expect(textOfSection(responseSection(view))).toEqual([
			"C Widget line 4",
			"  ƒ render line 9",
			"  ƒ dispose line 21",
			"ƒ helper line 40",
		]);
	});

	it("states a hover's signature as source in its own language, with the prose either side", () => {
		const view = lspToolView.renderResult(result(HOVER_TEXT, { action: "hover", success: true }), EXPANDED);
		const sections = framed(view).sections;
		expect(sections.map(section => textOfSection(section))).toEqual([
			["Documentation for compute"],
			["function compute(input: string): number", "const cached: number"],
			["Returns the memoized result."],
		]);
		expect(sections[1]!.code).toEqual({ language: "ts" });
		// The prose after the block is the documentation, not a second copy of the signature.
		expect(textOfSection(sections[2]!)).not.toContain("function compute(input: string): number");
	});

	it("shows one line of a hover's source collapsed and says how many it kept back", () => {
		const collapsed = lspToolView.renderResult(result(HOVER_TEXT, { action: "hover", success: true }), COLLAPSED);
		const source = framed(collapsed).sections.find(section => section.code !== undefined);
		expect(source).toBeDefined();
		expect(textOfSection(source!)).toEqual(["function compute(input: string): number"]);
		expect(source!.hidden).toEqual({ count: 1, noun: { one: "line", many: "lines" }, revealable: true });
	});

	it("reads a hover as source even when the action says otherwise", () => {
		const view = lspToolView.renderResult(result(HOVER_TEXT, { action: "request", success: true }), EXPANDED);
		expect(framed(view).sections.some(section => section.code !== undefined)).toBe(true);
	});

	it("falls back to the server's own lines for an action with no shape of its own", () => {
		const view = lspToolView.renderResult(
			result("Language servers: typescript (ready)\n  note: ready means a client is live", {
				action: "status",
				success: true,
			}),
			EXPANDED,
		);
		expect(bodyRows(view)).toEqual(["Language servers: typescript (ready)", "  note: ready means a client is live"]);
	});

	it("holds the server's own lines back when collapsed and states how many", () => {
		const text = Array.from({ length: 9 }, (_unused, index) => `line ${index}`).join("\n");
		const section = responseSection(
			lspToolView.renderResult(result(text, { action: "capabilities", success: true }), COLLAPSED),
		);
		expect(textOfSection(section)).toEqual(["line 0", "line 1", "line 2", "line 3"]);
		expect(section.hidden).toEqual({ count: 5, noun: { one: "line", many: "lines" }, revealable: true });
	});

	it("reports a failure as an error and a result still arriving as running", () => {
		const failed = framed(
			lspToolView.renderResult(
				result("Error: no language server found", { action: "hover", success: false }, true),
				COLLAPSED,
			),
		);
		expect(failed.state).toBe("error");
		expect(failed.header.status).toBe("error");
		expect(failed.header.emblem).toBeUndefined();

		const arriving = framed(
			lspToolView.renderResult(
				result("Diagnostics: 1 error(s)\nsrc/a.ts:1:1 [error] broken", {
					action: "diagnostics",
					success: true,
				}),
				{ expanded: false, partial: true },
			),
		);
		expect(arriving.header.status).toBe("running");
		// The rail still reports what the server found; only the row says the card is still arriving.
		expect(arriving.state).toBe("error");
	});

	it("states a card with no text at all as having no result", () => {
		const view = lspToolView.renderResult({ content: [] }, COLLAPSED);
		expect(view.kind).toBe("headedBlock");
		const card = view as HeadedBlockView;
		expect(card.header?.status).toBe("warning");
		expect(card.lines.map(textOfLine)).toEqual(["No result"]);
	});

	it("draws every action the schema declares as a card with a body", () => {
		const unstated: string[] = [];
		for (const action of declaredActions()) {
			const view = lspToolView.renderResult(result(`answer for ${action}`, { action, success: true }), COLLAPSED, {
				action,
			} as never);
			const card = framed(view);
			expect(card.header.description).toBe(action.replace(/_/g, " "));
			if (bodyRows(view).length === 0) unstated.push(action);
		}
		expect(unstated).toEqual([]);
	});

	it("marks a symbol's line number as the run a narrow host keeps, and its kind and name as the subject", () => {
		const section = responseSection(
			lspToolView.renderResult(result(SYMBOLS_TEXT, { action: "symbols", success: true }), EXPANDED),
		);
		const spans = section.lines[0]!;
		const last = spans[spans.length - 1]!;
		expect(last.text).toBe("line 4");
		expect(last.tone).toBe("dim");
		// A host cutting the row to a narrow terminal keeps this run rather than the name's tail.
		expect(last.trailing).toBe(true);
		expect(spans.filter(span => span.tone === "accent").map(span => span.text)).toEqual(["C", "Widget"]);
	});

	it("tones the server's documentation and its plain answer as what each of them is", () => {
		const hover = framed(lspToolView.renderResult(result(HOVER_TEXT, { action: "hover", success: true }), EXPANDED));
		expect(hover.sections[0]!.lines.flat().every(span => span.tone === "muted")).toBe(true);

		const answer = responseSection(
			lspToolView.renderResult(result("typescript is ready", { action: "status", success: true }), EXPANDED),
		);
		expect(answer.lines.flat().every(span => span.tone === "output")).toBe(true);
	});

	it("shows no request group at all when the request states nothing to put in one", () => {
		const card = framed(
			lspToolView.renderResult(result("typescript is ready", { action: "status", success: true }), COLLAPSED, {
				action: "status",
			}),
		);
		expect(card.sections.every(section => section.lines.length > 0)).toBe(true);
		expect(card.sections).toHaveLength(1);
	});

	it("flattens a symbol the model spread over lines into the call row's own words", () => {
		const row = statusRow(
			lspToolView.renderCall({ action: "definition", line: 40, symbol: "foo\tbar\nbaz" }, COLLAPSED),
		);
		expect(row.description).toContain("foo");
		expect(row.description).toContain("baz");
		expect(row.description).not.toContain("\n");
		expect(row.description).not.toContain("\t");
	});

	it("shows one line of documentation collapsed and every line expanded, saying what it held back", () => {
		const text = [
			"First line of prose.",
			"Second line of prose.",
			"```ts",
			"const x = 1;",
			"```",
			"Trailing one.",
			"Trailing two.",
			"Trailing three.",
		].join("\n");
		const collapsed = framed(lspToolView.renderResult(result(text, { action: "hover", success: true }), COLLAPSED));
		expect(textOfSection(collapsed.sections[0]!)).toEqual(["First line of prose."]);
		expect(collapsed.sections[0]!.hidden).toEqual({
			count: 1,
			noun: { one: "line", many: "lines" },
			revealable: true,
		});
		const trailing = collapsed.sections[collapsed.sections.length - 1]!;
		expect(textOfSection(trailing)).toEqual(["Trailing one."]);
		expect(trailing.hidden?.count).toBe(2);

		const expanded = framed(lspToolView.renderResult(result(text, { action: "hover", success: true }), EXPANDED));
		expect(textOfSection(expanded.sections[0]!)).toEqual(["First line of prose.", "Second line of prose."]);
		expect(expanded.sections[0]!.hidden).toBeUndefined();
		expect(textOfSection(expanded.sections[expanded.sections.length - 1]!)).toEqual([
			"Trailing one.",
			"Trailing two.",
			"Trailing three.",
		]);
	});

	it("reads the text parts of a result and nothing else", () => {
		const view = lspToolView.renderResult(
			{
				content: [
					{ type: "text", text: "typescript is ready" },
					{ type: "resource", text: "a payload no card states" },
				],
				details: { action: "status", success: true },
			},
			EXPANDED,
		);
		expect(bodyRows(view)).toEqual(["typescript is ready"]);
	});

	it("takes the shape from the action even when the answer states no summary of its own", () => {
		const references = responseSection(
			lspToolView.renderResult(
				result("  src/a.ts:12:3\n  src/b.ts:2:1", { action: "references", success: true }),
				EXPANDED,
			),
		);
		expect(references.list).toBe(true);
		expect(textOfSection(references)).toEqual(["src/a.ts:12:3", "src/b.ts:2:1"]);

		const symbols = responseSection(
			lspToolView.renderResult(
				result("C Widget @ line 4\n  ƒ render @ line 9", { action: "symbols", success: true }),
				EXPANDED,
			),
		);
		expect(symbols.list).toBe(true);
		expect(textOfSection(symbols)).toEqual(["C Widget line 4", "  ƒ render line 9"]);
	});

	it("states a reference as the place a host opens", () => {
		const section = responseSection(
			lspToolView.renderResult(result(REFERENCES_TEXT, { action: "references", success: true }), EXPANDED),
		);
		const span = section.lines[0]![0]!;
		expect(span.text).toBe("src/a.ts:12:3");
		expect(span.tone).toBe("accent");
		expect(span.file).toBe("src/a.ts");
		expect(span.fileLine).toBe(12);
	});

	it("lower-cases a severity the server shouted, and widens the tabs in what it said", () => {
		const section = responseSection(
			lspToolView.renderResult(
				result("Diagnostics: 1 error(s)\nsrc/\ta.ts:12:3 [ERROR] Type\t'string' is not assignable", {
					action: "diagnostics",
					success: true,
				}),
				EXPANDED,
			),
		);
		const spans = section.lines[0]!;
		expect(spans.map(span => span.text).join("")).not.toContain("\t");
		expect(spans.some(span => span.text === "[error]")).toBe(true);
		expect(spans[0]!.tone).toBe("error");
	});

	it("states a diagnostic with no message as its location and severity alone", () => {
		const section = responseSection(
			lspToolView.renderResult(
				result("Diagnostics: 1 error(s)\nsrc/a.ts:12:3 [error]", { action: "diagnostics", success: true }),
				EXPANDED,
			),
		);
		expect(section.lines[0]!.map(span => span.text)).toEqual(["src/a.ts:12:3", " ", "[error]"]);
	});

	it("cuts a message longer than a row states to the width a row states", () => {
		const long = "very long message ".repeat(30).trim();
		const section = responseSection(
			lspToolView.renderResult(
				result(`Diagnostics: 1 error(s)\nsrc/a.ts:1:1 [error] ${long}`, { action: "diagnostics", success: true }),
				EXPANDED,
			),
		);
		const message = section.lines[0]!.at(-1)!.text;
		expect(message.length).toBeLessThan(long.length);
		expect(message.endsWith("…")).toBe(true);
	});

	it("keeps the rows a diagnostic answer stated when none of them parses as one", () => {
		const section = responseSection(
			lspToolView.renderResult(
				result("Diagnostics: 1 error(s)\n  src/a.ts:12:3 something\tthe tool worded itself", {
					action: "diagnostics",
					success: true,
				}),
				EXPANDED,
			),
		);
		expect(section.list).toBe(true);
		const row = textOfSection(section);
		expect(row).toHaveLength(1);
		expect(row[0]).toStartWith("src/a.ts:12:3 something");
		expect(row[0]).toEndWith("the tool worded itself");
		// The tab the tool's own line carried is widened before a host ever sees the row.
		expect(row[0]).not.toContain("\t");
	});

	it("widens the tabs in a plain answer and in the request that asked for it", () => {
		const card = framed(
			lspToolView.renderResult(result("ready\tnow", { action: "status", success: true }), EXPANDED, {
				action: "hover",
				file: "src/\ta.ts",
			}),
		);
		expect(bodyRows(card).join("\n")).not.toContain("\t");
	});
});
