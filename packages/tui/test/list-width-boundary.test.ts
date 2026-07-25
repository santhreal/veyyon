/**
 * The list and single-line text components at pathological terminal widths.
 *
 * `truncateToWidth(text, 0)` returns the ellipsis: at zero columns it hands back
 * one cell. Any component that floors its available width at 1 therefore draws
 * one cell WIDER than the space it was given, and a component that overruns its
 * width shifts every character to its right for the rest of the frame. That is
 * exactly what `TruncatedText` did, and it is invisible in a "did not throw"
 * test — which is why the assertions here are on exact bytes and exact visible
 * widths.
 *
 * `SelectList` gets the same treatment because it is what every picker in the
 * product is made of: if it overruns at 3 columns, so does the version picker,
 * the theme picker, and the model picker.
 */
import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type SelectItem, SelectList } from "@veyyon/tui/components/select-list";
import { TruncatedText } from "@veyyon/tui/components/truncated-text";
import { visibleWidth } from "@veyyon/tui/utils";
import { defaultSelectListTheme } from "./test-themes.js";

const ITEMS: SelectItem[] = [
	{ value: "1.6.0", label: "1.6.0", description: "released in July" },
	{ value: "1.5.2", label: "1.5.2", description: "released in June" },
];

const PATHOLOGICAL = [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY, 1e9, 0x7fff_ffff];

const plain = (line: string) => stripVTControlCharacters(line);

describe("TruncatedText", () => {
	it("draws nothing at zero columns rather than a lone ellipsis", () => {
		// The regression. A `Math.max(1, …)` floor meant zero columns produced one.
		expect(new TruncatedText("hello world", 0, 0).render(0)).toEqual([""]);
	});

	it("never exceeds the width it was given", () => {
		for (const width of [0, 1, 2, 3, 5, 12, 80]) {
			for (const line of new TruncatedText("a much longer line than fits", 0, 0).render(width)) {
				expect(visibleWidth(plain(line))).toBeLessThanOrEqual(width);
			}
		}
	});

	it("truncates with an ellipsis once there is room for one", () => {
		// One column is the first width where the ellipsis is legal rather than an
		// overrun, and it is what tells the reader the line continues.
		expect(plain(new TruncatedText("hello world", 0, 0).render(1)[0]!)).toBe("…");
		expect(plain(new TruncatedText("hello world", 0, 0).render(6)[0]!)).toBe("hello…");
	});

	it("keeps the whole line once it fits", () => {
		expect(plain(new TruncatedText("hello", 0, 0).render(20)[0]!)).toBe("hello");
	});

	it("does not throw at any pathological width", () => {
		for (const width of PATHOLOGICAL) {
			expect(() => new TruncatedText("hello world", 1, 1).render(width)).not.toThrow();
		}
	});

	it("cuts at the first line break so a CRLF source cannot move the cursor", () => {
		// A stray `\r` returns the terminal to column 0 mid-row and corrupts it.
		expect(plain(new TruncatedText("first\r\nsecond", 0, 0).render(40)[0]!)).toBe("first");
	});
});

describe("SelectList", () => {
	it("does not throw at any pathological width", () => {
		for (const width of PATHOLOGICAL) {
			expect(() => new SelectList(ITEMS, 5, defaultSelectListTheme).render(width)).not.toThrow();
		}
	});

	it("never exceeds the width it was given, at any width a pane can shrink to", () => {
		// Every picker in the product is this component. An overrun here is an
		// overrun in all of them.
		for (let width = 0; width <= 24; width++) {
			for (const line of new SelectList(ITEMS, 5, defaultSelectListTheme).render(width)) {
				expect(visibleWidth(plain(line))).toBeLessThanOrEqual(width);
			}
		}
	});

	it("keeps the cursor and the whole value once there is room for both", () => {
		// 10 columns is the first width where the whole version fits beside the
		// cursor, and the version is the only part of the row that identifies it.
		// Exact bytes: the unselected row must stay indented by the cursor's width,
		// or the two rows would not line up under each other.
		const lines = new SelectList(ITEMS, 5, defaultSelectListTheme).render(10);

		expect(plain(lines[0]!)).toBe("> 1.6.0");
		expect(plain(lines[1]!)).toBe("  1.5.2");
	});

	it("cuts the value itself only when even that will not fit", () => {
		// At 8 columns "1.6.0" loses its last character. Locked deliberately: the
		// list truncates without an ellipsis (Ellipsis.Omit throughout), so a
		// change to that policy shows up here as a diff rather than as a version
		// string quietly reading as a different version.
		expect(plain(new SelectList(ITEMS, 5, defaultSelectListTheme).render(8)[0]!)).toBe("> 1.6.");
	});

	it("drops the description before the value when the pane is narrow", () => {
		// Losing "released in July" costs context; losing "1.6.0" costs the row's
		// identity. The narrow render must sacrifice the first, never the second.
		const narrow = plain(new SelectList(ITEMS, 5, defaultSelectListTheme).render(12).join("\n"));

		expect(narrow).toContain("1.6.0");
		expect(narrow).not.toContain("released");
	});

	it("shows both once the pane is wide enough", () => {
		const wide = plain(new SelectList(ITEMS, 5, defaultSelectListTheme).render(60).join("\n"));

		expect(wide).toContain("1.6.0");
		expect(wide).toContain("released in July");
	});

	it("renders one row per item and no filler", () => {
		// A list that padded itself out would look like it had more entries.
		expect(new SelectList(ITEMS, 5, defaultSelectListTheme).render(40).length).toBe(ITEMS.length);
	});
});
