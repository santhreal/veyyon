/**
 * The width a prompt title is bounded to must be the width it is rendered at.
 *
 * Two independent call sites pre-truncated the title of the editor overlay to
 * `terminal columns - 4`, both explaining the 4 as the title row's padding plus
 * the surrounding border's vertical chrome. That border was one full-width
 * horizontal rule and consumed zero columns (it has since been deleted along
 * with every other full-width rule). The real chrome is the title row's padding
 * alone, one column per side, so every question was pre-truncated two columns
 * short of the space it had.
 *
 * Nothing caught it because being narrower than available never wraps and never
 * looks broken. It silently costs two columns of question text at every terminal
 * width, and a wrong constant that looks conservative is exactly the kind that
 * survives review. So the reservation is derived from the component that applies
 * the padding, and these tests pin the two halves of that claim: what the
 * component actually consumes, and that the callers reserve exactly that.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Text, visibleWidth } from "@veyyon/tui";
import { boundPromptTitle } from "../../../src/modes/components/ask-dialog";
import { HOOK_EDITOR_TEXT_PAD_COLS } from "../../../src/modes/components/hook-editor";

const originalColumns = process.stdout.columns;

afterEach(() => {
	Object.defineProperty(process.stdout, "columns", {
		value: originalColumns,
		configurable: true,
		writable: true,
	});
});

/** Pin the terminal width, since every width under test is derived from it. */
function setColumns(columns: number): void {
	Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true, writable: true });
}

/** How many columns of a `width`-wide row the padded title row leaves for text. */
function renderedContentWidth(width: number): number {
	// A run of non-breaking content longer than any plausible width, so the
	// wrap point is decided by the available width and not by a word boundary.
	const line = new Text("x".repeat(width * 2), HOOK_EDITOR_TEXT_PAD_COLS, 0).render(width)[0] ?? "";
	return visibleWidth(line.replace(/^ +| +$/g, ""));
}

describe("the chrome around a hook editor title row", () => {
	/**
	 * THE defect, stated as the component's own arithmetic. `Text` wraps at
	 * `width - paddingX * 2`, so the chrome is two columns total, not four.
	 */
	it("consumes exactly two columns, one per side", () => {
		expect(HOOK_EDITOR_TEXT_PAD_COLS * 2).toBe(2);
		expect(renderedContentWidth(80)).toBe(78);
		expect(renderedContentWidth(120)).toBe(118);
		expect(renderedContentWidth(40)).toBe(38);
	});

	/** The padding is applied on BOTH sides, which is why the reservation
	 *  doubles it. A one-sided indent would need a different number. */
	it("pads the row on both sides", () => {
		const row = new Text("abc", HOOK_EDITOR_TEXT_PAD_COLS, 0).render(20)[0] ?? "";
		expect(row.startsWith(" ".repeat(HOOK_EDITOR_TEXT_PAD_COLS))).toBe(true);
		expect(row.slice(HOOK_EDITOR_TEXT_PAD_COLS, HOOK_EDITOR_TEXT_PAD_COLS + 3)).toBe("abc");
	});
});

describe("bounding a prompt title to the width it will be rendered at", () => {
	/**
	 * The regression, in the form the user would have seen it: a question that
	 * exactly fills the available columns used to wrap onto a second row because
	 * it was bounded two columns narrower than the row it was going into.
	 */
	it("keeps a question that exactly fills the row on one line", () => {
		setColumns(80);
		const available = renderedContentWidth(80);
		const question = "q".repeat(available);

		const bounded = boundPromptTitle("", question);

		expect(bounded.split("\n").length).toBe(1);
		expect(visibleWidth(bounded)).toBe(available);
		expect(bounded).toBe(question);
	});

	/** The boundary on the other side: one column more than the row holds must
	 *  wrap, or the bound is too wide and the title would overflow its row. */
	it("wraps a question one column wider than the row", () => {
		setColumns(80);
		const question = "q".repeat(renderedContentWidth(80) + 1);

		expect(boundPromptTitle("", question).split("\n").length).toBe(2);
	});

	/** The bound tracks the terminal rather than a fixed 80, and the prefix is
	 *  part of the bounded text, not extra. */
	it("tracks the terminal width, prefix included", () => {
		for (const columns of [40, 80, 132, 200]) {
			setColumns(columns);
			const available = renderedContentWidth(columns);
			const prefix = "Custom answer: ";
			const question = "q".repeat(available - prefix.length);

			const bounded = boundPromptTitle(prefix, question);

			expect(bounded.split("\n").length).toBe(1);
			expect(visibleWidth(bounded)).toBe(available);
		}
	});

	/** Every bounded row has to fit the row it is rendered into, at every width.
	 *  This is the invariant the two hardcoded copies were meant to guarantee and
	 *  the one that actually matters: no row wider than the space available. */
	it("never produces a row wider than the rendered row", () => {
		for (const columns of [20, 40, 80, 132, 200]) {
			setColumns(columns);
			const available = renderedContentWidth(columns);
			const bounded = boundPromptTitle("Note for Some Option: ", "word ".repeat(200).trim());

			for (const row of bounded.split("\n")) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(available);
			}
		}
	});

	/** A missing `columns` (piped stdout, no TTY) must not produce a zero or
	 *  negative bound, which would make every title a column of single letters. */
	it("falls back to 80 columns when the terminal reports no width", () => {
		Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true, writable: true });

		const bounded = boundPromptTitle("", "q".repeat(200));

		expect(bounded.split("\n")[0]?.length).toBe(78);
	});
});
