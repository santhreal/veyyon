// WHY THIS SUITE EXISTS (AN-ANIMATION-MIXES-OUT-OF-THE-GROUND-THAT-IS-ON-SCREEN).
//
// The defect: every fading pointer band and every unfolding card mixed its color out of the
// theme's DECLARED ground, which on the default setup is not the ground the operator is looking
// at. Titanium declares `#000000`; `tui.paintGround` defaults to `auto`, which refuses to paint a
// ground that far from the terminal's own; so the row sits on the terminal's grey while the mix
// travelled out of black. Recorded off a real xterm at 60fps (`proof/captures/x11/card-bands.mp4`,
// the model picker at 26.5s), the row being left read `#090401` between a `#1c1f26` ground and a
// `#231310` band: every band flashed darker than both of its endpoints on the way in and on the
// way out. Same class as the 2026-07-22 slabs — a color computed against a ground nobody painted.
//
// The class this closes is wider than the band. Anything that resolves a color out of "what is
// behind this row" has to ask ONE owner, and that owner has to answer with the ground on screen:
//
//   1. Precedence. Painted ground first (this process put it there), else the ground the terminal
//      reported over OSC 11, else — and only then — the theme's declared ground, which is the
//      pre-detection rendering and the best guess available.
//   2. Every consumer agrees. The band and the card unfold are asserted against the same owner in
//      every state, so the two cannot drift into two washes on one screen.
//   3. The policy reaches the owner. A paint decision that sets the terminal background without
//      recording it is the exact shape of the original defect, so the seam that does one does both.
//   4. No frame leaves the segment. A mix is bounded by its endpoints; the symptom here was
//      overshoot, a color darker than the ground AND darker than the band.
//
// The suite drives the real theme (titanium, built truecolor on purpose — the mix branch only runs
// in truecolor and a suite that trusts the CI terminal asserts the other branch) and the real
// `applyGroundPaint` seam with a recording terminal double. The terminal is the one boundary faked:
// there is no X server in a test.
//
// WHAT IT DOES NOT CATCH: a NEW animation that reaches past `visibleGroundHex()` for a ground of
// its own. Nothing here can see a caller that never calls the owner; only a reader can. It also
// says nothing about timing (the clock suites own that) or about how a fade looks to an eye — that
// is what the recorded proof is for.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { modalRevealGround } from "@veyyon/coding-agent/modes/components/modal-shell";
import {
	applyGroundPaint,
	getVisibleGround,
	onGroundTintChange,
	resetGroundTintsForTest,
	setDetectedTerminalGround,
} from "@veyyon/coding-agent/modes/theme/ground-tints";
import {
	getThemeByName,
	hoverBand,
	setThemeInstance,
	theme,
	visibleGroundHex,
} from "@veyyon/coding-agent/modes/theme/theme";
import { getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";

const originalColorterm = Bun.env.COLORTERM;
const originalAnsiPolicy = getAnsiPolicy();

/** The grey a real terminal reports; nothing like titanium's declared black. */
const TERMINAL_GREY = "#1e2127";
/** A ground this process painted, distinguishable from both the grey and the theme's black. */
const PAINTED_TEAL = "#0d3b3b";

function rgb(hex: string): [number, number, number] {
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];
}

/** `48;2;r;g;b` from a painted band, or null when it carries no truecolor background. */
function bandRgb(row: string): [number, number, number] {
	const match = /\x1b\[[0-9;]*?48;2;(\d+);(\d+);(\d+)/.exec(row);
	if (match === null) throw new Error(`no truecolor background in ${JSON.stringify(row)}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function distance(a: [number, number, number], b: [number, number, number]): number {
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** A terminal that records the OSC 11 calls a paint decision makes on it. */
function recordingTerminal(): {
	painted: string[];
	resets: number;
	setBackgroundColor(hex: string): void;
	resetBackgroundColor(): void;
} {
	return {
		painted: [],
		resets: 0,
		setBackgroundColor(hex: string): void {
			this.painted.push(hex);
		},
		resetBackgroundColor(): void {
			this.resets += 1;
		},
	};
}

beforeAll(async () => {
	// No TTY means no color at all, and every band would come back as bare text with each
	// assertion comparing nothing to nothing. The bytes are the subject.
	setAnsiPolicy("full");
	Bun.env.COLORTERM = "truecolor";
	const titanium = await getThemeByName("titanium");
	if (!titanium) throw new Error("titanium theme unavailable in test env");
	if (titanium.getColorMode() !== "truecolor") throw new Error(`titanium built as ${titanium.getColorMode()}`);
	setThemeInstance(titanium);
	// The premise of the whole suite: the default theme's declared ground is NOT the terminal's.
	if (titanium.getResolvedGroundHex() !== "#000000") {
		throw new Error(`titanium's declared ground moved to ${titanium.getResolvedGroundHex()}`);
	}
});

afterEach(() => {
	resetGroundTintsForTest();
});

afterAll(() => {
	setAnsiPolicy(originalAnsiPolicy);
	if (originalColorterm === undefined) delete (Bun.env as Record<string, string | undefined>).COLORTERM;
	else Bun.env.COLORTERM = originalColorterm;
});

describe("a band is mixed out of the ground the terminal is showing", () => {
	it("mixes out of the reported terminal ground, not the ground the theme declares", () => {
		setDetectedTerminalGround(TERMINAL_GREY);
		const grey = rgb(TERMINAL_GREY);
		const full = bandRgb(hoverBand("row", 1));

		const faint = bandRgb(hoverBand("row", 0.2));
		// The visible symptom of the defect: at a fifth of the way in, the band was nearer black
		// than the page it was arriving on.
		expect(distance(faint, grey)).toBeLessThan(distance(faint, [0, 0, 0]));
		expect(distance(faint, grey)).toBeLessThan(distance(faint, full));
	});

	it("keeps every frame of the fade inside the segment it is travelling", () => {
		setDetectedTerminalGround(TERMINAL_GREY);
		const grey = rgb(TERMINAL_GREY);
		const full = bandRgb(hoverBand("row", 1));

		// A mix is bounded by its endpoints. The defect overshot BOTH of them downward, which no
		// per-channel bound can express as "closer to one end" — it has to be the interval.
		for (let step = 1; step <= 9; step++) {
			const strength = step / 10;
			const band = bandRgb(hoverBand("row", strength));
			for (let channel = 0; channel < 3; channel++) {
				const low = Math.min(grey[channel], full[channel]);
				const high = Math.max(grey[channel], full[channel]);
				expect(band[channel], `strength ${strength}, channel ${channel}`).toBeGreaterThanOrEqual(low);
				expect(band[channel], `strength ${strength}, channel ${channel}`).toBeLessThanOrEqual(high);
			}
		}
	});

	it("travels monotonically from the page to the band", () => {
		setDetectedTerminalGround(TERMINAL_GREY);
		const grey = rgb(TERMINAL_GREY);
		const full = bandRgb(hoverBand("row", 1));
		let previous = Number.POSITIVE_INFINITY;
		for (let step = 1; step <= 9; step++) {
			const band = bandRgb(hoverBand("row", step / 10));
			const remaining = distance(band, full);
			// Each step is nearer the band than the last and never nearer the page than the last.
			expect(remaining).toBeLessThan(previous);
			previous = remaining;
			expect(distance(band, grey)).toBeGreaterThan(0);
		}
	});

	// The precedence table, enumerated rather than described: every combination of the two things
	// that can be known about the ground, and the one answer each must give. A change to the rule
	// turns a row red instead of quietly re-hueing every animation in the product.
	const GROUNDS: ReadonlyArray<{
		name: string;
		painted: string | null;
		detected: string | undefined;
		expected: () => string;
	}> = [
		{ name: "painted and detected", painted: PAINTED_TEAL, detected: TERMINAL_GREY, expected: () => PAINTED_TEAL },
		{ name: "painted, nothing reported", painted: PAINTED_TEAL, detected: undefined, expected: () => PAINTED_TEAL },
		{ name: "nothing painted, reported", painted: null, detected: TERMINAL_GREY, expected: () => TERMINAL_GREY },
		{
			name: "nothing painted, nothing reported",
			painted: null,
			detected: undefined,
			expected: () => theme.getResolvedGroundHex(),
		},
	];

	for (const state of GROUNDS) {
		it(`resolves the ground from ${state.name}`, () => {
			if (state.detected !== undefined) setDetectedTerminalGround(state.detected);
			applyGroundPaint({ paint: state.painted, unhonoredAlways: false }, recordingTerminal());

			expect(visibleGroundHex()).toBe(state.expected());
			// The card unfold and the pointer band are the two consumers, and they take the same
			// answer: two policies for "what is behind this row" is two washes on one screen.
			expect(modalRevealGround()).toBe(visibleGroundHex());
			const band = bandRgb(hoverBand("row", 0.2));
			expect(distance(band, rgb(state.expected()))).toBeLessThan(distance(band, bandRgb(hoverBand("row", 1))));
		});
	}

	it("records what it painted on the terminal, in the same call that paints it", () => {
		setDetectedTerminalGround(TERMINAL_GREY);
		const terminal = recordingTerminal();

		applyGroundPaint({ paint: PAINTED_TEAL, unhonoredAlways: false }, terminal);
		expect(terminal.painted).toEqual([PAINTED_TEAL]);
		expect(terminal.resets).toBe(0);
		expect(getVisibleGround()).toBe(PAINTED_TEAL);

		// And a decision NOT to paint hands the ground back to the terminal's own, rather than
		// leaving the animations mixing out of a paint that is no longer on screen.
		applyGroundPaint({ paint: null, unhonoredAlways: false }, terminal);
		expect(terminal.resets).toBe(1);
		expect(getVisibleGround()).toBe(TERMINAL_GREY);
	});

	it("notifies the ground listeners when the paint changes, so painted chrome repaints", () => {
		let notifications = 0;
		onGroundTintChange(() => {
			notifications += 1;
		});
		applyGroundPaint({ paint: PAINTED_TEAL, unhonoredAlways: false }, recordingTerminal());
		expect(notifications).toBe(1);
		// Re-applying the same decision is not a change and must not spin the renderer.
		applyGroundPaint({ paint: PAINTED_TEAL, unhonoredAlways: false }, recordingTerminal());
		expect(notifications).toBe(1);
	});
});
