/**
 * The `search` card draws what main's dispatcher drew, for every search type and for a call that
 * names none.
 *
 * WHAT THIS SUITE OWNS. `search` is one tool over three searches, so its entry was never a card: it
 * read the type off the call, or off the result's details, and handed the card to the file, text or
 * structure view. Those three have their own suites beside this one, so what is compared here is the
 * dispatch -- which view a type reaches, which of the two sources the type is read from, and the three
 * rows the dispatcher draws itself: a call whose type has not arrived, a type that is not one of the
 * three, and a failure that named no type at all.
 *
 * THE DEFECT CLASS. A dispatcher that routes a type to the wrong card, or drops one, is invisible to
 * the sub-view suites: each of them passes on the card it owns while the tool draws the wrong one. So
 * the type union is resolved from `searchSchema` at run time and every member is dispatched, and each
 * type's output is required to differ from every other's -- a dispatcher that collapsed two types onto
 * one card would otherwise pass. A fourth type added to the schema lands red here until it is routed.
 *
 * ONE DIFFERENCE IS ASSERTED AS AN EXCEPTION CELL. The two rows the dispatcher draws itself, which
 * main built with `new Text(text, 1, 0)`: the pad indented them one column past every other tool's
 * row, and a view is drawn with no pad, so each row moves left and nothing else changes. It is the
 * same pad `file_search` carried and the same exception its suite records. Every other cell asserts
 * equality, because the sub-views are the same modules in both arms.
 *
 * WHAT IT DOES NOT CATCH. Nothing here asserts what a sub-card contains -- that is each sub-view's
 * own suite. A type whose card is wrong in both arms is wrong identically and passes. Two mutants are
 * equivalent rather than uncaught: `isError === true` spelled as a truthiness test, and
 * `context.partial === true` spelled `Boolean(context.partial)`, both of which draw the same card for
 * every value the two fields are declared to hold.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/core/render-utils";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import type { FileSearchDetails } from "@veyyon/coding-agent/tools/search/file-search";
import { type SearchToolDetails, type SearchToolInput, searchSchema } from "@veyyon/coding-agent/tools/search/search";
import { searchToolView } from "@veyyon/coding-agent/tools/search/search-view";
import type { StructureSearchDetails } from "@veyyon/coding-agent/tools/search/structure-search";
import type { TextSearchDetails } from "@veyyon/coding-agent/tools/search/text-search";
import * as searchOracle from "../oracles/search-main-renderer";
import { HOST_COLLAPSED, HOST_EXPANDED, renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

/** The production entry, which is the dispatcher this suite compares. */
const production = toolRenderers.search;

type SearchResult = { content: Array<{ type: string; text?: string }>; details?: SearchToolDetails; isError?: boolean };

const HOST_PARTIAL: RenderResultOptions = { expanded: false, isPartial: true };

/** A width at which no card in either arm cuts anything, so a difference is a dispatch difference. */
const WIDE = 200;

function newCall(args: unknown, options: RenderResultOptions, width = WIDE): string[] {
	return renderCompLines(production.renderCall(args, options, theme), width);
}

function oldCall(args: unknown, options: RenderResultOptions, width = WIDE): string[] {
	return renderCompLines(searchOracle.searchToolRenderer.renderCall(args as SearchToolInput, options, theme), width);
}

function newResult(result: SearchResult, options: RenderResultOptions, args?: unknown, width = WIDE): string[] {
	return renderCompLines(production.renderResult(result, options, theme, args), width);
}

function oldResult(result: SearchResult, options: RenderResultOptions, args?: unknown, width = WIDE): string[] {
	return renderCompLines(
		searchOracle.searchToolRenderer.renderResult(result, options, theme, args as SearchToolInput | undefined),
		width,
	);
}

/**
 * Main's `new Text(text, 1, 0)` indent on its own two rows, dropped: the pad is the whole difference.
 *
 * The dispatcher padded the rows it drew itself one column past every other tool's row -- the same
 * pad `file_search` carried and the same exception its suite records -- and a view is drawn with no
 * pad, so the row moves left and nothing else about it changes. The three rows a sub-view draws are
 * unaffected: both arms reach the same module for those, so they are compared with no adjustment.
 */
function unpad(lines: readonly string[]): string[] {
	return lines.map(line => (line.startsWith(" ") ? line.slice(1) : line));
}

const FILES_DETAILS: FileSearchDetails = {
	fileCount: 2,
	files: ["src/alpha.ts", "src/beta.ts"],
} as FileSearchDetails;

const TEXT_DETAILS: TextSearchDetails = {
	matchCount: 1,
	fileCount: 1,
	matches: [{ file: "src/alpha.ts", line: 12, text: "const alpha = 1;" }],
} as unknown as TextSearchDetails;

const STRUCTURE_DETAILS: StructureSearchDetails = {
	matchCount: 1,
	fileCount: 1,
	matches: [{ file: "src/alpha.ts", line: 3, text: "console.log(alpha)" }],
} as unknown as StructureSearchDetails;

/** One well-formed call and one well-formed result per search type, as the tool produces them. */
const BY_TYPE = {
	files: {
		args: { type: "files", input: "src/**/*.ts" } satisfies SearchToolInput,
		result: {
			content: [{ type: "text", text: "src/alpha.ts\nsrc/beta.ts" }],
			details: { type: "files", result: FILES_DETAILS },
		} satisfies SearchResult,
	},
	text: {
		args: { type: "text", input: "alpha", path: "src" } satisfies SearchToolInput,
		result: {
			content: [{ type: "text", text: "src/alpha.ts:12:const alpha = 1;" }],
			details: { type: "text", result: TEXT_DETAILS },
		} satisfies SearchResult,
	},
	structure: {
		args: { type: "structure", input: "console.log($$$)", path: "src" } satisfies SearchToolInput,
		result: {
			content: [{ type: "text", text: "src/alpha.ts:3:console.log(alpha)" }],
			details: { type: "structure", result: STRUCTURE_DETAILS },
		} satisfies SearchResult,
	},
} as const;

/** The type union as the schema declares it, so a type the schema gains is dispatched here too. */
const SCHEMA_TYPES: readonly string[] = searchSchema.shape.type.options;

describe("search dispatcher differential", () => {
	it("routes every type the schema declares, and only those three", () => {
		expect([...SCHEMA_TYPES]).toEqual(["files", "text", "structure"]);
		expect(Object.keys(BY_TYPE).sort()).toEqual([...SCHEMA_TYPES].sort());
	});

	it("carries every policy main's entry carried, resolved off the oracle rather than listed", () => {
		const oracleEntry = searchOracle.searchToolRenderer as unknown as Record<string, unknown>;
		const policies = Object.keys(oracleEntry).filter(key => key !== "renderCall" && key !== "renderResult");
		// Pinned by exact equality: a policy main carried and this entry drops is a card placed
		// differently in the flow, which no drawn row can show.
		expect(policies.sort()).toEqual(["inline", "mergeCallAndResult"]);
		const entry = production as unknown as Record<string, unknown>;
		for (const policy of policies) expect(entry[policy]).toEqual(oracleEntry[policy]);
		// The entry describes its card rather than drawing one, which is what a host other than a
		// terminal reads.
		expect(production.view).toBeDefined();
	});

	it("draws main's card for every type, in both disclosure states, for a call and for a result", () => {
		for (const type of SCHEMA_TYPES) {
			const cell = BY_TYPE[type as keyof typeof BY_TYPE];
			for (const options of [HOST_COLLAPSED, HOST_EXPANDED, HOST_PARTIAL]) {
				expect(newCall(cell.args, options)).toEqual(oldCall(cell.args, options));
				expect(newResult(cell.result, options, cell.args)).toEqual(oldResult(cell.result, options, cell.args));
			}
		}
	});

	it("sends each type to a different card, so no two types collapse onto one", () => {
		const drawn = SCHEMA_TYPES.map(type => {
			const cell = BY_TYPE[type as keyof typeof BY_TYPE];
			return newResult(cell.result, HOST_EXPANDED, cell.args).join("\n");
		});
		expect(new Set(drawn).size).toBe(SCHEMA_TYPES.length);
		// Anti-vacuity: each card is the one for its own type, named by the content it lists.
		expect(stripVTControlCharacters(drawn[0] ?? "")).toContain("src/beta.ts");
		expect(stripVTControlCharacters(drawn[1] ?? "")).toContain("const alpha = 1;");
		expect(stripVTControlCharacters(drawn[2] ?? "")).toContain("console.log(alpha)");
	});

	it("reads the type off either source, whichever of the two the call and the result carry", () => {
		for (const type of SCHEMA_TYPES) {
			const cell = BY_TYPE[type as keyof typeof BY_TYPE];
			const typeless = { input: cell.args.input };
			// The details carry it: a settled card whose arguments were never recorded.
			expect(newResult(cell.result, HOST_COLLAPSED, typeless)).toEqual(
				oldResult(cell.result, HOST_COLLAPSED, typeless),
			);
			expect(newResult(cell.result, HOST_COLLAPSED, undefined)).toEqual(
				oldResult(cell.result, HOST_COLLAPSED, undefined),
			);
			expect(stripVTControlCharacters(newResult(cell.result, HOST_COLLAPSED, typeless).join("\n"))).not.toContain(
				"invalid search type",
			);

			// The call carries it: a partial result the search has not described yet, which is the state
			// every streamed search passes through before its details land.
			const undescribed: SearchResult = { content: cell.result.content };
			for (const options of [HOST_COLLAPSED, HOST_PARTIAL]) {
				expect(newResult(undescribed, options, cell.args)).toEqual(oldResult(undescribed, options, cell.args));
				expect(stripVTControlCharacters(newResult(undescribed, options, cell.args).join("\n"))).not.toContain(
					"invalid search type",
				);
			}
		}
	});

	it("draws main's rows for a call whose type is missing, junk, or the wrong shape", () => {
		const cases: unknown[] = [
			{ input: "alpha" },
			{},
			undefined,
			{ type: "", input: "alpha" },
			{ type: "  ", input: "alpha" },
			{ type: "regex", input: "alpha" },
			{ type: "FILES", input: "alpha" },
			{ type: 7, input: "alpha" },
			{ type: null, input: "alpha" },
			{ type: ["files"], input: "alpha" },
			{ type: "co\tde", input: "alpha" },
			{ type: "x".repeat(TRUNCATE_LENGTHS.CHIP + 40), input: "alpha" },
		];
		// A result carries `isError` absent, false or true, and only the last is a failure: a card that
		// read the field's presence rather than its value would put an error row on a result that
		// succeeded.
		const flags: Array<{ isError?: boolean }> = [{}, { isError: false }, { isError: true }];
		for (const args of cases) {
			for (const options of [HOST_COLLAPSED, HOST_EXPANDED, HOST_PARTIAL]) {
				expect(newCall(args, options)).toEqual(unpad(oldCall(args, options)));
				for (const flag of flags) {
					const result: SearchResult = { content: [{ type: "text", text: "output" }], ...flag };
					expect(newResult(result, options, args)).toEqual(unpad(oldResult(result, options, args)));
				}
			}
		}
		// Anti-vacuity: the three spellings are not one card. A failure states an error row where a
		// result that succeeded states the row for a call whose type was never usable.
		const failed = stripVTControlCharacters(
			newResult({ content: [{ type: "text", text: "output" }], isError: true }, HOST_COLLAPSED, {}).join("\n"),
		);
		const fine = stripVTControlCharacters(
			newResult({ content: [{ type: "text", text: "output" }], isError: false }, HOST_COLLAPSED, {}).join("\n"),
		);
		expect(failed).toContain("Error: output");
		expect(fine).toContain("invalid search type");
	});

	it("states the received type flattened and cut in the view a host reads, not only in the row", () => {
		// A terminal expands a tab when it draws the row, so the drawn bytes hide whether the tab was
		// ever in the description: a host that lays the text out itself receives what the view states.
		// The claim is therefore on the view, which is the surface every host reads.
		const tabbed = searchToolView.renderCall({ type: "co\tde", input: "a" } as unknown as SearchToolInput, {
			expanded: false,
			partial: false,
		});
		expect(tabbed.kind).toBe("statusRow");
		const description = tabbed.kind === "statusRow" ? (tabbed.description ?? "") : "";
		expect(description).toContain("invalid search type");
		expect(description).toContain("expected files, text or structure");
		expect(description).not.toContain("\t");
		expect(description).toContain("co   de");

		const junk = stripVTControlCharacters(newCall({ type: "co\tde", input: "a" }, HOST_COLLAPSED).join("\n"));
		expect(junk).toContain("invalid search type");
		expect(junk).not.toContain("\t");

		// The type is cut to the chip length before it reaches the row, in both arms.
		const overlong = "x".repeat(TRUNCATE_LENGTHS.CHIP + 40);
		const long = stripVTControlCharacters(newCall({ type: overlong, input: "a" }, HOST_COLLAPSED).join("\n"));
		expect(long).toContain("x".repeat(TRUNCATE_LENGTHS.CHIP - 1));
		expect(long).not.toContain("x".repeat(TRUNCATE_LENGTHS.CHIP + 1));
		expect(long).not.toContain(overlong);

		const nameless = stripVTControlCharacters(newCall({ input: "a" }, HOST_COLLAPSED).join("\n"));
		expect(nameless).toContain("(none)");

		const arriving = stripVTControlCharacters(newCall({ input: "a" }, HOST_PARTIAL).join("\n"));
		expect(arriving).not.toContain("invalid search type");
		expect(arriving).toContain("Search");
	});

	it("draws main's error row for a failure that named no type", () => {
		const failures: SearchResult[] = [
			{ content: [{ type: "text", text: "Search input must not be empty" }], isError: true },
			{ content: [], isError: true },
			{ content: [{ type: "image" }], isError: true },
			{ content: [{ type: "text", text: "" }], isError: true },
			{ content: [{ type: "text", text: "line one\nline two" }], isError: true },
		];
		for (const failure of failures) {
			for (const options of [HOST_COLLAPSED, HOST_EXPANDED]) {
				expect(newResult(failure, options)).toEqual(unpad(oldResult(failure, options)));
				// A failure whose type IS known belongs to the sub-card, in both arms, which the sub-card
				// proves by naming the failure the search itself reported rather than the tool's message.
				const typed: SearchResult = {
					...failure,
					details: { type: "files", result: { ...FILES_DETAILS, error: "pattern is not a glob" } },
				};
				expect(newResult(typed, options)).toEqual(oldResult(typed, options));
				expect(stripVTControlCharacters(newResult(typed, options).join("\n"))).toContain("pattern is not a glob");
			}
		}
		const drawn = stripVTControlCharacters(newResult(failures[0] as SearchResult, HOST_COLLAPSED).join("\n"));
		expect(drawn).toContain("Error: Search input must not be empty");
		const empty = stripVTControlCharacters(newResult(failures[1] as SearchResult, HOST_COLLAPSED).join("\n"));
		expect(empty).toContain("Unknown error");
	});

	it("keeps the two arms identical at a width both must cut", () => {
		for (const type of SCHEMA_TYPES) {
			const cell = BY_TYPE[type as keyof typeof BY_TYPE];
			for (const width of [WIDTH, 40, 20]) {
				expect(newCall(cell.args, HOST_COLLAPSED, width)).toEqual(oldCall(cell.args, HOST_COLLAPSED, width));
				expect(newResult(cell.result, HOST_EXPANDED, cell.args, width)).toEqual(
					oldResult(cell.result, HOST_EXPANDED, cell.args, width),
				);
			}
		}
	});

	it("positive control: the arms are compared on bytes that differ between inputs", () => {
		const files = newCall(BY_TYPE.files.args, HOST_COLLAPSED).join("\n");
		const text = newCall(BY_TYPE.text.args, HOST_COLLAPSED).join("\n");
		const invalid = newCall({ type: "regex", input: "src/**/*.ts" }, HOST_COLLAPSED).join("\n");
		expect(files).not.toBe(text);
		expect(files).not.toBe(invalid);
		expect(files).not.toBe(stripVTControlCharacters(files));
	});
});
