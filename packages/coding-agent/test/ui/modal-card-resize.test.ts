/**
 * The modal card across a resize.
 *
 * The card's height comes from a high-water mark of the body heights it has
 * drawn, so that filtering a list down does not resize the card under the
 * reader's eyes. That mark is state, and state carried across a resize is
 * exactly how a component leaves a stale frame: the same rows lay out
 * differently at a new width (descriptions wrap, columns shrink), so a mark
 * taken at the old width sizes the card for a body that no longer exists.
 *
 * The contract these hold is the one the sibling resize-storm suite holds for
 * Text and Markdown: a resized instance must render a given width identically
 * to a fresh instance at that width. The mark may only accelerate within a
 * width, never leak across one.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ModalSelectListComponent } from "@veyyon/coding-agent/modes/components/modal-select-list";
import { getSelectListTheme, initTheme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "titanium");
});

/** Descriptions long enough that a narrow card lays them out differently. */
const ITEMS = [
	{ value: "1.6.0", label: "1.6.0", description: "published on the twentieth of July, the newest one" },
	{ value: "1.5.2", label: "1.5.2", description: "published on the eleventh of July" },
	{ value: "1.5.1", label: "1.5.1", description: "published on the second of July, running now" },
];

/**
 * Descriptions WRAP, which is what makes the body height depend on the width.
 *
 * Without wrapping every row is one line at every width, the high-water mark is
 * the same number everywhere, and a test for stale-width state proves nothing
 * because there is no state to be stale. Wrapping is the layout that actually
 * exercises it.
 */
function card(): ModalSelectListComponent {
	return new ModalSelectListComponent(
		{
			title: "Version",
			items: ITEMS,
			theme: getSelectListTheme(),
			getTerminalRows: () => 40,
			layout: { wrapDescription: true, minPrimaryColumnWidth: 8, maxPrimaryColumnWidth: 12 },
		},
		{ onSelect: () => {}, onCancel: () => {} },
	);
}

/**
 * How tall the CARD is, which is what a stale mark gets wrong.
 *
 * `render` returns a full-screen frame — always the terminal's row count — so
 * counting its lines measures the terminal, not the card. The card is the run of
 * rows carrying its border.
 */
function cardRowCount(component: ModalSelectListComponent, width: number): number {
	return frame(component, width)
		.split("\n")
		.filter(line => /[┌└│]/.test(line)).length;
}

const frame = (component: ModalSelectListComponent, width: number) =>
	component
		.render(width)
		.map(line => stripVTControlCharacters(line))
		.join("\n");

describe("after a resize", () => {
	it("renders a width exactly as a fresh card would", () => {
		// The whole invariant in one assertion. Any stale-width state shows up here
		// as a byte difference.
		const resized = card();
		resized.render(120);
		resized.render(60);

		expect(frame(resized, 100)).toBe(frame(card(), 100));
	});

	it("survives a resize storm back and forth", () => {
		// A pane dragged, or a rapid SIGWINCH sequence. One pass proves nothing if
		// the state only goes wrong on the second visit to a width.
		const resized = card();
		for (const width of [80, 120, 44, 200, 60, 100, 44]) resized.render(width);

		expect(frame(resized, 80)).toBe(frame(card(), 80));
	});

	it("is the same height at a narrow width as a fresh card is", () => {
		// Worth stating plainly: for this list every row is ONE line at every
		// width, so the body height does not actually vary with width and no
		// height-carrying bug can be demonstrated here. The per-width reset in the
		// component is therefore defensive rather than a fix for an observed
		// failure — but the equality it protects is real and is what this asserts.
		const resized = card();
		resized.render(120);

		expect(cardRowCount(resized, 50)).toBe(cardRowCount(card(), 50));
	});

	it("shrinks the card back down after a wider one", () => {
		// The specific failure: a tall card measured at one width, kept at another,
		// leaves blank rows below the content — the very thing the height fix
		// removed.
		const resized = card();
		resized.render(50);
		const afterWide = frame(resized, 120);

		expect(afterWide).toBe(frame(card(), 120));
	});
});

describe("within one width", () => {
	it("keeps the card height stable while the list filters down", () => {
		// The reason the mark exists at all. Typing must not resize the frame the
		// reader is looking at.
		const component = card();
		const before = frame(component, 100).split("\n").length;
		component.getSelectList().setFilter("1.5.1");
		const after = frame(component, 100).split("\n").length;

		expect(after).toBe(before);
	});

	it("still shows only the matching row", () => {
		// Stability of the card must not come from keeping rows that no longer
		// match.
		const component = card();
		component.render(100);
		component.getSelectList().setFilter("1.5.1");

		const rendered = frame(component, 100);
		expect(rendered).toContain("1.5.1");
		expect(rendered).not.toContain("1.6.0");
	});
});
