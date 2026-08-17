/**
 * WHY: a card is now MATERIAL — an explicit background on every cell it owns, a
 * per-row cascade while it unfolds, and a specular sweep crossing it — and every
 * one of those writes a colour mixed out of "the ground behind this row". That
 * makes three whole classes of defect possible at once, and this suite closes all
 * three rather than the one that happened to be noticed:
 *
 *   1. PAINTING OUTSIDE THE CARD. A card row is as wide as the screen; the padding
 *      that centres the card belongs to the page. A treatment handed the whole row
 *      puts the card's fill and its light out on the page beside it, and during the
 *      unfold also onto the blank rows below the sliding bottom border.
 *   2. PAINTING OUT OF A GROUND THAT IS NOT THERE. `visibleGroundHex` falls back to
 *      the theme's DECLARED ground when the terminal answered no OSC 11, and
 *      titanium declares black. A black-derived fill laid on a grey terminal is the
 *      dark-slab regression of 2026-07-22, which is also what the pointer-band
 *      suites forbid in as many words. A ground that is not KNOWN gets no material.
 *   3. AN ANIMATION OUTLIVING ITS CARD. The sweep runs twice as long as the unfold,
 *      so a card dismissed mid-entrance leaves it live on the shared clock, which
 *      then ticks with nothing to show.
 *
 * The subject is the production seam (`renderModalShell` then `applyModalReveal`)
 * and the real driver, because the geometry is what the containment claim is about;
 * asserting the primitives alone would prove the maths and miss the wiring.
 *
 * NOT covered here: what the material LOOKS like (a lift of 5.5% versus 8% is
 * taste, and `scripts/demos/render-overlay-entrance.ts` is where that is judged),
 * and the sixteen-colour path beyond byte-identity — a terminal that cannot take
 * `48;2` gets no treatment at all, which is asserted, but nothing here proves the
 * fallback is pretty.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type AnsiPolicy, getAnsiPolicy, motionClock, setAnsiPolicy, TERMINAL, visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import {
	applyModalReveal,
	MODAL_SIZING_SETTINGS,
	type ModalShellGeometry,
	ModalRevealDriver,
	type ModalShellResult,
	renderModalShell,
} from "../../../src/modes/components/modal-shell";
import { getThemeByName, initTheme, setThemeInstance } from "../../../src/modes/theme/theme";
import { resetGroundTintsForTest, setDetectedTerminalGround } from "../../../src/modes/theme/ground-tints";

const WIDTH = 100;
const HEIGHT = 30;
/** A grey terminal, which is the ground the slab regression was shipped onto. */
const TERMINAL_GREY = "#1e2127";
/** The one writable capability this suite drives; `TERMINAL` declares it readonly. */
const terminalCaps: { trueColor: boolean } = TERMINAL;

let policy: AnsiPolicy;
let trueColorWas: boolean;

function shell(bodyRows = 12): ModalShellResult {
	const body = Array.from({ length: bodyRows }, (_, row) => `body row ${row}`);
	return renderModalShell({
		title: "Settings",
		sizing: MODAL_SIZING_SETTINGS,
		areaWidth: WIDTH,
		areaHeight: HEIGHT,
		body,
		shortcuts: [{ id: "close", label: "esc close" }],
	});
}

function geometryOf(result: ModalShellResult): ModalShellGeometry {
	const geometry = result.geometry;
	if (geometry === null) throw new Error("the card did not fit, so there is nothing to assert");
	return geometry;
}

/**
 * Every column of a row that carries a truecolor background, by walking the row
 * the way a terminal does: visible width for text, parameters for the colour.
 *
 * A column-set rather than a span list, because the claim is about WHERE paint
 * lands, and a span that starts inside the card and runs off its edge is exactly
 * the defect a start-column list would call clean.
 */
function paintedColumns(line: string): Set<number> {
	const painted = new Set<number>();
	const sgr = /\x1b\[([0-9;:]*)m/g;
	let col = 0;
	let index = 0;
	let background: string | null = null;
	const advance = (text: string): void => {
		const width = visibleWidth(text);
		for (let step = 0; step < width; step++) {
			if (background !== null) painted.add(col + step);
		}
		col += width;
	};
	for (let match = sgr.exec(line); match !== null; match = sgr.exec(line)) {
		advance(line.slice(index, match.index));
		index = match.index + match[0].length;
		const params = match[1] ?? "";
		if (params.includes("48;2")) background = params;
		else if (params === "49" || params === "0" || params === "") background = null;
	}
	advance(line.slice(index));
	return painted;
}

beforeEach(async () => {
	await initTheme(false);
	const titanium = await getThemeByName("titanium");
	if (!titanium) throw new Error("titanium theme unavailable");
	setThemeInstance(titanium);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	trueColorWas = terminalCaps.trueColor;
	terminalCaps.trueColor = true;
	resetGroundTintsForTest();
});

afterEach(() => {
	motionClock.clear();
	setAnsiPolicy(policy);
	terminalCaps.trueColor = trueColorWas;
	resetGroundTintsForTest();
});

describe("a card paints its material only inside its own edges", () => {
	it("keeps the settled surface between the card's own columns", () => {
		setDetectedTerminalGround(TERMINAL_GREY);
		const result = shell();
		const geometry = geometryOf(result);
		const lines = applyModalReveal(result, WIDTH, 1);

		let painted = 0;
		for (let row = geometry.cardRowStart; row < geometry.cardRowEnd; row++) {
			const columns = paintedColumns(lines[row] ?? "");
			painted += columns.size;
			for (const col of columns) {
				expect(col, `row ${row} painted column ${col} outside the card`).toBeGreaterThanOrEqual(geometry.cardColStart);
				expect(col, `row ${row} painted column ${col} outside the card`).toBeLessThan(geometry.cardColEnd);
			}
		}
		// The material has to actually exist, or containment is trivially true.
		expect(painted, "a settled card carries a surface").toBeGreaterThan(0);

		// The page rows above and below the card are never touched.
		for (const row of [0, geometry.cardRowStart - 1, geometry.cardRowEnd, HEIGHT - 1]) {
			if (row < 0 || row >= HEIGHT) continue;
			expect(paintedColumns(lines[row] ?? "").size, `page row ${row} carries paint`).toBe(0);
		}
	});

	it("keeps the sweep inside the card at every phase of its travel", () => {
		setDetectedTerminalGround(TERMINAL_GREY);
		const result = shell();
		const geometry = geometryOf(result);
		let sawLight = false;
		for (const sweep of [0.01, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.99]) {
			const lines = applyModalReveal(result, WIDTH, { value: 1, sweep });
			for (let row = geometry.cardRowStart; row < geometry.cardRowEnd; row++) {
				for (const col of paintedColumns(lines[row] ?? "")) {
					expect(col, `sweep ${sweep} row ${row} lit column ${col} outside the card`).toBeGreaterThanOrEqual(
						geometry.cardColStart,
					);
					expect(col, `sweep ${sweep} row ${row} lit column ${col} outside the card`).toBeLessThan(geometry.cardColEnd);
				}
			}
			// A sweep that paints nothing anywhere would satisfy every containment
			// claim above, so at least one phase must differ from the settled card.
			if (lines.join("\n") !== applyModalReveal(result, WIDTH, 1).join("\n")) sawLight = true;
		}
		expect(sawLight, "some phase of the sweep changes the card").toBe(true);
	});

	it("never lights the blank rows the unfold has not reached", () => {
		setDetectedTerminalGround(TERMINAL_GREY);
		const result = shell();
		const geometry = geometryOf(result);
		const cardRows = geometry.cardRowEnd - geometry.cardRowStart;
		for (const value of [0.1, 0.25, 0.5, 0.75, 0.9]) {
			const lines = applyModalReveal(result, WIDTH, { value, sweep: 0.5 });
			const visible = Math.max(2, Math.round(cardRows * value));
			for (let cardRow = visible; cardRow < cardRows; cardRow++) {
				const line = lines[geometry.cardRowStart + cardRow] ?? "";
				expect(paintedColumns(line).size, `unfold ${value} lit blank card row ${cardRow}`).toBe(0);
				expect(stripAnsi(line).trim(), `unfold ${value} wrote text on blank card row ${cardRow}`).toBe("");
			}
		}
	});

	it("paints no material at all when the ground behind the card is unknown", () => {
		// No OSC 11 answer and no paint: `visibleGroundHex` would hand back titanium's
		// DECLARED black, and a black-derived fill on a grey terminal is a dark slab.
		const result = shell();
		const settled = applyModalReveal(result, WIDTH, 1);
		expect(settled).toEqual(result.lines);
		// Mid-entrance the clip and the fade still play — they are colour-agnostic —
		// but no cell gains a background it did not have.
		const opening = applyModalReveal(result, WIDTH, { value: 0.5, sweep: 0.5 });
		const geometry = geometryOf(result);
		for (let row = geometry.cardRowStart; row < geometry.cardRowEnd; row++) {
			expect(paintedColumns(opening[row] ?? "").size, `row ${row} painted with no known ground`).toBe(0);
		}
		expect(opening).not.toEqual(result.lines);
	});

	it("paints no material on a terminal that cannot take truecolor", () => {
		setDetectedTerminalGround(TERMINAL_GREY);
		terminalCaps.trueColor = false;
		const result = shell();
		expect(applyModalReveal(result, WIDTH, 1)).toEqual(result.lines);
		const geometry = geometryOf(result);
		const opening = applyModalReveal(result, WIDTH, { value: 0.5, sweep: 0.5 });
		for (let row = geometry.cardRowStart; row < geometry.cardRowEnd; row++) {
			expect(paintedColumns(opening[row] ?? "").size, `row ${row} painted on a 16-colour terminal`).toBe(0);
		}
	});

	it("crosses a background the card gave itself without erasing it", () => {
		setDetectedTerminalGround(TERMINAL_GREY);
		// A selection band is the component saying "this cell is not the surface".
		const band = `\x1b[48;2;120;60;20m${"selected row".padEnd(40)}\x1b[49m`;
		const result = renderModalShell({
			title: "Settings",
			sizing: MODAL_SIZING_SETTINGS,
			areaWidth: WIDTH,
			areaHeight: HEIGHT,
			body: ["plain row", band, "plain row"],
			shortcuts: [{ id: "close", label: "esc close" }],
		});
		const geometry = geometryOf(result);
		const bandRow = result.lines.findIndex(line => stripAnsi(line).includes("selected row"));
		expect(bandRow).toBeGreaterThanOrEqual(geometry.cardRowStart);

		// Settled: the band's own colour survives the fill untouched.
		const settled = applyModalReveal(result, WIDTH, 1)[bandRow] ?? "";
		expect(settled).toContain("48;2;120;60;20");

		// Lit: the band is LIFTED, not replaced — its cells are brighter than the
		// band and still nothing like the surface around them.
		const lit = applyModalReveal(result, WIDTH, { value: 1, sweep: 0.5 })[bandRow] ?? "";
		const lifted = [...lit.matchAll(/48;2;(\d+);(\d+);(\d+)/g)].map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
		const warm = lifted.filter(([r, g, b]) => r > g && g > b && r > 100);
		expect(warm.length, "the swept row still carries the band's warm colour").toBeGreaterThan(0);
		expect(warm.some(([r]) => r > 120), "the sweep lifted the band rather than leaving it flat").toBe(true);
	});
});

describe("the entrance hands the clock back", () => {
	/**
	 * `Animation.cancel` marks an animation done; the clock drops it on its next
	 * frame. So "let go of the clock" is asserted after a frame, exactly as the
	 * dismissed-picker suite does it, and a cancel that never happened still shows
	 * up: a live animation survives any number of frames.
	 */
	function nextFrame(): number {
		const now = performance.now() + 16;
		motionClock.tick(now);
		return motionClock.liveCount;
	}

	it("reports a settled sweep before it is armed and after it is stopped", () => {
		const driver = new ModalRevealDriver();
		expect(driver.sweep, "an unarmed driver is not mid-sweep").toBe(1);
		expect(motionClock.liveCount, "reading an unarmed driver starts nothing").toBe(0);

		driver.start(() => {});
		expect(driver.sweep, "the sweep is anchored on its first read, at zero").toBeLessThan(1);
		expect(driver.value, "the unfold is anchored on its first read too").toBeLessThan(1);
		expect(motionClock.liveCount, "the entrance and the sweep are both live").toBe(2);

		driver.stop();
		expect(nextFrame(), "a dismounted card leaves nothing on the clock").toBe(0);
		expect(driver.sweep).toBe(1);
		expect(motionClock.liveCount, "and reading a stopped driver starts nothing new").toBe(0);
	});

	it("drops the sweep when the card starts leaving, not when it finishes", () => {
		const driver = new ModalRevealDriver();
		driver.start(() => {});
		expect(driver.value).toBeLessThan(1);
		expect(driver.sweep).toBeLessThan(1);
		expect(motionClock.liveCount).toBe(2);
		// Let the card actually open a little first. An exit is animated FROM where the
		// unfold got to, so one launched at value 0 has nowhere to travel and lands on
		// the same frame — which would prove nothing about what the exit leaves behind.
		const opened = performance.now();
		for (let frame = 1; frame <= 6; frame++) motionClock.tick(opened + frame * 16);
		expect(driver.value, "the card is part-way open").toBeGreaterThan(0);

		let done = false;
		expect(
			driver.exit(
				() => {},
				() => {
					done = true;
				},
			),
		).toBe(true);
		// One animation left after the frame: the exit. The entrance was cancelled and
		// the sweep with it, because a leaving card is not being lit. MOTION.sweep is
		// twice MOTION.enter, so this is the case that leaked.
		expect(nextFrame(), "only the exit is still running").toBe(1);
		expect(driver.sweep, "a leaving card reports a settled sweep").toBe(1);

		driver.stop();
		expect(done, "stopping FINISHES the exit, so the host removes the card").toBe(true);
		expect(nextFrame()).toBe(0);
	});

	it("replays from zero when the same driver is started again", () => {
		const driver = new ModalRevealDriver();
		driver.start(() => {});
		expect(driver.sweep).toBeLessThan(1);
		motionClock.tick(performance.now() + 400);
		const midway = driver.sweep;
		expect(midway).toBeGreaterThan(0);

		driver.start(() => {});
		expect(driver.sweep, "a restarted entrance sweeps from the beginning").toBeLessThan(midway);
	});
});
