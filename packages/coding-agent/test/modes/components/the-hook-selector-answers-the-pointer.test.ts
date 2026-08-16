/**
 * WHY. The hook selector is the surface behind every `ask`, every extension
 * `ui.select`, the large-paste prompt and the MCP registry list. It used to be
 * a bare list inside a DynamicBorder: keyboard only, no chrome, and a mouse
 * report fell through to the composer. It is now a ModalShell card, and a card
 * that draws a close glyph and clickable footer chips has to answer the
 * pointer, or it advertises affordances that do nothing.
 *
 * THE CLASS THIS CLOSES. Every pointer gesture the card can receive: hover on
 * an option, hover on a chip, click on an option (including a wrapped
 * continuation row of that option), click on a disabled option, wheel, the
 * close glyph, a click outside the card, and each clickable chip. The footer
 * set itself is pinned by exact equality, so adding a chip turns this suite RED
 * until someone decides what the pointer does with it — that is the member-space
 * gate, since a chip is the one part of this surface that grows.
 *
 * It also covers the second presentation. The selector renders either as its
 * own card or `"embedded"` inside a host's card (the session picker's delete
 * confirmation), and only the card routes its own mouse: the embedded host owns
 * the pointer and asks `hitTestOption` / `selectOptionAt` / `setHoveredOption` /
 * `handleWheel`. Both are exercised, because a fix applied to one presentation
 * and not the other is exactly how half this class survives.
 *
 * WHAT IT DOES NOT CATCH. One width and one height, so nothing about chip
 * wrapping onto a second footer row is asserted, and nothing about the reveal
 * animation's intermediate frames. It drives the component directly rather than
 * through `extension-ui-controller`, so the overlay mount is covered by
 * `hook-editor.test.ts` instead.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HookSelectorComponent } from "@veyyon/coding-agent/modes/components/hook-selector";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 110;
const ROWS = 40;

let policy: AnsiPolicy;
let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: ROWS });
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

interface Harness {
	selector: HookSelectorComponent;
	picked: string[];
	cancelled: number;
	renders: number;
	rows: () => string[];
	stripped: () => string[];
}

type SelectorOptions = ConstructorParameters<typeof HookSelectorComponent>[4];

function makeSelector(
	options: ConstructorParameters<typeof HookSelectorComponent>[1],
	opts?: SelectorOptions,
	title = "Pick one",
): Harness {
	const harness: Harness = {
		selector: undefined as unknown as HookSelectorComponent,
		picked: [],
		cancelled: 0,
		renders: 0,
		rows: () => [],
		stripped: () => [],
	};
	harness.selector = new HookSelectorComponent(
		title,
		options,
		label => harness.picked.push(label),
		() => {
			harness.cancelled += 1;
		},
		{ ...opts, onRequestRender: () => (harness.renders += 1) },
	);
	harness.rows = () => [...harness.selector.render(WIDTH)];
	harness.stripped = () => harness.rows().map(line => Bun.stripANSI(line));
	return harness;
}

/** 1-based screen row of the first rendered line containing `text`. */
function rowOf(harness: Harness, text: string): number {
	const index = harness.stripped().findIndex(line => line.includes(text));
	expect(index, `row containing ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
	return index + 1;
}

/** 1-based row/col of the close glyph, from the frame the card last painted. */
function closeGlyph(harness: Harness): { row: number; col: number } {
	const lines = harness.stripped();
	const row = lines.findIndex(line => line.includes("[x]"));
	expect(row, "close glyph row").toBeGreaterThanOrEqual(0);
	return { row: row + 1, col: (lines[row] as string).indexOf("[x]") + 2 };
}

/**
 * 1-based row/col inside a footer chip. Chips are read from the STRIPPED frame:
 * the key and its label are styled separately, so the raw line never carries
 * the two words next to each other.
 */
function chip(harness: Harness, label: string): { row: number; col: number } {
	const lines = harness.stripped();
	const row = lines.findIndex(line => line.includes(label));
	expect(row, `footer row carrying ${JSON.stringify(label)}`).toBeGreaterThanOrEqual(0);
	return { row: row + 1, col: (lines[row] as string).indexOf(label) + 2 };
}

/** Footer chip labels, in order, from the last painted frame. */
function chipLabels(harness: Harness): string[] {
	const lines = harness.stripped();
	const row = lines.findLast(line => line.includes("·"));
	expect(row, "footer row").toBeDefined();
	return (row as string)
		.replaceAll("│", "")
		.split("·")
		.map(part => part.trim())
		.filter(part => part.length > 0);
}

/** Background-open sequence of the row-selection band, for band assertions. */
function bandOpen(): string {
	const probe = theme.bg("selectedBg", "|");
	return probe.slice(0, probe.indexOf("|"));
}

/** Rendered lines that carry the selection/hover band. */
function bandedRows(harness: Harness): string[] {
	const open = bandOpen();
	return harness.rows().filter(line => line.includes(open));
}

describe("the hook selector card answers the pointer", () => {
	it("paints a titled card with a close glyph and the house list chips", () => {
		const harness = makeSelector(["Alpha", "Beta", "Gamma"]);
		const frame = harness.stripped();

		expect(frame.some(line => line.includes("Pick one"))).toBe(true);
		expect(frame.some(line => line.includes("[x]"))).toBe(true);
		// Pinned by equality: a new chip must come with a decision about what a
		// click on it does, and this is what forces that decision.
		expect(chipLabels(harness)).toEqual(["up/down navigate", "enter select", "esc/ctrl+c close"]);
	});

	it("takes the caller's helpText as the chips, because the caller named its own keys", () => {
		const harness = makeSelector(["Yes", "No"], {
			helpText: "space toggle  enter confirm  esc cancel",
		});

		expect(chipLabels(harness)).toEqual(["space toggle", "enter confirm", "esc cancel"]);
	});

	it("bands the option under the pointer without moving the cursor", () => {
		const harness = makeSelector(["Alpha", "Beta", "Gamma"]);
		harness.rows();
		const betaRow = rowOf(harness, "Beta");

		harness.selector.handleInput(motionAt(betaRow));
		expect(harness.renders).toBeGreaterThan(0);

		const banded = bandedRows(harness).map(line => Bun.stripANSI(line));
		// Two bands: the cursor's own row and the hovered one. Hover is a
		// preview, so Enter still takes the cursor row.
		expect(banded.some(line => line.includes("Alpha"))).toBe(true);
		expect(banded.some(line => line.includes("Beta"))).toBe(true);
		harness.selector.handleInput("\r");
		expect(harness.picked).toEqual(["Alpha"]);
	});

	it("paints one band, not two, when the pointer rests on the cursor row", () => {
		const harness = makeSelector(["Alpha", "Beta", "Gamma"]);
		harness.rows();
		const alphaRow = rowOf(harness, "Alpha");

		harness.selector.handleInput(motionAt(alphaRow));

		expect(bandedRows(harness)).toHaveLength(1);
	});

	it("clears the band when the pointer leaves the list", () => {
		const harness = makeSelector(["Alpha", "Beta", "Gamma"]);
		harness.rows();
		const betaRow = rowOf(harness, "Beta");

		harness.selector.handleInput(motionAt(betaRow));
		expect(bandedRows(harness)).toHaveLength(2);

		harness.selector.handleInput(motionAt(closeGlyph(harness).row));
		expect(bandedRows(harness)).toHaveLength(1);
	});

	it("takes the option a click lands on, exactly as Enter would", () => {
		const harness = makeSelector(["Alpha", "Beta", "Gamma"]);
		harness.rows();

		harness.selector.handleInput(clickAt(rowOf(harness, "Gamma")));

		expect(harness.picked).toEqual(["Gamma"]);
		expect(harness.cancelled).toBe(0);
	});

	it("answers a click on an option's description row with that same option", () => {
		const harness = makeSelector([
			{ label: "Alpha", description: "the first one" },
			{ label: "Beta", description: "the second one" },
		]);
		harness.rows();

		harness.selector.handleInput(clickAt(rowOf(harness, "the second one")));

		expect(harness.picked).toEqual(["Beta"]);
	});

	it("leaves a disabled option inert under the pointer, as it is under the keys", () => {
		const harness = makeSelector(["Alpha", "Beta", "Gamma"], { disabledIndices: [1] });
		harness.rows();
		const betaRow = rowOf(harness, "Beta");

		harness.selector.handleInput(clickAt(betaRow));
		expect(harness.picked).toEqual([]);

		// The cursor did not move onto it either: Enter still takes Alpha.
		harness.selector.handleInput("\r");
		expect(harness.picked).toEqual(["Alpha"]);
	});

	it("steps the cursor on a wheel notch", () => {
		const harness = makeSelector(["Alpha", "Beta", "Gamma"]);
		harness.rows();
		const listRow = rowOf(harness, "Beta");

		harness.selector.handleInput(wheelAt("down", listRow));
		harness.selector.handleInput("\r");
		expect(harness.picked).toEqual(["Beta"]);

		harness.selector.handleInput(wheelAt("up", listRow));
		harness.selector.handleInput("\r");
		expect(harness.picked).toEqual(["Beta", "Alpha"]);
	});

	it("cancels on the close glyph, on a click outside the card, and on the close chip", () => {
		for (const gesture of ["close-glyph", "outside", "chip"] as const) {
			const harness = makeSelector(["Alpha", "Beta"]);
			harness.rows();
			const target =
				gesture === "close-glyph"
					? closeGlyph(harness)
					: gesture === "chip"
						? chip(harness, "close")
						: { row: 1, col: 1 };

			harness.selector.handleInput(clickAt(target.row, target.col));

			expect(harness.cancelled, gesture).toBe(1);
			expect(harness.picked, gesture).toEqual([]);
		}
	});

	it("confirms the cursor row from the select chip", () => {
		const harness = makeSelector(["Alpha", "Beta"]);
		harness.rows();
		const select = chip(harness, "select");

		harness.selector.handleInput(clickAt(select.row, select.col));

		expect(harness.picked).toEqual(["Alpha"]);
		expect(harness.cancelled).toBe(0);
	});

	it("repaints a chip as it is hovered and once more as the pointer leaves it", () => {
		const harness = makeSelector(["Alpha", "Beta"]);
		harness.rows();
		const select = chip(harness, "select");

		harness.selector.handleInput(motionAt(select.row, select.col));
		const afterEnter = harness.renders;
		expect(afterEnter).toBeGreaterThan(0);

		// Resting on the same chip is not a change, so it must not repaint.
		harness.selector.handleInput(motionAt(select.row, select.col));
		expect(harness.renders).toBe(afterEnter);

		harness.selector.handleInput(motionAt(rowOf(harness, "Alpha")));
		expect(harness.renders).toBeGreaterThan(afterEnter);
	});
});

describe("the embedded hook selector hands its pointer to the host", () => {
	/** Body lines of an embedded selector: no card, so these are its own rows. */
	function embedded(options: string[], opts?: SelectorOptions) {
		const harness = makeSelector(options, { ...opts, presentation: "embedded" }, "Delete session?\nmy-session");
		return harness;
	}

	it("draws no card frame of its own, so two frames never nest", () => {
		const harness = embedded(["Yes", "No"]);
		const frame = harness.stripped();

		expect(frame.some(line => line.includes("[x]"))).toBe(false);
		expect(frame.some(line => line.includes("·"))).toBe(false);
		// The whole title belongs to the body here; the host's card owns the bar.
		expect(frame.some(line => line.includes("Delete session?"))).toBe(true);
		expect(frame.some(line => line.includes("my-session"))).toBe(true);
	});

	it("ignores mouse reports itself, because the host owns the pointer", () => {
		const harness = embedded(["Yes", "No"]);
		const lines = harness.stripped();
		const yes = lines.findIndex(line => line.includes("Yes"));

		harness.selector.handleInput(clickAt(yes + 1));

		expect(harness.picked).toEqual([]);
		expect(harness.cancelled).toBe(0);
	});

	it("answers hitTestOption, selectOptionAt, setHoveredOption and handleWheel for the host", () => {
		const harness = embedded(["Yes", "No"], { initialIndex: 1 });
		const lines = harness.stripped();
		const yes = lines.findIndex(line => line.includes("Yes"));
		const no = lines.findIndex(line => line.includes("No"));
		const heading = lines.findIndex(line => line.includes("Delete session?"));

		expect(harness.selector.hitTestOption(yes)).toBe(0);
		expect(harness.selector.hitTestOption(no)).toBe(1);
		expect(harness.selector.hitTestOption(heading)).toBeUndefined();

		// Hover reports whether the host needs to repaint, and never repeats.
		expect(harness.selector.setHoveredOption(0)).toBe(true);
		expect(harness.selector.setHoveredOption(0)).toBe(false);
		expect(bandedRows(harness)).toHaveLength(2);
		expect(harness.selector.setHoveredOption(null)).toBe(true);

		harness.selector.handleWheel(-1);
		expect(harness.selector.selectOptionAt(heading)).toBe(false);
		expect(harness.picked).toEqual([]);
		expect(harness.selector.selectOptionAt(yes)).toBe(true);
		expect(harness.picked).toEqual(["Yes"]);
	});

	it("refuses a disabled row through the host's click path too", () => {
		const harness = embedded(["Yes", "No"], { disabledIndices: [0] });
		const yes = harness.stripped().findIndex(line => line.includes("Yes"));

		expect(harness.selector.selectOptionAt(yes)).toBe(false);
		expect(harness.picked).toEqual([]);
	});
});
