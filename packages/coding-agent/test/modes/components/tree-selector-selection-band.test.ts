/**
 * The session tree's selected row is banded across the whole row.
 *
 * WHY THIS SUITE EXISTS. `tree-selector.ts` was the worst of the eleven
 * surfaces that tinted a row's TEXT instead of the row: it did not pad at all,
 * so the band ended exactly where that entry's prompt ended. Moving the cursor
 * from a one-word rewind point to a long one changed the highlight's shape by
 * fifty columns, which reads as a rendering fault rather than as a selection.
 * The tree is also the surface where the rows are most uneven, since every entry
 * is a different prompt at a different indent.
 *
 * Colour is forced ON. With it off `theme.bg` returns its argument unchanged, so
 * a suite rendering under the default policy asserts against a row where the
 * band never existed either way, which is exactly why this shipped.
 *
 * The width these rows are built at comes from the `ScrollView` that renders
 * them, not from the width the component was called with. That matters because
 * the view reserves two columns for its scrollbar and truncates anything longer,
 * and a cut inside a fill drops the escape that CLOSES the fill: the bar and
 * every cell after it then come out painted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { TreeSelectorComponent } from "@veyyon/coding-agent/modes/components/tree-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@veyyon/coding-agent/session/session-entries";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy, visibleWidth } from "@veyyon/tui";
import { cardBodyLines } from "../../helpers/modal-card";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const BG_OPEN = /\x1b\[(?:4[0-7]|10[0-7]|48;(?:2;\d+;\d+;\d+|5;\d+))m/;
const BG_CLOSE = "\x1b[49m";
const WIDTH = 100;

let policy: AnsiPolicy;

beforeEach(async () => {
	await initTheme(false);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
});

afterEach(() => {
	setAnsiPolicy(policy);
});

let counter = 0;
function node(text: string, parentId: string | null = null): SessionTreeNode {
	const id = `entry-${counter++}`;
	const message: AgentMessage = { role: "user", content: text, timestamp: counter };
	const entry: SessionEntry = { type: "message", id, parentId, timestamp: "2026-07-27T00:00:00.000Z", message };
	return { entry, children: [] };
}

/**
 * A flat tree of deliberately uneven prompts.
 *
 * Even lengths hide the defect completely: a band sized to the text and a band
 * sized to the row are the same picture when every row is the same length.
 */
function unevenTree(): { root: SessionTreeNode; shortId: string; longId: string } {
	const root = node("root");
	const short = node("x", root.entry.id);
	const long = node(
		"rewrite the session loader so one malformed record costs its own row instead of the whole transcript",
		root.entry.id,
	);
	const middle = node("why is the modal shorter", root.entry.id);
	root.children.push(short, long, middle);
	return { root, shortId: short.entry.id, longId: long.entry.id };
}

/**
 * The rendered rows of ONE tree, with the band left intact.
 *
 * The tree is passed in rather than rebuilt here. Building a fresh tree inside
 * this helper made every id in it differ from the id the caller had selected,
 * and the component falls back to the first row when it cannot find the
 * selection, so the assertions passed while testing something else entirely.
 */
function rows(root: SessionTreeNode, selectedId: string): string[] {
	const selector = new TreeSelectorComponent(
		[root],
		selectedId,
		() => {},
		() => {},
	);
	return [...selector.render(WIDTH)];
}

/** The one row carrying a background, or a failure saying none did. */
function bandedRow(root: SessionTreeNode, selectedId: string): string {
	const banded = rows(root, selectedId).filter(line => BG_OPEN.test(line));
	if (banded.length !== 1) throw new Error(`expected exactly one banded row, found ${banded.length}`);
	return banded[0] as string;
}

/** The row with every escape removed, which is what the eye sees as cells. */
function cells(line: string): string {
	return line.replace(ANSI_PATTERN, "");
}

describe("The selected row's band", () => {
	/** The exact regression: a one-character entry got a one-character band. */
	test("fills the whole row on the shortest entry in the tree", () => {
		const { root, shortId } = unevenTree();
		const banded = bandedRow(root, shortId);
		const open = banded.search(BG_OPEN);
		const close = banded.indexOf(BG_CLOSE);

		expect(open).toBeGreaterThan(-1);
		expect(close).toBeGreaterThan(open);
		expect(visibleWidth(cells(banded.slice(open, close)))).toBeGreaterThan(60);
	});

	/**
	 * And the band is the SAME width on a long entry. This is the property the
	 * eye actually reads: the highlight must not change shape as the cursor
	 * moves, which a text-sized band does on every keypress.
	 */
	test("is the same width whichever entry is selected", () => {
		const { root, shortId, longId } = unevenTree();
		const width = (id: string) => {
			const banded = bandedRow(root, id);
			const open = banded.search(BG_OPEN);
			return visibleWidth(cells(banded.slice(open, banded.indexOf(BG_CLOSE))));
		};

		expect(width(shortId)).toBe(width(longId));
	});

	/** Exactly one row is banded: the selection, and nothing that follows it. */
	test("bands one row and no other", () => {
		const { root, shortId } = unevenTree();

		expect(rows(root, shortId).filter(line => BG_OPEN.test(line))).toHaveLength(1);
	});

	/**
	 * The fill closes. An unclosed background runs on into every row the terminal
	 * draws after it, which is the failure that makes a whole pane come out
	 * tinted rather than one row.
	 */
	test("closes the background it opened", () => {
		const { root, longId } = unevenTree();
		const banded = bandedRow(root, longId);

		expect(banded).toContain(BG_CLOSE);
		expect(banded.indexOf(BG_CLOSE)).toBeGreaterThan(banded.search(BG_OPEN));
	});

	/** No row may exceed the width it was rendered at, banded or not. */
	test("never draws a row wider than the viewport", () => {
		const { root, shortId } = unevenTree();
		const tooWide = rows(root, shortId).filter(line => visibleWidth(line) > WIDTH);

		expect(tooWide).toEqual([]);
	});

	/**
	 * With colour off there is no band at all, which is why this suite forces it
	 * on. The cursor glyph is what carries the selection there, and it is drawn
	 * either way.
	 */
	test("carries the selection with a cursor glyph when colour is off", () => {
		const { root, shortId } = unevenTree();
		setAnsiPolicy("plain");
		// The card's left border precedes every row, so the cursor is read from
		// the card's content columns rather than from column zero.
		const rendered = cardBodyLines(rows(root, shortId));

		expect(rendered.some(line => BG_OPEN.test(line))).toBeFalse();
		expect(rendered.filter(line => line.trimStart().startsWith("›"))).toHaveLength(1);
		expect(rendered.find(line => line.trimStart().startsWith("›"))).toContain("user: x");
	});
});
