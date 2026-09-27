/**
 * WHY: an aria snapshot repeats content. A table row's name is every cell it holds, joined, and each
 * cell follows on its own line; a column header's name is its text and its menu button's name; every
 * link and button carries `[cursor=pointer]`, which its role already states. Across calibration runs
 * that repetition was about a tenth of every snapshot's characters, and every snapshot is sent again on
 * each later turn.
 *
 * The contract of `withoutRepeatedDetail`: a node that is not a control loses its name when the name is
 * its children's names and texts joined (whitespace aside); a control keeps its name, since a selector
 * copied from its line names it; a name that differs from the content, such as an `aria-label`, stays;
 * `[cursor=pointer]` goes from roles clickable by definition and stays on any other; every ref, every
 * other attribute and every inline text is kept, in order.
 *
 * What it does NOT catch: that a compacted snapshot's refs still resolve in a page, which
 * `an-open-that-loads-a-small-page-sends-its-snapshot.test.ts` proves in Chromium.
 */

import { describe, expect, it } from "bun:test";
import { compactSnapshot, withoutRepeatedDetail } from "@veyyon/coding-agent/tools/web/browser/aria-snapshot";

describe("an aria snapshot", () => {
	it("drops a row's and a column header's name that their content repeats, and keeps every cell", () => {
		const snapshot = [
			'- grid "Ledger" [ref=e1]:',
			'  - row "A Column A menu" [ref=e2]:',
			'    - columnheader "A Column A menu" [ref=e3]:',
			"      - text: A",
			'      - button "Column A menu" [ref=e4] [cursor=pointer]: ▾',
			'  - row "2 2026-06-02 Say \\"hi\\" 12.50" [ref=e5]:',
			'    - rowheader "2" [ref=e6]',
			'    - gridcell "2026-06-02" [ref=e7]',
			'    - gridcell "Say \\"hi\\"" [ref=e8]',
			'    - gridcell "12.50" [ref=e9]',
			"    - gridcell [ref=e10]",
			'  - row "3 Atlas Insurance Paid" [ref=e11]:',
			'    - rowheader "3" [ref=e12]',
			"    - gridcell [ref=e13]:",
			'      - link "Atlas Insurance" [ref=e14] [cursor=pointer]:',
			"        - /url: /payees/7",
			"    - gridcell [ref=e15]: Paid",
		].join("\n");
		expect(withoutRepeatedDetail(snapshot)).toBe(
			[
				'- grid "Ledger" [ref=e1]:',
				"  - row [ref=e2]:",
				"    - columnheader [ref=e3]:",
				"      - text: A",
				'      - button "Column A menu" [ref=e4]: ▾',
				"  - row [ref=e5]:",
				'    - rowheader "2" [ref=e6]',
				'    - gridcell "2026-06-02" [ref=e7]',
				'    - gridcell "Say \\"hi\\"" [ref=e8]',
				'    - gridcell "12.50" [ref=e9]',
				"    - gridcell [ref=e10]",
				"  - row [ref=e11]:",
				'    - rowheader "3" [ref=e12]',
				"    - gridcell [ref=e13]:",
				'      - link "Atlas Insurance" [ref=e14]:',
				"        - /url: /payees/7",
				"    - gridcell [ref=e15]: Paid",
			].join("\n"),
		);
	});

	it("keeps a control's name, a name the content does not make, and a pointer on other roles", () => {
		const snapshot = [
			'- navigation "Main menu" [ref=e1]:',
			'  - listitem "Home" [ref=e2]:',
			'    - link "Home" [ref=e3] [cursor=pointer]:',
			"      - /url: /",
			'  - button "Save changes" [ref=e4] [cursor=pointer]:',
			"    - generic [ref=e5]: Save",
			"    - generic [ref=e6]: changes",
			'  - generic "Open card" [ref=e7] [cursor=pointer]:',
			'    - paragraph [ref=e8]: "Open card"',
			'  - img "Logo" [ref=e9]:',
			"    - /url: /logo.png",
		].join("\n");
		expect(withoutRepeatedDetail(snapshot)).toBe(
			[
				'- navigation "Main menu" [ref=e1]:',
				"  - listitem [ref=e2]:",
				'    - link "Home" [ref=e3]:',
				"      - /url: /",
				'  - button "Save changes" [ref=e4]:',
				"    - generic [ref=e5]: Save",
				"    - generic [ref=e6]: changes",
				"  - generic [ref=e7] [cursor=pointer]:",
				'    - paragraph [ref=e8]: "Open card"',
				'  - img "Logo" [ref=e9]:',
				"    - /url: /logo.png",
			].join("\n"),
		);
	});

	it("keeps a snapshot with nothing repeated byte for byte", () => {
		const snapshot = [
			'- heading "Sign in" [level=1] [ref=e1]',
			'- textbox "Email" [ref=e2]',
			'- checkbox "Remember me" [checked] [ref=e3]',
			'- list "Recent" [ref=e4]:',
			"  - listitem [ref=e5]: Invoice INV-2041",
			'- region "Help" [ref=e6]:',
			'  - paragraph [ref=e7]: "Call us: 555-0100"',
		].join("\n");
		expect(withoutRepeatedDetail(snapshot)).toBe(snapshot);
	});

	it("compacts after leaving out bare wrappers, so a wrapper's content still makes its parent's name", () => {
		const snapshot = [
			'- listitem "Order 1042 Shipped" [ref=e1]:',
			"  - generic [ref=e2]:",
			"    - strong [ref=e3]: Order 1042",
			"    - generic [ref=e4]: Shipped",
		].join("\n");
		expect(compactSnapshot(snapshot)).toBe(
			["- listitem [ref=e1]:", "  - strong [ref=e3]: Order 1042", "  - generic [ref=e4]: Shipped"].join("\n"),
		);
	});
});
