/**
 * WHY THIS SUITE EXISTS:
 *
 * A text search's card body (`displayContent`) held every row of every file the page selected, with
 * the context around each match: a broad search held about 100 KB for a card that draws at most
 * EXPANDED_TEXT_LIMIT rows, in memory for the life of the session and again on every write of the
 * session file. The tool now keeps the leading rows a card draws (`cardDisplayRows`) and the count of
 * marked matches past them (`displayHeldMatches`), which the card adds to its held-back note.
 *
 * CLASS: for every body shape the tool's formatters produce (grouped under directory and file
 * headers, one file with no header, no context, heavy context, elided gaps, groups longer than either
 * budget, a missing-path note that takes a row of the budget) the card drawn from the rows kept is
 * the card drawn from the whole body, expanded and collapsed, held-back note included; and a broad
 * search through the tool keeps a bounded body whose held count closes the match total.
 *
 * DOES NOT CATCH: a body shape the formatters start producing that the generator below does not
 * build, such as a row kind other than a header, a numbered row or an elision.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import { formatGroupedFiles } from "@veyyon/coding-agent/tools/core/grouped-file-output";
import { formatCodeFrameLine } from "@veyyon/coding-agent/tools/core/render-utils";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import {
	cardDisplayRows,
	EXPANDED_TEXT_LIMIT,
	isMarkedMatch,
} from "@veyyon/coding-agent/tools/search/search-card-limits";
import type { TextSearchDetails } from "@veyyon/coding-agent/tools/search/text-search";
import { textSearchToolView } from "@veyyon/coding-agent/tools/search/text-search-view";
import { TempDir } from "@veyyon/utils";
import { requireTheme } from "../helpers/require-theme";
import { makeToolSession } from "../helpers/tool-session";

/** A deterministic generator, so a failing case names a seed that reproduces it. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function between(random: () => number, low: number, high: number): number {
	return low + Math.floor(random() * (high - low + 1));
}

/**
 * One file's rows as the tool renders them: each match with its context, a `│...` row between lines
 * that are not adjacent, and a gutter as wide as the widest line number.
 */
function fileRows(random: () => number, matches: number, before: number, after: number): string[] {
	const emitted: Array<{ line: number; match: boolean }> = [];
	let cursor = between(random, 1, 3);
	for (let match = 0; match < matches; match++) {
		const start = cursor + before;
		for (let line = cursor; line < start; line++) emitted.push({ line, match: false });
		emitted.push({ line: start, match: true });
		for (let line = start + 1; line <= start + after; line++) emitted.push({ line, match: false });
		cursor = start + after + 1 + (random() < 0.5 ? 0 : between(random, 1, 40));
	}
	const width = String(emitted[emitted.length - 1]!.line).length;
	const rows: string[] = [];
	let last: number | undefined;
	for (const { line, match } of emitted) {
		if (last !== undefined && line > last + 1) rows.push(`${" ".repeat(width + 1)}│...`);
		rows.push(formatCodeFrameLine(match ? "*" : " ", line, `text of line ${line}`, width));
		last = line;
	}
	return rows;
}

const DIRECTORIES = ["", "src/", "src/core/", "lib/", "docs/guide/"];

interface Body {
	lines: string[];
	matches: number;
	files: number;
}

/** A body the tool could print: grouped files under their headers, or one file with none. */
function body(seed: number): Body {
	const random = mulberry32(seed);
	const before = between(random, 0, 4);
	const after = between(random, 0, 4);
	if (random() < 0.25) {
		const matches = between(random, 1, 60);
		return { lines: fileRows(random, matches, before, after), matches, files: 1 };
	}
	const fileCount = between(random, 1, 25);
	const rowsByFile = new Map<string, string[]>();
	let matches = 0;
	for (let index = 0; index < fileCount; index++) {
		const count = between(random, 1, 20);
		matches += count;
		const directory = DIRECTORIES[between(random, 0, DIRECTORIES.length - 1)]!;
		rowsByFile.set(`${directory}file-${index}.ts`, fileRows(random, count, before, after));
	}
	const { display } = formatGroupedFiles([...rowsByFile.keys()], file => ({
		modelLines: rowsByFile.get(file)!,
		displayLines: rowsByFile.get(file)!,
	}));
	return { lines: display, matches, files: fileCount };
}

function marked(lines: readonly string[]): number {
	return lines.filter(isMarkedMatch).length;
}

let theme: Theme;

/** The card as a terminal draws it, so the held-back note is compared as the words a reader sees. */
function drawn(details: TextSearchDetails, expanded: boolean): string {
	const view = textSearchToolView.renderResult(
		{ content: [{ type: "text", text: "" }], details },
		{ expanded, partial: false },
		{ input: "text" },
	);
	return Bun.stripANSI(drawToolView(view, theme).render(160).join("\n"));
}

const SEEDS = Array.from({ length: 600 }, (_, index) => index + 1);

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	theme = await requireTheme("dark");
});

afterAll(() => {
	resetSettingsForTest();
});

describe("a search card draws the same from the rows it keeps", () => {
	it("draws every generated body the same, expanded and collapsed, from the rows kept and the held count", () => {
		let cut = 0;
		for (const seed of SEEDS) {
			const { lines, matches, files } = body(seed);
			const kept = cardDisplayRows(lines);
			if (kept.heldMatches > 0) cut++;
			expect({ seed, total: kept.heldMatches + marked(kept.rows) }).toEqual({ seed, total: matches });
			for (const missingPaths of [undefined, ["gone/"]]) {
				const whole: TextSearchDetails = {
					matchCount: matches,
					fileCount: files,
					displayContent: lines.join("\n"),
					missingPaths,
				};
				const slim: TextSearchDetails = {
					...whole,
					displayContent: kept.rows.join("\n"),
					displayHeldMatches: kept.heldMatches > 0 ? kept.heldMatches : undefined,
				};
				for (const expanded of [true, false]) {
					expect({ seed, missingPaths, expanded, card: drawn(slim, expanded) }).toEqual({
						seed,
						missingPaths,
						expanded,
						card: drawn(whole, expanded),
					});
				}
			}
		}
		// The sweep has to reach the cut, or it proves only that an uncut body draws like itself.
		expect(cut).toBeGreaterThan(SEEDS.length / 2);
	});

	it("returns a body with no marked match past the card's rows whole", () => {
		const rows = Array.from({ length: EXPANDED_TEXT_LIMIT * 3 }, (_, index) =>
			formatCodeFrameLine(index < 8 ? "*" : " ", index + 1, "context", 2),
		);
		expect(cardDisplayRows(rows)).toEqual({ rows, heldMatches: 0 });
	});
});

describe("a broad text search keeps the rows its card draws", () => {
	let root: TempDir;

	beforeEach(() => {
		root = TempDir.createSync("@pi-search-card-rows-");
		fs.mkdirSync(root.join("tree"));
		for (let file = 0; file < 20; file++) {
			const lines = Array.from({ length: 60 }, (_, line) => (line % 2 === 0 ? `needle ${line}` : `filler ${line}`));
			fs.writeFileSync(root.join(`tree/module-${file}.ts`), `${lines.join("\n")}\n`);
		}
	});

	afterEach(async () => {
		await root.remove();
	});

	it("stores a bounded card body whose held matches close the match count, and draws them as held back", async () => {
		const session = makeToolSession({
			cwd: root.path(),
			getSessionFile: () => root.join("tool-session.jsonl"),
			allocateOutputArtifact: async (toolType: string) => ({
				id: `${toolType}-broad`,
				path: root.join(`${toolType}-broad.log`),
			}),
			settings: Settings.isolated({ "search.contextBefore": 1, "search.contextAfter": 1 }),
		});
		const result = await new SearchTool(session).execute("call-broad", {
			type: "text",
			input: "needle",
			path: "tree",
		});
		const details = result.details?.result;
		if (details === undefined || !("displayContent" in details)) throw new Error("the search reported no card text");
		const text = details as TextSearchDetails;
		const lines = (text.displayContent ?? "").split("\n");
		const matchCount = text.matchCount ?? 0;

		expect(matchCount).toBeGreaterThan(EXPANDED_TEXT_LIMIT * 4);
		expect(lines.filter(line => line.trim().length > 0).length).toBeLessThanOrEqual(2 * EXPANDED_TEXT_LIMIT);
		expect((text.displayHeldMatches ?? 0) + marked(lines)).toBe(matchCount);

		const card = drawn(text, true);
		const shown = card.split("\n").filter(line => /\*\d+│/.test(line)).length;
		expect(card).toContain(`… ${matchCount - shown} more matches`);
	});
});
