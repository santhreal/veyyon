/**
 * WHY: the first material a card got was one gradient over the whole plate, and on
 * a real terminal it measured twelve of 255 above the page at the top row and four
 * at the foot — over a page of 28. Nobody could see it. Worse, the gradient's lower
 * half ran BELOW the page, because "fall" mixed the bottom row toward black, so the
 * bottom of every card faded into the page it was supposed to be standing on.
 *
 * The class this closes is "a surface that is not a surface": any elevation a card
 * claims that the eye cannot find, in either direction, on either kind of terminal.
 * Four ways to land in it, and each has a case here:
 *
 *   1. NO LADDER. One wash gives the eye no edge. A card is a header tray, a body
 *      plate and a recessed footer tray, and the assertions read that ordering out
 *      of the painted bytes rather than trusting the constants.
 *   2. A ZONE THAT SINKS INTO THE PAGE. Every zone must stand strictly off the
 *      ground, at the top row and at the last body row alike.
 *   3. THE WRONG DIRECTION. On a light terminal, a lift toward white is invisible.
 *      Both grounds are swept, and a ground added to the sweep must be decided for.
 *   4. AN INSET THAT IS NOT AN INSET. A two-pane card sets its side column into the
 *      body, which only reads as a split if the two materials differ AND the inset
 *      stops at the hairline. The subject there is the shipped `/settings` card.
 *
 * The subject is always the production seam — `renderModalShell` then
 * `applyModalReveal`, and the real `SettingsSelectorComponent` for the inset —
 * because a constant asserted against itself proves nothing about the card.
 *
 * NOT covered here: how large the steps should be (0.10 versus 0.14 is taste, and
 * `scripts/demos/render-overlay-entrance.ts` plus a real-terminal recording are
 * where that is judged); and the material's interaction with the sweep, which the
 * containment suite beside this one owns.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	applyModalReveal,
	cardInsetHex,
	MODAL_SIZING_SETTINGS,
	type ModalShellGeometry,
	type ModalShellResult,
	renderModalShell,
} from "@veyyon/coding-agent/modes/components/modal-shell";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { resetGroundTintsForTest, setDetectedTerminalGround } from "@veyyon/coding-agent/modes/theme/ground-tints";
import { getThemeByName, initTheme, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import {
	type AnsiPolicy,
	getAnsiPolicy,
	liftHex,
	motionClock,
	setAnsiPolicy,
	TERMINAL,
	visibleWidth,
} from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 100;
const HEIGHT = 30;

/**
 * How far apart two MATERIALS have to be, in BT.601 luminance, before the eye
 * reads them as two things. Seven of 255 on a dark page, which is about where a
 * terminal cell stops looking like its neighbour; the failed first attempt was
 * measured at one of 255 between the plate's foot and the page.
 */
const MATERIAL_STEP = 0.03;
/**
 * The grade down ONE plate is deliberately gentler than a step between two: it is
 * the plate being lit from above, not a second surface. Still has to be findable.
 */
const PLATE_GRADE = 0.012;

/**
 * The grounds a card may be opened on, and the direction "off the page" points on
 * each. Adding a ground here without deciding its direction turns the sweep red,
 * which is the point: a third kind of terminal must not inherit a guess.
 */
const GROUNDS = [
	{ name: "a grey terminal", hex: "#1e2127", brighter: true },
	{ name: "a black terminal", hex: "#000000", brighter: true },
	{ name: "a paper-white terminal", hex: "#f7f7f8", brighter: false },
] as const;

/** The one writable capability this suite drives; `TERMINAL` declares it readonly. */
const terminalCaps: { trueColor: boolean } = TERMINAL;

let policy: AnsiPolicy;
let trueColorWas: boolean;
let stdout: StubbedStdoutGeometry;

function shell(bodyRows = 12): ModalShellResult {
	const body = Array.from({ length: bodyRows }, (_, row) => `body row ${row}`);
	return renderModalShell({
		title: "Settings",
		sizing: MODAL_SIZING_SETTINGS,
		areaWidth: WIDTH,
		areaHeight: HEIGHT,
		body,
		searchLine: "search settings",
		shortcuts: [{ id: "close", label: "esc close" }],
	});
}

function geometryOf(result: ModalShellResult): ModalShellGeometry {
	const geometry = result.geometry;
	if (geometry === null) throw new Error("the card did not fit, so there is nothing to assert");
	return geometry;
}

/** The truecolor background in effect at every column of a row, as `#rrggbb`. */
function backgroundsByColumn(line: string): Map<number, string> {
	const found = new Map<number, string>();
	const sgr = /\x1b\[([0-9;:]*)m/g;
	let col = 0;
	let index = 0;
	let background: string | null = null;
	const advance = (text: string): void => {
		const width = visibleWidth(text);
		for (let step = 0; step < width; step++) {
			if (background !== null) found.set(col + step, background);
		}
		col += width;
	};
	for (let match = sgr.exec(line); match !== null; match = sgr.exec(line)) {
		advance(line.slice(index, match.index));
		index = match.index + match[0].length;
		const params = match[1] ?? "";
		const truecolor = /48;2;(\d+);(\d+);(\d+)/.exec(params);
		if (truecolor !== null) {
			const channel = (value: string) => Number(value).toString(16).padStart(2, "0");
			background = `#${channel(truecolor[1] as string)}${channel(truecolor[2] as string)}${channel(truecolor[3] as string)}`;
		} else if (params === "49" || params === "0" || params === "") background = null;
	}
	advance(line.slice(index));
	return found;
}

/** BT.601, the weighting the terminal itself uses to call a ground light or dark. */
function luminance(hex: string): number {
	const value = Number.parseInt(hex.slice(1), 16);
	const r = (value >> 16) & 0xff;
	const g = (value >> 8) & 0xff;
	const b = value & 0xff;
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * The material a row is made of: the background covering most of the card's own
 * columns. The mode rather than one sampled column, because a row carries text, a
 * selection band and a scrollbar thumb, and any of those is a colour that is not
 * the surface.
 */
function rowMaterial(line: string, geometry: ModalShellGeometry): string {
	const backgrounds = backgroundsByColumn(line);
	const tally = new Map<string, number>();
	for (let col = geometry.cardColStart; col < geometry.cardColEnd; col++) {
		const hex = backgrounds.get(col);
		if (hex === undefined) continue;
		tally.set(hex, (tally.get(hex) ?? 0) + 1);
	}
	let best = "";
	let bestCount = 0;
	for (const [hex, count] of tally) {
		if (count > bestCount) {
			best = hex;
			bestCount = count;
		}
	}
	if (best === "") throw new Error("the row carries no material at all");
	return best;
}

/** The zones of a settled card, each as the colour its rows are actually painted. */
function zonesOf(ground: string): {
	page: string;
	header: string;
	bodyTop: string;
	bodyBottom: string;
	tray: string;
	geometry: ModalShellGeometry;
	lines: readonly string[];
} {
	setDetectedTerminalGround(ground);
	const result = shell();
	const geometry = geometryOf(result);
	const lines = applyModalReveal(result, WIDTH, 1, ground);
	const lastBody = geometry.bodyRowStart + geometry.bodyRowCount - 1;
	return {
		page: ground,
		header: rowMaterial(lines[geometry.titleRow] as string, geometry),
		bodyTop: rowMaterial(lines[geometry.bodyRowStart] as string, geometry),
		bodyBottom: rowMaterial(lines[lastBody] as string, geometry),
		tray: rowMaterial(lines[geometry.shortcutRowStart] as string, geometry),
		geometry,
		lines,
	};
}

function createSettingsCard(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["titanium"],
			availablePersonalities: ["default"],
			providers: ["anthropic"],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	const titanium = await getThemeByName("titanium");
	if (!titanium) throw new Error("titanium theme unavailable");
	setThemeInstance(titanium);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	trueColorWas = terminalCaps.trueColor;
	terminalCaps.trueColor = true;
	stdout = stubStdoutGeometry({ columns: WIDTH, rows: HEIGHT });
	resetGroundTintsForTest();
});

afterEach(() => {
	motionClock.clear();
	setAnsiPolicy(policy);
	terminalCaps.trueColor = trueColorWas;
	stdout.restore();
	resetGroundTintsForTest();
});

describe("a card is a stack of materials, not one wash", () => {
	for (const ground of GROUNDS) {
		it(`stands every zone off the page on ${ground.name}`, () => {
			const zones = zonesOf(ground.hex);
			const page = luminance(zones.page);
			// The whole defect in one assertion: a zone level with the page, or on the
			// far side of it, is a zone the eye reads as page.
			for (const [name, hex] of [
				["header tray", zones.header],
				["body top", zones.bodyTop],
				["body bottom", zones.bodyBottom],
				["footer tray", zones.tray],
			] as const) {
				expect(hex, `${name} paints something`).not.toBe(zones.page);
				const off = luminance(hex) - page;
				if (ground.brighter) expect(off, `${name} stands off a dark page`).toBeGreaterThan(0.008);
				else expect(off, `${name} stands off a light page`).toBeLessThan(-0.008);
			}
		});

		it(`orders the ladder from the title rail down on ${ground.name}`, () => {
			const zones = zonesOf(ground.hex);
			// Distance from the page, in the direction that is visible on it, so one
			// ordering claim covers a dark terminal and a light one.
			const off = (hex: string) => (luminance(hex) - luminance(zones.page)) * (ground.brighter ? 1 : -1);
			// An ORDER is not enough. Two zones a thousandth apart are ordered and read
			// as one wash, which is exactly what shipped: a step between two materials
			// has to be a step, and only the grade down one plate may be gentle.
			expect(
				off(zones.header) - off(zones.bodyTop),
				"the title rail is a tray, not the top of the plate",
			).toBeGreaterThan(MATERIAL_STEP);
			expect(off(zones.bodyTop) - off(zones.bodyBottom), "the plate is lit from above").toBeGreaterThan(PLATE_GRADE);
			expect(off(zones.bodyBottom) - off(zones.tray), "the footer is a tray under the plate").toBeGreaterThan(
				MATERIAL_STEP,
			);
			expect(off(zones.tray), "and the tray still stands off the page").toBeGreaterThan(MATERIAL_STEP);
		});
	}

	it("keeps each material on its own rows", () => {
		const zones = zonesOf("#1e2127");
		const { geometry } = zones;
		// A band that leaks a row either way is a card with a seam in the wrong
		// place, which reads as a rendering fault rather than as a tray.
		for (let row = geometry.bodyRowStart; row < geometry.bodyRowStart + geometry.bodyRowCount; row++) {
			const material = rowMaterial(zones.lines[row] as string, geometry);
			expect(material, `body row ${row} is not the header tray`).not.toBe(zones.header);
			expect(material, `body row ${row} is not the footer tray`).not.toBe(zones.tray);
		}
		for (let row = geometry.cardRowStart; row < geometry.bodyRowStart; row++) {
			expect(rowMaterial(zones.lines[row] as string, geometry), `header row ${row} is the header tray`).toBe(
				zones.header,
			);
		}
		for (let row = geometry.shortcutRowStart; row < geometry.cardRowEnd; row++) {
			expect(rowMaterial(zones.lines[row] as string, geometry), `footer row ${row} is the tray`).toBe(zones.tray);
		}
	});

	it("gives the body a gradient rather than a step", () => {
		const zones = zonesOf("#1e2127");
		const { geometry } = zones;
		const materials: string[] = [];
		for (let row = geometry.bodyRowStart; row < geometry.bodyRowStart + geometry.bodyRowCount; row++) {
			materials.push(rowMaterial(zones.lines[row] as string, geometry));
		}
		// Monotone, and more than two values: a plate that darkens in one jump is a
		// second tray, and one that never darkens is the wash this suite replaced.
		const levels = materials.map(luminance);
		for (let i = 1; i < levels.length; i++) {
			expect(levels[i] as number, `body row ${i} is no lighter than the row above it`).toBeLessThanOrEqual(
				(levels[i - 1] as number) + 1e-9,
			);
		}
		expect(new Set(materials).size, "the plate is graded, not flat").toBeGreaterThan(2);
	});

	it("mixes the material out of the ground the terminal is showing", () => {
		// The 2026-07-22 slab: a card painted out of the theme's DECLARED ground
		// (titanium declares black) while the terminal shows grey. An unknown ground
		// gets no material at all, and a known one gets a material derived from IT.
		const grey = zonesOf("#1e2127");
		resetGroundTintsForTest();
		const black = zonesOf("#000000");
		expect(grey.bodyTop, "the plate follows the ground under it").not.toBe(black.bodyTop);
		expect(luminance(grey.bodyTop)).toBeGreaterThan(luminance(black.bodyTop));
	});

	it("sets the settings sidebar into the card as a second material", () => {
		setDetectedTerminalGround("#1e2127");
		const inset = cardInsetHex();
		expect(inset, "a truecolor terminal with a known ground has an inset material").not.toBeUndefined();
		const card = createSettingsCard();
		const lines = card.render(WIDTH);
		try {
			const rows = lines
				.map((line, row) => ({ row, backgrounds: backgroundsByColumn(line) }))
				.filter(({ backgrounds }) => [...backgrounds.values()].includes(inset as string));
			expect(rows.length, "the sidebar column carries the inset material").toBeGreaterThan(3);
			// Where it stops is the whole claim: an inset that runs past the hairline
			// is one wash with a line drawn on it, which is what it replaced.
			const insetColumns = rows.flatMap(({ backgrounds }) =>
				[...backgrounds.entries()].filter(([, hex]) => hex === inset).map(([col]) => col),
			);
			const first = Math.min(...insetColumns);
			const last = Math.max(...insetColumns);
			const span = last - first + 1;
			expect(span, "the inset is a column band, not the whole row").toBeLessThan(WIDTH / 2);
			// And the pane beside it is a DIFFERENT material, or there is no split.
			const paneRow = backgroundsByColumn(lines[rows[0]?.row as number] as string);
			const paneMaterials = new Set([...paneRow.entries()].filter(([col]) => col > last + 2).map(([, hex]) => hex));
			expect(paneMaterials.has(inset as string), "the pane is not the inset").toBe(false);
			expect(paneMaterials.size, "the pane carries a material of its own").toBeGreaterThan(0);
		} finally {
			card.dispose();
		}
	});

	it("gives a card with no known ground, and a card with no truecolor, exactly the bytes it always had", () => {
		// Both gates, at the product seam. An inset painted out of a guessed ground is
		// the same slab as a plate painted out of one. Each pair varies ONE thing —
		// whether the ground is known — so the comparison cannot be confused by the
		// theme's own colour depth, which the truecolor flag also moves.
		const render = (): string => {
			const card = createSettingsCard();
			const out = card.render(WIDTH).join("\n");
			card.dispose();
			return out;
		};

		resetGroundTintsForTest();
		expect(cardInsetHex(), "no OSC 11 answer, no material").toBeUndefined();
		const truecolorUnknownGround = render();
		setDetectedTerminalGround("#1e2127");
		expect(cardInsetHex(), "a known ground on a truecolor terminal has a material").not.toBeUndefined();
		expect(render(), "learning the ground is what turns the inset on").not.toBe(truecolorUnknownGround);

		terminalCaps.trueColor = false;
		expect(cardInsetHex(), "a 16-colour terminal takes no truecolor material").toBeUndefined();
		const sixteenKnownGround = render();
		resetGroundTintsForTest();
		expect(render(), "a 16-colour terminal renders the same card either way").toBe(sixteenKnownGround);
	});

	it("picks the direction of a lift off the ground's own luminance", () => {
		// The boundary the terminal itself uses (terminal.ts `#handleOsc11Response`),
		// so a card cannot disagree with the theme about which kind of terminal it is
		// on. #767676 sits just under half; #808080 just over.
		expect(luminance(liftHex("#767676", 0.2))).toBeGreaterThan(luminance("#767676"));
		expect(luminance(liftHex("#808080", 0.2))).toBeLessThan(luminance("#808080"));
		// And a lift of nothing moves nothing, at either end.
		expect(liftHex("#1e2127", 0)).toBe("#1e2127");
		expect(liftHex("#f7f7f8", 0)).toBe("#f7f7f8");
	});
});
