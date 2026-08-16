// WHY THIS SUITE EXISTS (ONE-CARD-MUST-NOT-FADE-IN-ONE-COLUMN-AND-SWITCH-IN-THE-OTHER).
//
// The settings card has two pointer surfaces two columns apart: the setting rows (a `SettingsList`,
// which cross-fades its band) and the category sidebar down the left (`TabBar.renderVertical`,
// which switched it). Pointing at a category lit it on the frame the motion report landed and
// unlit it on the frame the pointer left, beside a pane doing the opposite, in the same frame.
//
// `TabBar` owns the fade now, and the tui suite pins the component's contract. This suite pins the
// part the component cannot: that the SHIPPED card wires it. A primitive nobody lends a repaint to
// is a primitive that never animates, and that failure is invisible to a component test — the tab
// bar passes its own suite while the settings screen strobes.
//
// What it locks:
//
//   1. The band arrives. The frame the report lands on paints no fill on that row at all — strength
//      0 is the ABSENCE of a band, not a band mixed out to the ground (an explicit fill on every
//      sidebar row is invisible on black and a slab on grey).
//   2. It lands on the band the sidebar always painted, proven against a card built with motion
//      OFF rather than against a hardcoded escape: if the endpoint moved, this changed the theme
//      instead of adding motion.
//   3. Two categories band at once while the pointer crosses between them.
//   4. The active category never takes a pointer band.
//   5. It terminates, and a disposed card forgets the pointer and stops asking for frames.
//
// Colour is forced ON and the theme is built in truecolor, for the reason the hand-painted-list
// suite gives: `theme.bg` returns its argument unchanged when colour is off, so under the default
// piped policy every band here would be byte-identical to a bare row.
//
// WHAT IT DOES NOT CATCH: the other three hosts of the same component (the agents dashboard, the
// extensions dashboard, the setup wizard's provider tabs) still lend no repaint, so their bars
// switch. That is the pre-existing behavior, not a regression, and each is one `setHoverMotion`
// call away from the fade.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { getThemeByName, initTheme, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, motionClock, setAnsiPolicy, TERMINAL } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 160;
const FRAME = 1000 / 60;
/** MOTION.hover is 90ms; 30 frames is half a second, so a settle loop that runs out is a hang. */
const SETTLE_FRAMES = 30;

/** The card's motion gate is `TERMINAL.trueColor`, probed once at load from a real terminal. */
const terminalCaps: { trueColor: boolean } = TERMINAL;

let policy: AnsiPolicy;
let geometry: StubbedStdoutGeometry;
let originalTrueColor: boolean;
let originalColorterm: string | undefined;
let clockNow = 0;
let clockAnchored = false;

/**
 * Advance the shared clock. The card takes the production clock — its host lends it a repaint, not
 * a clock — so frames are driven through `tick` rather than by waiting. The anchor is re-taken
 * whenever the ticker runs dry, or the next fade is handed every millisecond already spent.
 */
function advance(ms: number): void {
	if (!clockAnchored) {
		clockNow = performance.now();
		clockAnchored = true;
	}
	clockNow += ms;
	motionClock.tick(clockNow);
	if (motionClock.liveCount === 0) clockAnchored = false;
}

function settle(): number {
	for (let frame = 1; frame <= SETTLE_FRAMES; frame++) {
		advance(FRAME);
		if (motionClock.liveCount === 0) return frame;
	}
	throw new Error(`hover fade still live after ${SETTLE_FRAMES} frames`);
}

/** `48;2;r;g;b` from a rendered row, or null when the row paints no truecolor background. */
function bandRgb(row: string): [number, number, number] | null {
	const match = /\x1b\[[0-9;]*?48;2;(\d+);(\d+);(\d+)/.exec(row);
	if (match === null) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function distance(a: [number, number, number], b: [number, number, number]): number {
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}
function createCard(requestRender: () => void = () => {}): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: ["alpha"],
			cwd: process.cwd(),
			requestRender,
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}
/**
 * The 1-based screen row and column of a category in the sidebar column. The card is centered and
 * draws `│ › Appearance   │  <pane>`, so the sidebar cell is the text between the first and second
 * hairline — searching the whole line would find the same word in the pane beside it.
 */
function categoryCell(card: SettingsSelectorComponent, label: string): { row: number; col: number } {
	const rows = card.render(WIDTH);
	const index = rows.findIndex(line => {
		const parts = stripVTControlCharacters(line).split("│");
		return parts.length > 2 && parts[1]?.trim().replace(/^›\s*/, "") === label;
	});
	expect(index, `sidebar row for ${label}`).toBeGreaterThanOrEqual(0);
	const col = stripVTControlCharacters(rows[index] as string).indexOf(label) + 1;
	return { row: index + 1, col };
}

function rowText(card: SettingsSelectorComponent, row: number): string {
	const line = card.render(WIDTH)[row - 1];
	if (line === undefined) throw new Error(`no row ${row} in a ${WIDTH}-column frame`);
	return line;
}

/** SGR motion report (button 32+3=35) at a 1-based row and column. */
function motionAt(cell: { row: number; col: number }): string {
	return `\x1b[<35;${cell.col};${cell.row}M`;
}

/** The band a card with no motion paints: the switched band every host had before the fade. */
function switchedBandRow(label: string): string {
	terminalCaps.trueColor = false;
	const twin = createCard();
	const cell = categoryCell(twin, label);
	twin.handleInput(motionAt(cell));
	const painted = rowText(twin, cell.row);
	twin.dispose();
	terminalCaps.trueColor = true;
	return painted;
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	originalColorterm = Bun.env.COLORTERM;
	Bun.env.COLORTERM = "truecolor";
	const loaded = await getThemeByName("titanium");
	if (!loaded) throw new Error("titanium theme unavailable in test env");
	if (loaded.getColorMode() !== "truecolor") throw new Error(`titanium built as ${loaded.getColorMode()}`);
	setThemeInstance(loaded);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	originalTrueColor = terminalCaps.trueColor;
	terminalCaps.trueColor = true;
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
	clockAnchored = false;
});

afterEach(() => {
	motionClock.clear();
	setAnsiPolicy(policy);
	terminalCaps.trueColor = originalTrueColor;
	geometry.restore();
	if (originalColorterm === undefined) delete Bun.env.COLORTERM;
	else Bun.env.COLORTERM = originalColorterm;
});

describe("a settings category fades under the pointer", () => {
	it("arrives over frames and lands on the band the sidebar always painted", () => {
		let renders = 0;
		const card = createCard(() => {
			renders += 1;
		});
		const cell = categoryCell(card, "Model");
		const bare = rowText(card, cell.row);
		expect(bandRgb(bare), "a category nobody points at carries no fill").toBeNull();

		card.handleInput(motionAt(cell));
		// The frame the report lands on: the fade starts at 0, so the row is untouched.
		expect(rowText(card, cell.row)).toBe(bare);

		advance(15);
		const midway = bandRgb(rowText(card, cell.row));
		expect(midway, "a band mid-fade").not.toBeNull();
		expect(renders).toBeGreaterThan(0);

		settle();
		const switched = switchedBandRow("Model");
		expect(rowText(card, cell.row)).toBe(switched);
		const full = bandRgb(switched);
		expect(full, "the switched band paints a truecolor background").not.toBeNull();
		expect(distance(midway as [number, number, number], full as [number, number, number])).toBeGreaterThan(0);
		card.dispose();
	});

	it("keeps the category the pointer left banding while the next one arrives", () => {
		const card = createCard();
		const leaving = categoryCell(card, "Model");
		const arriving = categoryCell(card, "Interaction");
		const bareLeaving = rowText(card, leaving.row);

		card.handleInput(motionAt(leaving));
		settle();
		card.handleInput(motionAt(arriving));
		advance(15);

		expect(bandRgb(rowText(card, leaving.row)), "the category the pointer left still bands").not.toBeNull();
		expect(bandRgb(rowText(card, arriving.row)), "the category the pointer reached bands").not.toBeNull();

		settle();
		expect(rowText(card, leaving.row)).toBe(bareLeaving);
		expect(rowText(card, arriving.row)).toBe(switchedBandRow("Interaction"));
		card.dispose();
	});

	it("never bands the active category", () => {
		const card = createCard();
		// Appearance is the tab the card opens on.
		const cell = categoryCell(card, "Appearance");
		const before = rowText(card, cell.row);

		card.handleInput(motionAt(cell));
		expect(rowText(card, cell.row)).toBe(before);
		advance(15);
		expect(rowText(card, cell.row)).toBe(before);
		settle();
		expect(rowText(card, cell.row)).toBe(before);
		card.dispose();
	});

	it("settles, stops asking for frames, and drops the band when the card is disposed", () => {
		let renders = 0;
		const card = createCard(() => {
			renders += 1;
		});
		const cell = categoryCell(card, "Model");
		const bare = rowText(card, cell.row);

		card.handleInput(motionAt(cell));
		expect(settle()).toBeGreaterThan(1);
		expect(motionClock.liveCount).toBe(0);

		const settledRenders = renders;
		for (let frame = 0; frame < 5; frame++) advance(FRAME);
		expect(renders).toBe(settledRenders);

		card.dispose();
		expect(rowText(card, cell.row)).toBe(bare);
		expect(motionClock.liveCount).toBe(0);
	});
});
