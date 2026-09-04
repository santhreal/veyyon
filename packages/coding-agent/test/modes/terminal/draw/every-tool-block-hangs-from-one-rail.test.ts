/**
 * WHY:
 * A tool's card used to start in a different column depending on which renderer
 * drew it and which half of its life it was in. `renderCall` returned a bare
 * status row and `renderResult` returned a framed block, so the same title
 * stepped two columns right the instant the result landed; an inline renderer
 * indented its rows one cell off the margin; the eval card appended its JSON
 * tree after the block that framed its cells, so those rows sat in the rail's
 * column with no rail in it. Nothing had a rail to travel down until the result
 * arrived, and a transcript of mixed tools read as a ragged left edge.
 *
 * This suite defends the class rather than those three incidents: EVERY renderer
 * in the registry, in EVERY lifecycle state, draws every row of its block from
 * one rail at one column. The registry is swept at run time, so a new tool, a
 * new renderer, or a new lifecycle state is red until it hangs from the rail
 * too, and the set of blocks that carry no rail is pinned empty by exact
 * equality rather than by a count.
 *
 * What it does not catch: the rail's COLOUR and its motion (owned by
 * `a-tool-blocks-rail-moves-while-it-runs-and-cools-once-it-lands.test.ts`), and
 * anything a renderer draws only for a fixture this repository has none of — a
 * tool whose gallery fixture is the generic fallback exercises its renderer's
 * shape, not its every branch.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { GALLERY_STATES, renderGalleryState, resolveFixture } from "@veyyon/coding-agent/cli/gallery-cli";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { COMPOSER_INSET_COLS } from "@veyyon/coding-agent/modes/terminal/components/composer/composer-chrome";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import { Text } from "@veyyon/tui";
import {
	beginSettingsTest,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../../../helpers/settings-test-state";

/** Widths a block is asked for: one narrow enough to wrap every preview row, one roomy. */
const WIDTHS = [60, 100] as const;

/** Cells a row has for content once the block's gutter and rail are drawn. */
const NARROW_CONTENT = WIDTHS[0] - COMPOSER_INSET_COLS - 1;

/** The wrapper's floor: an indent leaving fewer text cells than this wraps flush. */
const HANGING_INDENT_MIN_TEXT = 4;

/**
 * Cards whose first row is not a title, with the reason and the shape it is instead.
 *
 * A `section` row carries the block's content indent, so it starts one cell further in than a title
 * does. A `plate` row is a notice's own top inset: the renderer fills its whole width, so the row the
 * block frames as its header is blank from the rail to the right margin, and the headline sits under
 * it. Pinned by exact equality and by shape: a renderer that drops its title, one that gains an
 * indent it did not mean to, and one whose recorded shape changes all land here and the suite goes red
 * until someone records the decision. `debug` and `lsp` used to sit here, opening a settled result on
 * its stack rows and its findings; both cards are now views whose header row states the tool and the
 * outcome in every lifecycle state, so neither opens on a section any more.
 */
const CARDS_WITHOUT_A_TITLE_ROW: Record<string, { shape: "section" | "plate"; why: string }> = {
	bash: {
		shape: "section",
		why: "the `$ command` row says what a title would repeat, so the shell card draws no title",
	},
	resolve: {
		shape: "plate",
		why: "a resolution is a full-width plate, and its top inset row is what the block frames as the card's first row",
	},
};

/**
 * Renderers whose rows carry a box-drawing glyph after the rail, and why it is
 * a hierarchy rather than a second left edge. A tree connector states that a row
 * belongs to the row above it; a frame states nothing and duplicates the edge the
 * block already has. Pinned by exact equality: a renderer that starts drawing a
 * border of its own lands here and the suite goes red until someone records the
 * decision. `vibe_*`, `inspect_image` and an LSP hover code block used to sit in
 * this set, drawing a box, a connector and a code frame inside the rail, and so
 * did the retired `grep` tool, whose line-number gutter now belongs to the
 * `search` tool's text mode — a mode the one fixture per tool does not reach.
 * `eval` and `job` left it the other way: both cards are now views that state a
 * structure as depth, two columns per level, and the host draws no connector for
 * them.
 *
 * A third case reaches this set without being chrome at all: a renderer that
 * echoes a remote command's stdout carries whatever glyphs that command printed,
 * and no renderer can forbid a byte in content it did not author. The sweep
 * cannot tell an echoed glyph from a drawn one, which is this suite's blind
 * spot; an entry of that kind says so and names the command its fixture runs.
 */
const RENDERERS_THAT_DRAW_A_TREE: Record<string, string> = {
	lsp: "a reference tree: a line belongs to the file above it",
	search_tool_bm25: "a match tree: a discovered tool belongs to the query row above it",
	ssh: "not chrome: the fixture echoes `systemctl status`, which prints a CGroup tree",
};

/** Box-drawing and rounded-corner glyphs, the alphabet a second edge is drawn in. */
const BOX_GLYPH = /[│┌┐└┘├┤┬┴┼─╭╮╰╯╷╵]/u;

let settingsState: SettingsTestState | undefined;

beforeAll(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterAll(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("every tool block hangs from one rail", () => {
	it("draws every row of every renderer in every state from the rail at the composer's column", async () => {
		const rail = theme.symbol("block.rail");
		const offRail: string[] = [];
		const railless: string[] = [];

		for (const name of Object.keys(toolRenderers).sort()) {
			const fixture = resolveFixture(name);
			for (const state of GALLERY_STATES) {
				for (const width of WIDTHS) {
					const rendered = await renderGalleryState(name, fixture, state, width);
					const rows = rendered.map(line => Bun.stripANSI(line)).filter(line => line.trim().length > 0);
					if (rows.length === 0) {
						railless.push(`${name}/${state}@${width}`);
						continue;
					}
					for (const row of rows) {
						// The rail is the block's left edge, so it is the first non-space
						// cell of the row and it lands where the composer's gutter ends.
						if (row.indexOf(rail) !== COMPOSER_INSET_COLS) {
							offRail.push(`${name}/${state}@${width} ${JSON.stringify(row.slice(0, 48))}`);
						}
					}
				}
			}
		}

		expect(offRail).toEqual([]);
		expect(railless).toEqual([]);
	});

	it("keeps a call and the result that replaces it in the same column", async () => {
		const rail = theme.symbol("block.rail");
		const moved: string[] = [];

		for (const name of Object.keys(toolRenderers).sort()) {
			const fixture = resolveFixture(name);
			const columnFor = async (state: (typeof GALLERY_STATES)[number]): Promise<number> => {
				const rendered = await renderGalleryState(name, fixture, state, 100);
				const first = rendered.map(line => Bun.stripANSI(line)).find(line => line.trim().length > 0) ?? "";
				return first.indexOf(rail);
			};
			// The defect was a two-column jump the instant the result landed, which is
			// visible only by comparing the two states of ONE tool.
			const columns = new Set([
				await columnFor("streaming"),
				await columnFor("progress"),
				await columnFor("success"),
			]);
			if (columns.size !== 1) moved.push(`${name} ${JSON.stringify([...columns])}`);
		}

		expect(moved).toEqual([]);
	});

	it("opens every card one cell after the rail, and names the ones that open on a section row", async () => {
		const rail = theme.symbol("block.rail");
		/** Per tool, the shapes its first row took across the states, so a recorded shape is checked. */
		const shapes = new Map<string, Set<string>>();

		for (const name of Object.keys(toolRenderers).sort()) {
			const fixture = resolveFixture(name);
			for (const state of GALLERY_STATES) {
				const rendered = await renderGalleryState(name, fixture, state, 100);
				const first = rendered.map(line => Bun.stripANSI(line)).find(line => line.trim().length > 0) ?? "";
				const after = first.slice(first.indexOf(rail) + rail.length);
				const gap = after.length - after.trimStart().length;
				// An inline renderer used to draw its rows one cell in from the margin it
				// no longer sits on, which put its title a cell right of every framed
				// card's title in the same transcript. A row blank to the right margin is a
				// plate's top inset rather than an indent: one section of padding and no
				// more, and anything further in with text on it is a renderer padding
				// itself on top of the padding the block already draws.
				const shape = gap === 1 ? "title" : after.trim() === "" ? "plate" : gap === 2 ? "section" : `indent:${gap}`;
				const seen = shapes.get(name) ?? new Set<string>();
				seen.add(shape);
				shapes.set(name, seen);
			}
		}

		const notTitled = [...shapes.entries()].filter(([, seen]) => !(seen.size === 1 && seen.has("title")));
		expect(notTitled.map(([name]) => name).sort()).toEqual(Object.keys(CARDS_WITHOUT_A_TITLE_ROW).sort());
		for (const [name, seen] of notTitled) {
			// A recorded card opens on the shape it was recorded with, in the states that are not a
			// plain title row: a plate that becomes a two-cell indent is a shape change, not a card
			// that happens to still be on the list.
			const recorded = CARDS_WITHOUT_A_TITLE_ROW[name];
			expect([...seen].filter(shape => shape !== "title").sort()).toEqual([recorded.shape]);
			expect(recorded.why.length).toBeGreaterThan(40);
		}
	});

	it("draws no second left edge inside the rail, and names every renderer that draws a tree", async () => {
		const rail = theme.symbol("block.rail");
		const drawing = new Set<string>();

		for (const name of Object.keys(toolRenderers).sort()) {
			const fixture = resolveFixture(name);
			for (const state of GALLERY_STATES) {
				for (const width of WIDTHS) {
					const rendered = await renderGalleryState(name, fixture, state, width);
					for (const line of rendered) {
						const row = Bun.stripANSI(line);
						if (row.trim().length === 0) continue;
						// Everything left of the rail is the block's own gutter; a second
						// edge is something a renderer paints to the right of it.
						const after = row.slice(row.indexOf(rail) + rail.length);
						if (BOX_GLYPH.test(after)) drawing.add(name);
					}
				}
			}
		}

		expect([...drawing].sort()).toEqual(Object.keys(RENDERERS_THAT_DRAW_A_TREE).sort());
	});

	// A renderer indents a row to nest it under the row above. At a narrow width
	// that row wraps, and the continuation used to return to column zero, so a
	// detail row read as a new top-level row of the card. The sweep is every
	// renderer's real output: each indented row it draws is re-wrapped at the
	// narrow content width, and every row of the result opens where the first
	// one did.
	it("keeps a wrapped row under the indent its first row opened at, for every renderer", async () => {
		const rail = theme.symbol("block.rail");
		const lost: string[] = [];
		let wrappedRows = 0;

		for (const name of Object.keys(toolRenderers).sort()) {
			const fixture = resolveFixture(name);
			for (const state of GALLERY_STATES) {
				const rendered = await renderGalleryState(name, fixture, state, WIDTHS[1]);
				for (const line of rendered) {
					const railAt = line.indexOf(rail);
					if (railAt < 0) continue;
					const logical = line.slice(railAt + rail.length);
					const plain = Bun.stripANSI(logical);
					if (plain.trim().length === 0) continue;
					const indent = plain.length - plain.trimStart().length;
					// An indent that leaves fewer than four cells of text wraps flush,
					// which is the wrapper's own floor rather than a lost indent.
					if (indent === 0 || indent + HANGING_INDENT_MIN_TEXT > NARROW_CONTENT) continue;
					const rows = new Text(logical, 0, 0)
						.render(NARROW_CONTENT)
						.map(row => Bun.stripANSI(row))
						.filter(row => row.trim().length > 0);
					if (rows.length < 2) continue;
					wrappedRows++;
					for (const row of rows) {
						if (row.length - row.trimStart().length !== indent) {
							lost.push(`${name}/${state} ${JSON.stringify(row.slice(0, 40))}`);
						}
					}
				}
			}
		}

		expect(lost).toEqual([]);
		// Without this the arm passes on a sweep that found nothing that wrapped.
		expect(wrappedRows).toBeGreaterThan(10);
	});

	it("renders an LSP hover code block without a frame of its own", async () => {
		const rail = theme.symbol("block.rail");
		const hover = {
			content: [
				{
					type: "text",
					text: "The session store.\n\n```ts\nexport class SessionStore {\n\tget(id: string): Session | undefined;\n}\n```\n\nReturns undefined for an evicted id.",
				},
			],
			details: { action: "hover", file: "packages/server/src/session-store.ts", line: 12, character: 14 },
		};
		const renderer = toolRenderers.lsp;
		if (!renderer?.renderResult) throw new Error("the lsp renderer has no renderResult");

		for (const expanded of [false, true]) {
			const component = renderer.renderResult(hover, { expanded, isPartial: false }, theme, { action: "hover" });
			const rows = (component?.render(100) ?? []).map(line => Bun.stripANSI(line)).filter(l => l.trim().length > 0);
			// Without this the arm passes on a renderer that drew nothing at all.
			expect(rows.some(row => row.includes("export class SessionStore"))).toBe(true);
			for (const row of rows) {
				const after = row.slice(row.indexOf(rail) + rail.length);
				expect(after).not.toMatch(BOX_GLYPH);
			}
		}
	});
});
