/**
 * A ground-relative tint is mixed out of the ground that is ON SCREEN.
 *
 * THE DEFECT. `tintFromGround` read the module's `detectedGround` — the OSC 11
 * reply — while `getVisibleGround()` already existed to answer "what is behind
 * this row": the ground this process painted, else the reported one. Two states
 * came out wrong from that one read. With `tui.paintGround: always` on a
 * reporting terminal the process paints the theme ground and every tint was
 * still mixed 12% off the report, so a card's hairline was calibrated against a
 * colour that had been painted over. On a terminal that answers nothing the
 * paint left a ground that was known and every getter returned undefined, so
 * the chrome degraded to its static token for no reason.
 *
 * THE CLASS. Any tint getter in `ground-tints.ts` that reads a ground other
 * than `getVisibleGround()`, and any card frame mixed out of the reported
 * ground. The sweep enumerates the getters off the module at run time and the
 * paint policies off the settings declaration, so adding either one turns this
 * suite red until its behaviour is recorded here.
 *
 * WHAT THIS DOES NOT CATCH. Whether the OSC 11 write reached a real terminal
 * (`applyGroundPaint` is driven against a recording double, and the sequence
 * bytes are `packages/tui`'s own contract), nor the accuracy of detection
 * itself — a terminal that reports a ground it does not have is
 * indistinguishable from one that does. It also says nothing about
 * non-truecolor terminals beyond asserting that they degrade:
 * `groundTintFgAnsi` refuses to quantize a derived hex into 256 colours, and
 * that refusal is the pre-detection rendering.
 */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { APPEARANCE_SETTINGS } from "@veyyon/coding-agent/config/settings-domains/appearance";
import { cardOutlineColor } from "@veyyon/coding-agent/modes/theme/card-outline";
import * as groundTints from "@veyyon/coding-agent/modes/theme/ground-tints";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, planPaintGround, setAnsiPolicy, TERMINAL } from "@veyyon/tui";

const { applyGroundPaint, getVisibleGround, groundTintFgAnsi, resetGroundTintsForTest, setDetectedTerminalGround } =
	groundTints;

/** A ground a terminal actually reports, deliberately NOT titanium's declared black. */
const REPORTED_GROUND = "#1e2127";

/** How far the hairline sits from its ground, so the expected mix is computed here too. */
const HAIRLINE_AMOUNT = 0.12;

/** A tint getter: no arguments, a hex or undefined. Every `ground*Hex` export is one. */
type TintGetter = () => string | undefined;

/** The paint policies the setting declares, not a second copy of the union. */
type PaintPolicy = (typeof APPEARANCE_SETTINGS)["tui.paintGround"]["values"][number];

/**
 * The tint getters, read off the module namespace at run time.
 *
 * A hardcoded pair goes stale the moment someone adds `groundSunkenHex`, and
 * the new getter inherits the exact defect this suite closes while the suite
 * stays green. The array is mutable because `it.each` rejects a readonly tuple.
 */
const TINT_GETTERS: Array<[string, TintGetter]> = Object.entries(groundTints)
	.filter((entry): entry is [string, TintGetter] => /^ground[A-Za-z]*Hex$/.test(entry[0]) && entry[1].length === 0)
	.sort((a, b) => a[0].localeCompare(b[0]));

const PAINT_POLICIES: PaintPolicy[] = [...APPEARANCE_SETTINGS["tui.paintGround"].values];

/** The two terminal calls `applyGroundPaint` makes, recorded rather than written. */
interface PaintRecorder {
	setBackgroundColor(hex: string): void;
	resetBackgroundColor(): void;
	painted: string[];
	reset: number;
}

function paintRecorder(): PaintRecorder {
	const record: PaintRecorder = {
		painted: [],
		reset: 0,
		setBackgroundColor(hex: string) {
			record.painted.push(hex);
		},
		resetBackgroundColor() {
			record.reset += 1;
		},
	};
	return record;
}

function channels(hex: string): [number, number, number] {
	return [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** The pole a ground tints toward: white on a dark ground, black on a light one. */
function poleOf(ground: string): "#ffffff" | "#000000" {
	return channels(ground).reduce((sum, channel) => sum + channel, 0) < 383 ? "#ffffff" : "#000000";
}

/** The mix the module should produce, computed here so the assertion is independent of it. */
function tintOf(ground: string, amount: number): string {
	const rgb = channels(ground);
	const pole = poleOf(ground) === "#ffffff" ? 255 : 0;
	return `#${rgb
		.map(channel => Math.round(channel + (pole - channel) * amount))
		.map(channel => channel.toString(16).padStart(2, "0"))
		.join("")}`;
}

/**
 * How far a tint sits from a ground toward that ground's pole, or undefined
 * when the tint is not a mix of that ground at all.
 *
 * "Closer to one ground than the other" is the wrong question and gives the
 * wrong answer here: black's 12% mix is `#1f1f1f`, which is 11 away from the
 * `#1e2127` a terminal reported and 93 away from the black that replaced it.
 * Whether a colour is an interpolation of a ground is exact — solve the amount
 * off one channel and the other two have to agree.
 */
function mixAmount(ground: string, tint: string): number | undefined {
	const rgb = channels(ground);
	const target = channels(tint);
	const pole = poleOf(ground) === "#ffffff" ? 255 : 0;
	const solvable = [0, 1, 2].find(index => Math.abs(pole - rgb[index]) >= 16);
	if (solvable === undefined) return undefined;
	const amount = (target[solvable] - rgb[solvable]) / (pole - rgb[solvable]);
	if (amount <= 0 || amount >= 1) return undefined;
	const remixed = channels(tintOf(ground, amount));
	return remixed.every((channel, index) => Math.abs(channel - target[index]) <= 1) ? amount : undefined;
}

/**
 * The product's startup order for one state: the terminal's reply lands, then
 * the paint decision is taken and carried out.
 *
 * Driving this rather than calling `setPaintedGround` by hand is what makes the
 * sweep evidence — the policy, the auto tolerance and the recording all run.
 */
function bringUpGround(policy: PaintPolicy, reported: string | undefined): PaintRecorder {
	const terminal = paintRecorder();
	setDetectedTerminalGround(reported);
	applyGroundPaint(planPaintGround(policy, theme.getResolvedGroundHex(), reported), terminal);
	return terminal;
}

const terminalCaps: { trueColor: boolean } = TERMINAL;
const TRUE_COLOR_WAS = terminalCaps.trueColor;
const ANSI_POLICY_WAS: AnsiPolicy = getAnsiPolicy();

describe("a tint is mixed out of the ground on screen", () => {
	beforeAll(async () => {
		await initTheme(false, "unicode", false, "titanium", "dark");
	});

	afterEach(() => {
		resetGroundTintsForTest();
		terminalCaps.trueColor = TRUE_COLOR_WAS;
		setAnsiPolicy(ANSI_POLICY_WAS);
	});

	/** Fail-by-default roll call. A new getter or a new policy lands here first. */
	it("sweeps every tint getter and every paint policy the product declares", () => {
		expect(TINT_GETTERS.map(([name]) => name)).toEqual(["groundHairlineHex", "groundRaisedHex"]);
		expect(PAINT_POLICIES).toEqual(["auto", "always", "never"]);
	});

	/**
	 * The state the defect lived in: the process painted its own ground over a
	 * reported one, so the report is history and every tint follows the paint.
	 */
	it.each(TINT_GETTERS)("mixes %s out of the painted ground, not the report it replaced", (_name, getter) => {
		const terminal = bringUpGround("always", REPORTED_GROUND);
		const painted = theme.getResolvedGroundHex();
		expect(terminal.painted).toEqual([painted]);
		expect(getVisibleGround()).toBe(painted);

		const tint = getter() as string;
		expect(tint).toBeDefined();
		expect(mixAmount(painted, tint)).toBeDefined();
		expect(mixAmount(REPORTED_GROUND, tint)).toBeUndefined();
	});

	/**
	 * The coverage the defect cost: a terminal that answers no OSC 11 still has
	 * a known ground once `always` has painted one, and the derived chrome is
	 * available there.
	 */
	it.each(TINT_GETTERS)("derives %s from a paint alone, with nothing reported", (_name, getter) => {
		bringUpGround("always", undefined);
		expect(groundTints.getDetectedTerminalGround()).toBeUndefined();
		expect(getVisibleGround()).toBe(theme.getResolvedGroundHex());
		expect(getter()).toBeDefined();
	});

	/**
	 * `never` inherits the terminal's ground, so there the report IS what is on
	 * screen — the fix must not stop reading it.
	 */
	it.each(TINT_GETTERS)("keeps %s on the reported ground when nothing paints over it", (_name, getter) => {
		const terminal = bringUpGround("never", REPORTED_GROUND);
		expect(terminal.painted).toEqual([]);
		expect(terminal.reset).toBe(1);
		expect(getVisibleGround()).toBe(REPORTED_GROUND);

		const tint = getter() as string;
		expect(mixAmount(REPORTED_GROUND, tint)).toBeDefined();
		expect(mixAmount(theme.getResolvedGroundHex(), tint)).toBeUndefined();
	});

	/**
	 * No ground from either source → no derivation. The undefined return is what
	 * the static-token fallback hangs on, and a guessed ground would be a lie
	 * about a colour nobody has measured.
	 */
	it.each(TINT_GETTERS)("leaves %s undefined while no ground is known", (_name, getter) => {
		for (const policy of PAINT_POLICIES) {
			if (policy === "always") continue; // `always` makes a ground known by painting one.
			bringUpGround(policy, undefined);
			expect(getVisibleGround()).toBeUndefined();
			expect(getter()).toBeUndefined();
			resetGroundTintsForTest();
		}
	});

	/**
	 * Bounds, for every getter over a dark, a black and a light ground: a tint is
	 * a mix of that ground strictly between it and the contrast pole, and the
	 * hairline sits farther out than the raised surface so an outline reads above
	 * the card it encloses. A getter returning the ground unchanged, the pole, or
	 * a fixed colour satisfies every "is it defined" assertion above.
	 */
	it("keeps every tint strictly between its ground and the contrast pole", () => {
		for (const ground of [REPORTED_GROUND, "#000000", "#fafafa"]) {
			bringUpGround("never", ground);
			for (const [, getter] of TINT_GETTERS) {
				const amount = mixAmount(ground, getter() as string);
				expect(amount).toBeDefined();
				expect(amount as number).toBeGreaterThan(0);
				expect(amount as number).toBeLessThan(0.5);
			}
			const hairline = mixAmount(ground, groundTints.groundHairlineHex() as string) as number;
			const raised = mixAmount(ground, groundTints.groundRaisedHex() as string) as number;
			expect(hairline).toBeGreaterThan(raised);
			resetGroundTintsForTest();
		}
	});

	/**
	 * The consumer, not the getter: a card's frame paint follows the ground on
	 * screen. `cardOutlineColor()` is the single owner of that paint, so it is
	 * the choke point every card's joinery passes through.
	 */
	it("paints a card's frame out of the painted ground", () => {
		setAnsiPolicy("full");
		terminalCaps.trueColor = true;
		bringUpGround("always", REPORTED_GROUND);

		const painted = theme.getResolvedGroundHex();
		expect(groundTints.groundHairlineHex()).toBe(tintOf(painted, HAIRLINE_AMOUNT));

		const frame = cardOutlineColor()("─");
		expect(frame).toContain(groundTintFgAnsi(tintOf(painted, HAIRLINE_AMOUNT), true) as string);
		expect(frame).not.toContain(groundTintFgAnsi(tintOf(REPORTED_GROUND, HAIRLINE_AMOUNT), true) as string);
	});

	/**
	 * A terminal without 24-bit colour degrades to the static token even with a
	 * ground in hand: quantizing a 12% mix into the 256-colour cube lands on a
	 * neighbour that is not 12% away from anything.
	 */
	it("degrades a card's frame to the static token without truecolor", () => {
		setAnsiPolicy("full");
		terminalCaps.trueColor = false;
		bringUpGround("always", REPORTED_GROUND);

		expect(groundTints.groundHairlineHex()).toBeDefined();
		expect(groundTintFgAnsi(groundTints.groundHairlineHex(), false)).toBeUndefined();
		expect(cardOutlineColor()("─")).toBe(theme.fg("borderMuted", "─"));
	});
});
