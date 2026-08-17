/**
 * A selected or pointed-at row is a band with a DIRECTION, not a flat rectangle.
 *
 * WHY THIS SUITE EXISTS. `theme.bg("selectedBg", row)` paints one flat slab of one colour across
 * the whole row. Nothing in it says which end the cursor came from, so it reads as a rectangle
 * somebody drew rather than as a surface the cursor is resting on — the operator's verdict on the
 * shipped build was that the selection is "boring", and rendering the real components to PNG
 * confirmed the cause is that every surface is one flat ground. The replacement is a hard accent
 * leading cell plus an eased ramp out of `selectedBg` toward the ground behind the row.
 *
 * Four ways a directional band goes wrong, and this suite pins each:
 *
 *   1. THE WIDTH CHANGES. This is the dangerous one and it is why the width assertions come first.
 *      Hit-testing and layout are computed from column positions elsewhere in the product, so a
 *      treatment that adds or drops a single cell silently breaks mouse routing on every list.
 *      The band may only add zero-width escapes, and the double-width and already-coloured inputs
 *      are the two shapes that break a naive column walk.
 *   2. THE DIRECTION IS LOST. A band whose ramp runs the wrong way, or not at all, is a wash. The
 *      assertion decodes the `48;2;r;g;b` spans out of the returned bytes and requires each one to
 *      be strictly nearer the visible ground than the last, which fails on a reversed ramp, on a
 *      constant fill, and on an unordered splice.
 *   3. THE RAMP IS UNQUANTISED. A per-cell gradient is ~19 bytes of SGR per column on a row that
 *      repaints on every keystroke. The span count is pinned per width, so a change that goes
 *      per-cell (or drops to two blocks) is red rather than merely expensive.
 *   4. A TERMINAL THAT CANNOT SHOW IT GETS IT ANYWAY. In 256-colour mode every intermediate
 *      quantises onto the nearest palette entry and the ramp reads as the band changing hue. That
 *      mode must return the exact bytes it returned before there was a ramp, so the expectation is
 *      a captured literal rather than a re-derivation that would drift with the implementation.
 *
 * Hover is the same treatment at a strength, so the two are asserted to be one thing: full strength
 * is byte-identical to a selection, and strength 0 is the untouched line rather than a band mixed
 * all the way out.
 *
 * WHAT IT DOES NOT CATCH: whether the band LOOKS like a surface to an eye — a render proof answers
 * that, an assertion cannot; and the timing of the hover fade, which is the motion clock's suite.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { hoverBandAt, selectionBand } from "@veyyon/coding-agent/modes/components/selector-helpers";
import { resetGroundTintsForTest, setDetectedTerminalGround } from "@veyyon/coding-agent/modes/theme/ground-tints";
import {
	getThemeByName,
	hoverBand,
	initTheme,
	setThemeInstance,
	theme,
	visibleGroundHex,
} from "@veyyon/coding-agent/modes/theme/theme";
import { type AnsiPolicy, Ellipsis, getAnsiPolicy, setAnsiPolicy, truncateToWidth, visibleWidth } from "@veyyon/tui";

/** The grey a real terminal reports, so the ramp resolves out of something that is not black. */
const TERMINAL_GREY = "#1e2127";
const ROW = "  Select a model";
const WIDTH = 40;

const ANSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
const BG_TRUECOLOR = /\x1b\[48;2;(\d+);(\d+);(\d+)m/g;

let policy: AnsiPolicy;
let originalColorterm: string | undefined;
let originalTerm: string | undefined;

/** The row with every escape removed, which is what the eye sees as cells. */
function cells(line: string): string {
	return line.replace(ANSI, "");
}

/** Every truecolor background the row opens, in the order it opens them. */
function backgrounds(line: string): Array<[number, number, number]> {
	return [...line.matchAll(BG_TRUECOLOR)].map(match => [Number(match[1]), Number(match[2]), Number(match[3])]);
}

function hexRgb(hex: string): [number, number, number] {
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];
}

/** How far one colour is from another, summed over the channels. */
function distance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** The flat band the helper painted before there was a ramp, at the same width. */
function flatBand(line: string, rowWidth: number): string {
	return theme.bg("selectedBg", truncateToWidth(line, rowWidth, Ellipsis.Omit, true));
}

/**
 * Build titanium in a chosen colour mode. The mode is read once, at construction, so a suite that
 * trusts the runner's own terminal silently asserts the other branch — which is how a band test
 * stays green while the band is broken.
 */
async function useMode(mode: "truecolor" | "256color"): Promise<void> {
	if (mode === "truecolor") {
		Bun.env.COLORTERM = "truecolor";
		Bun.env.TERM = "xterm-256color";
	} else {
		delete (Bun.env as Record<string, string | undefined>).COLORTERM;
		Bun.env.TERM = "linux";
	}
	const loaded = await getThemeByName("titanium");
	if (!loaded) throw new Error("titanium theme unavailable in test env");
	if (loaded.getColorMode() !== mode) throw new Error(`titanium built as ${loaded.getColorMode()}, wanted ${mode}`);
	setThemeInstance(loaded);
}

beforeAll(async () => {
	await initTheme(false);
	originalColorterm = Bun.env.COLORTERM;
	originalTerm = Bun.env.TERM;
});

beforeEach(async () => {
	policy = getAnsiPolicy();
	// A runtime with no TTY emits no colour at all, so every band would come back as bare text and
	// each assertion would pass by comparing nothing to nothing. The bytes are the subject.
	setAnsiPolicy("full");
	await useMode("truecolor");
	setDetectedTerminalGround(TERMINAL_GREY);
});

afterEach(() => {
	setAnsiPolicy(policy);
	resetGroundTintsForTest();
	if (originalColorterm === undefined) delete (Bun.env as Record<string, string | undefined>).COLORTERM;
	else Bun.env.COLORTERM = originalColorterm;
	if (originalTerm === undefined) delete (Bun.env as Record<string, string | undefined>).TERM;
	else Bun.env.TERM = originalTerm;
});

describe("a selected row keeps the width the flat band had", () => {
	/**
	 * The invariant the mouse routing is computed from, over the shapes that break a column walk:
	 * a plain row, a row already carrying its own truecolor foreground, a row with a double-width
	 * CJK grapheme (which a span boundary can land inside), a row that overflows the width, a row
	 * that exactly fills it, and the empty row.
	 */
	const INPUTS: readonly string[] = [
		ROW,
		"  short",
		`\x1b[38;2;1;2;3mcoloured\x1b[39m`,
		"  \u4f60\u597d world",
		// A CJK pair straddling the first span boundary at column 5, which is the case a naive
		// slice emits half a grapheme for.
		"ab\u4f60\u597dcd efgh",
		`  ${"x".repeat(80)}`,
		"x".repeat(WIDTH),
		"",
	];

	for (const input of INPUTS) {
		it(`is exactly ${WIDTH} cells wide for ${JSON.stringify(input.slice(0, 24))}`, () => {
			const band = selectionBand(input, WIDTH);
			const flat = flatBand(input, WIDTH);

			expect(visibleWidth(band)).toBe(visibleWidth(flat));
			expect(visibleWidth(band)).toBe(WIDTH);
			// Same cells, in the same order: the treatment adds zero-width escapes and nothing else.
			expect(cells(band)).toBe(cells(flat));
		});
	}

	/** A row that carries its own colours keeps every byte of them. */
	it("leaves a caller's own foreground bytes untouched", () => {
		const band = selectionBand(`\x1b[38;2;1;2;3mcoloured\x1b[39m`, WIDTH);

		expect(band).toContain("\x1b[38;2;1;2;3m");
		expect(band).toContain("\x1b[39m");
		// And the lift is NOT applied over them: the only `38;2` in the row is the caller's.
		expect([...band.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)]).toHaveLength(1);
	});

	/** Zero columns is the flat band's empty escape pair, with no ramp spliced into it. */
	it("paints no cells at a width of zero", () => {
		expect(selectionBand(ROW, 0)).toBe(flatBand(ROW, 0));
		expect(cells(selectionBand(ROW, 0))).toBe("");
	});
});

describe("a selected row is a band with a direction", () => {
	/**
	 * The leading edge, byte for byte: the row opens on the accent as a BACKGROUND, before any cell
	 * of the row is emitted, and the cell's own character survives.
	 */
	it("opens on one cell of accent at full strength", () => {
		const band = selectionBand(ROW, WIDTH);
		const accent = hexRgb(theme.getAccentColorHex());

		expect(band.startsWith(`\x1b[48;2;${accent[0]};${accent[1]};${accent[2]}m`)).toBeTrue();
		expect(backgrounds(band)[0]).toEqual(accent);
		// One cell only. The second background opens after exactly one column of cells.
		const upToSecond = band.slice(0, band.indexOf("m", band.indexOf("\x1b[48;2;", 1)) + 1);
		expect(visibleWidth(cells(upToSecond))).toBe(1);
		expect(cells(band)[0]).toBe(" ");
	});

	/** The body starts on the theme's own switched band, so the band is still the theme's. */
	it("opens the body on the switched background's own escape", () => {
		const band = selectionBand(ROW, WIDTH);

		expect(band).toContain(theme.getBgAnsi("selectedBg"));
		expect(backgrounds(band)[1]).toEqual(hexRgb(theme.getBgColorHex("selectedBg")));
	});

	/**
	 * The direction itself. Every span after the leading edge is strictly nearer the ground the row
	 * sits on than the one before it, which is what makes the band point at an end. A reversed
	 * ramp, a constant fill, and a splice that emits its spans out of order all fail here.
	 */
	it("ramps monotonically toward the visible ground", () => {
		const spans = backgrounds(selectionBand(ROW, WIDTH)).slice(1);
		const ground = hexRgb(visibleGroundHex());

		expect(spans.length).toBeGreaterThan(2);
		let previous = Number.POSITIVE_INFINITY;
		for (const [index, span] of spans.entries()) {
			const remaining = distance(span, ground);
			expect(remaining, `span ${index} is nearer the ground than span ${index - 1}`).toBeLessThan(previous);
			previous = remaining;
		}
		// The trailing end is a 75% mix into the ground, so it is much nearer the page than the head.
		expect(distance(spans[spans.length - 1] as [number, number, number], ground)).toBeLessThan(
			distance(spans[0] as [number, number, number], ground) / 2,
		);
	});

	/**
	 * The easing, stated as the property a linear ramp does not have: most of the travel is spent
	 * in the first third of the row. A 24-column row gets exactly three spans, so the middle one
	 * sits at `t = 0.5`, where `t ** 0.55` has already covered ~68% of the head-to-tail distance.
	 * A linear ramp covers 50% there and fails, which is the whole point of naming the number.
	 */
	it("front-loads the ramp instead of spreading it evenly", () => {
		const spans = backgrounds(selectionBand("x".repeat(80), 24)).slice(1);
		const ground = hexRgb(visibleGroundHex());
		expect(spans).toHaveLength(3);
		const head = distance(spans[0] as [number, number, number], ground);
		const middle = distance(spans[1] as [number, number, number], ground);
		const tail = distance(spans[2] as [number, number, number], ground);

		// `travelled` is the fraction of the head-to-tail distance the middle span has covered.
		const travelled = (head - middle) / (head - tail);
		expect(travelled).toBeGreaterThan(0.6);
		expect(travelled).toBeLessThan(0.85);
	});

	/**
	 * The quantisation, pinned per width. One span per ~8 columns clamped to 3..10, plus the one
	 * accent cell, so the count is bounded no matter how wide the row is — a per-cell ramp would
	 * put 80 escapes on an 80-column row and 120 on a 120-column one.
	 */
	const SPAN_COUNTS: ReadonlyArray<{ width: number; backgrounds: number }> = [
		{ width: 1, backgrounds: 1 },
		{ width: 2, backgrounds: 2 },
		{ width: 4, backgrounds: 4 },
		{ width: 8, backgrounds: 4 },
		{ width: 24, backgrounds: 4 },
		{ width: 40, backgrounds: 6 },
		{ width: 80, backgrounds: 11 },
		{ width: 120, backgrounds: 11 },
		{ width: 400, backgrounds: 11 },
	];

	for (const spanCase of SPAN_COUNTS) {
		it(`quantises a ${spanCase.width}-column row to ${spanCase.backgrounds} backgrounds`, () => {
			const band = selectionBand("x".repeat(500), spanCase.width);

			expect(backgrounds(band)).toHaveLength(spanCase.backgrounds);
			expect(visibleWidth(band)).toBe(spanCase.width);
		});
	}

	/** The label lift: an escape-free row gets a brighter foreground over the strongest third. */
	it("lifts the label over the leading third of a row that carries no styling of its own", () => {
		const band = selectionBand(ROW, WIDTH);
		const lifts = [...band.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];
		const text = hexRgb(theme.getColorHex("text"));

		expect(lifts).toHaveLength(1);
		const lifted: [number, number, number] = [Number(lifts[0]?.[1]), Number(lifts[0]?.[2]), Number(lifts[0]?.[3])];
		// Titanium is dark, so a lift is brighter than the theme's own text colour on every channel.
		expect(theme.isLight).toBeFalse();
		for (let channel = 0; channel < 3; channel++) {
			expect(lifted[channel]).toBeGreaterThan(text[channel] as number);
		}
		// It closes inside the row, not at the end of it: the label is brighter where the band is.
		const closeAt = band.indexOf("\x1b[39m");
		expect(closeAt).toBeGreaterThan(-1);
		expect(visibleWidth(cells(band.slice(0, closeAt)))).toBe(Math.round(WIDTH / 3));
	});

	/** The fill still closes exactly once, at the end, so a truncating view cuts it the same way. */
	it("closes the background once, after the last cell", () => {
		const band = selectionBand(ROW, WIDTH);

		expect(band.endsWith("\x1b[49m")).toBeTrue();
		expect([...band.matchAll(/\x1b\[49m/g)]).toHaveLength(1);
	});
});

describe("a hover is the same band at a strength", () => {
	/** Full strength IS the selection, byte for byte: adopting a fade cannot restyle a settled row. */
	it("is byte-identical to the selection band at strength 1", () => {
		expect(hoverBandAt(ROW, WIDTH, 1)).toBe(selectionBand(ROW, WIDTH));
		expect(hoverBand(ROW, 1)).toBe(selectionBand(ROW, visibleWidth(ROW)));
	});

	/** Strength 0 is the ABSENCE of a band, not a band mixed all the way out. */
	it("returns the line untouched at strength 0", () => {
		expect(hoverBand(ROW, 0)).toBe(ROW);
		expect(hoverBandAt(ROW, WIDTH, 0)).toBe(truncateToWidth(ROW, WIDTH, Ellipsis.Omit, true));
	});

	/**
	 * In between, EVERY colour in the gradient is mixed out of the ground — the leading accent and
	 * every ramp span alike — so the whole band arrives from the page together instead of the
	 * gradient appearing on top of a fading fill.
	 */
	it("mixes every span of the gradient out of the ground", () => {
		const ground = hexRgb(visibleGroundHex());
		const full = backgrounds(hoverBandAt(ROW, WIDTH, 1));
		const faint = backgrounds(hoverBandAt(ROW, WIDTH, 0.25));

		expect(faint).toHaveLength(full.length);
		for (const [index, span] of faint.entries()) {
			const settled = full[index] as [number, number, number];
			// Nearer the page than the band it is arriving as, and never past either endpoint.
			expect(distance(span, ground), `span ${index}`).toBeLessThan(distance(span, settled));
			for (let channel = 0; channel < 3; channel++) {
				const low = Math.min(ground[channel] as number, settled[channel] as number);
				const high = Math.max(ground[channel] as number, settled[channel] as number);
				expect(span[channel], `span ${index}, channel ${channel}`).toBeGreaterThanOrEqual(low);
				expect(span[channel], `span ${index}, channel ${channel}`).toBeLessThanOrEqual(high);
			}
		}
	});

	/** And the direction survives the mix: a faint band still points the same way. */
	it("keeps the ramp monotone at a partial strength", () => {
		const spans = backgrounds(hoverBandAt(ROW, WIDTH, 0.4)).slice(1);
		const ground = hexRgb(visibleGroundHex());

		let previous = Number.POSITIVE_INFINITY;
		for (const span of spans) {
			const remaining = distance(span, ground);
			expect(remaining).toBeLessThan(previous);
			previous = remaining;
		}
	});
});

describe("a terminal that cannot show a ramp gets the bytes it always got", () => {
	/**
	 * The captured literal, taken from the implementation BEFORE the ramp existed: one
	 * `48;5;<index>` fill across the padded row and one close. Re-deriving it from `theme.bg` here
	 * would let both sides move together, which is exactly the drift this pins.
	 */
	it("paints the flat 256-colour band, byte for byte", async () => {
		await useMode("256color");

		expect(selectionBand(ROW, WIDTH)).toBe("\x1b[48;5;234m  Select a model                        \x1b[49m");
		expect(selectionBand(ROW, WIDTH)).toBe(flatBand(ROW, WIDTH));
		// Nothing it paints is a truecolor sequence, at any strength.
		expect(backgrounds(selectionBand(ROW, WIDTH))).toHaveLength(0);
		expect(backgrounds(hoverBandAt(ROW, WIDTH, 0.6))).toHaveLength(0);
	});

	/** The pointer still tracks: over half the switched band, under half nothing at all. */
	it("switches rather than ramps as the pointer arrives", async () => {
		await useMode("256color");

		expect(hoverBand("row", 0.4)).toBe("row");
		expect(hoverBand("row", 0.6)).toBe(theme.bg("selectedBg", "row"));
		expect(hoverBand("row", 1)).toBe(theme.bg("selectedBg", "row"));
	});
});
