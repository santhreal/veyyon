/**
 * The `/tree` card answers the pointer: rows, wheel, and card chrome.
 *
 * WHAT THIS CLOSES. The session tree was the last list picker mounted by
 * swapping the composer out for a bare `DynamicBorder` stack. It advertised
 * "up/down move, enter jump" and consumed no mouse input at all: no hover, no
 * click-to-jump, no wheel, and no close glyph, because it painted no card to
 * hold one. Moving it onto ModalShell is what makes those targets exist, so
 * this suite pins the contract the card now owes — the same one every other
 * ModalShell picker keeps: hover bands the row under the pointer, a click
 * jumps to that entry exactly as Enter does, a wheel notch steps the
 * selection, and the chrome (close glyph, close chip, click-outside) cancels.
 *
 * The label editor is covered because it is the one body that is NOT a list:
 * while it owns the card, close means "abandon the edit", and the rows behind
 * it must not answer a click that lands on them.
 *
 * WHAT IT DOES NOT CATCH. It drives the component directly, so it says nothing
 * about whether the host mounts it as a fullscreen overlay — the mouse only
 * reaches a component the host focused. That wiring is one line in
 * `selector-controller.ts` and is checked by the app-wide overlay sweep.
 *
 * Colour is forced ON: `theme.bg` returns its argument unchanged when colour
 * is off, so under the default piped policy a banded row is byte-identical to
 * a plain one and no assertion could tell them apart.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { TreeSelectorComponent } from "@veyyon/coding-agent/modes/components/tree-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@veyyon/coding-agent/session/session-entries";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 110;
const BG_OPEN = /\x1b\[48;/;

let policy: AnsiPolicy;
let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
});

afterEach(() => {
	setAnsiPolicy(policy);
	geometry.restore();
});

/** SGR motion (button 32+3=35), left press, and wheel at 1-based screen coords. */
function motionAt(row1: number, col1 = 40): string {
	return `\x1b[<35;${col1};${row1}M`;
}
function clickAt(row1: number, col1 = 40): string {
	return `\x1b[<0;${col1};${row1}M`;
}
function wheelAt(direction: "up" | "down", row1: number, col1 = 40): string {
	return `\x1b[<${direction === "down" ? 65 : 64};${col1};${row1}M`;
}

let counter = 0;
function userNode(text: string, parentId: string | null = null): SessionTreeNode {
	const id = `e${counter++}`;
	const message: AgentMessage = { role: "user", content: text, timestamp: counter };
	const entry: SessionEntry = { type: "message", id, parentId, timestamp: new Date().toISOString(), message };
	return { entry, children: [] };
}

interface Harness {
	component: TreeSelectorComponent;
	jumped: string[];
	cancelled: number;
	ids: { first: string; second: string; third: string };
	rows: () => string[];
}

/** A three-message chain with the newest entry as the current leaf. */
function makeTree(): Harness {
	const first = userNode("alpha the first prompt");
	const second = userNode("bravo the second prompt", first.entry.id);
	first.children.push(second);
	const third = userNode("charlie the third prompt", second.entry.id);
	second.children.push(third);

	const jumped: string[] = [];
	const harness: Harness = {
		component: undefined as unknown as TreeSelectorComponent,
		jumped,
		cancelled: 0,
		ids: { first: first.entry.id, second: second.entry.id, third: third.entry.id },
		rows: () => [],
	};
	harness.component = new TreeSelectorComponent(
		[first],
		third.entry.id,
		id => jumped.push(id),
		() => {
			harness.cancelled += 1;
		},
	);
	harness.rows = () => [...harness.component.render(WIDTH)];
	return harness;
}

/** 1-based screen row of the first rendered line containing `text`. */
function rowOf(harness: Harness, text: string): number {
	const index = harness.rows().findIndex(line => line.includes(text));
	expect(index, `row containing ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
	return index + 1;
}

/** 1-based row/col of the close glyph, from the frame the card last painted. */
function closeGlyph(harness: Harness): { row: number; col: number } {
	const lines = harness.rows();
	const row = lines.findIndex(line => Bun.stripANSI(line).includes("[x]"));
	expect(row, "close glyph row").toBeGreaterThanOrEqual(0);
	return { row: row + 1, col: Bun.stripANSI(lines[row] as string).indexOf("[x]") + 2 };
}

describe("the session tree card answers the pointer", () => {
	it("bands the row under the pointer without moving the cursor", () => {
		const harness = makeTree();
		const row = rowOf(harness, "bravo the second prompt");
		const before = harness.rows()[row - 1] as string;

		harness.component.handleInput(motionAt(row));
		const after = harness.rows()[row - 1] as string;

		expect(after).not.toBe(before);
		expect(after).toMatch(BG_OPEN);
		expect(after).toContain("bravo the second prompt");
		// Hover is not selection: nothing was jumped to.
		expect(harness.jumped).toEqual([]);
	});

	it("jumps to the entry under a click, exactly as Enter does", () => {
		const harness = makeTree();

		harness.component.handleInput(clickAt(rowOf(harness, "alpha the first prompt")));

		expect(harness.jumped).toEqual([harness.ids.first]);
	});

	it("steps the selection on a wheel notch", () => {
		const harness = makeTree();
		// The leaf starts selected; one notch up moves the cursor to its parent,
		// and Enter then confirms that row rather than the leaf.
		harness.component.handleInput(wheelAt("up", rowOf(harness, "bravo the second prompt")));
		harness.component.handleInput("\n");

		expect(harness.jumped).toEqual([harness.ids.second]);
	});

	it("closes on the close glyph, the close chip, and a click outside the card", () => {
		for (const clickTarget of ["glyph", "chip", "outside"] as const) {
			const harness = makeTree();
			if (clickTarget === "glyph") {
				const glyph = closeGlyph(harness);
				harness.component.handleInput(clickAt(glyph.row, glyph.col));
			} else if (clickTarget === "chip") {
				const chip = closeChip(harness);
				harness.component.handleInput(clickAt(chip.row, chip.col));
			} else {
				// A card hit-tests against its LAST paint, so the frame has to exist
				// before a click can land outside it.
				harness.rows();
				harness.component.handleInput(clickAt(1, 1));
			}

			expect(harness.cancelled, clickTarget).toBe(1);
			expect(harness.jumped, clickTarget).toEqual([]);
		}
	});

	it("leaves the card up when the label editor is closed, and ignores clicks on the rows behind it", () => {
		const harness = makeTree();
		// Paint the tree FIRST, so the row map the pointer would hit is populated:
		// the guard is only meaningful against rows the card actually painted.
		const rowBehind = rowOf(harness, "bravo the second prompt");
		harness.component.handleInput("L"); // shift+L opens the label editor
		expect(Bun.stripANSI(harness.rows().join("\n"))).toContain("Label (empty to remove)");

		// The editor owns the body; a click on a row the tree used to paint there
		// must not jump the session out from under the text field.
		harness.component.handleInput(clickAt(rowBehind));
		expect(harness.jumped).toEqual([]);

		const glyph = closeGlyph(harness);
		harness.component.handleInput(clickAt(glyph.row, glyph.col));

		// The editor is abandoned and the tree is back; the picker itself stays up.
		expect(harness.cancelled).toBe(0);
		expect(Bun.stripANSI(harness.rows().join("\n"))).not.toContain("Label (empty to remove)");
		expect(Bun.stripANSI(harness.rows().join("\n"))).toContain("charlie the third prompt");
	});
});

/**
 * 1-based row/col inside the "esc close" chip. The chip is read from the
 * stripped frame: the key and its label are styled separately, so the raw line
 * never carries the two words next to each other.
 */
function closeChip(harness: Harness): { row: number; col: number } {
	const lines = harness.rows().map(row => Bun.stripANSI(row));
	const row = lines.findIndex(line => line.includes("esc close"));
	expect(row, "footer row carrying the close chip").toBeGreaterThanOrEqual(0);
	return { row: row + 1, col: (lines[row] as string).indexOf("esc close") + 2 };
}
