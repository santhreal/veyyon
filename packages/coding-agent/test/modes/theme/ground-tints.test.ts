/**
 * Terminal-ground-relative tints — the OSC 11-derived chrome colors.
 *
 * Why this suite exists: titanium's structural hexes were calibrated for a
 * pure-black terminal. Absolute dark fills rendered as black slabs on a grey
 * terminal (2026-07-22 regression), and the near-black borderMuted hairline
 * vanished into a grey ground (invisible card outlines in the same day's
 * proof renders). ground-tints.ts derives hairline/raised tints from the
 * DETECTED ground so the chrome keeps a fixed contrast distance on every
 * terminal; with no detection every getter returns undefined and callers keep
 * their static-token fallback (the exact pre-detection rendering, never a
 * guess).
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CardPadRow, ComposerHairline } from "@veyyon/coding-agent/modes/components/composer-chrome";
import type { ThemeJson } from "@veyyon/coding-agent/modes/theme/color";
import { defaultThemes } from "@veyyon/coding-agent/modes/theme/defaults";
import {
	getDetectedTerminalGround,
	groundHairlineHex,
	groundRaisedHex,
	groundTintFgAnsi,
	onGroundTintChange,
	resetGroundTintsForTest,
	setDetectedTerminalGround,
} from "@veyyon/coding-agent/modes/theme/ground-tints";
import { createTheme, initTheme, setThemeInstance, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { TERMINAL } from "@veyyon/tui";

function channelSum(hex: string): number {
	return [1, 3, 5].reduce((a, i) => a + Number.parseInt(hex.slice(i, i + 2), 16), 0);
}

describe("ground tints", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		resetGroundTintsForTest();
	});

	/** No detection → no derivation. The undefined return is the contract the
	 * static-token fallback hangs on; a guessed ground would be a silent lie. */
	it("returns undefined for every tint without a detected ground", () => {
		expect(getDetectedTerminalGround()).toBeUndefined();
		expect(groundHairlineHex()).toBeUndefined();
		expect(groundRaisedHex()).toBeUndefined();
		expect(groundTintFgAnsi(undefined, true)).toBeUndefined();
	});

	/** A dark ground tints toward white — and by MORE for the hairline (12%)
	 * than the raised surface (5%), so the outline reads above the card. */
	it("lightens dark grounds, hairline stronger than raised", () => {
		setDetectedTerminalGround("#1e2127");
		const ground = channelSum("#1e2127");
		const hairline = groundHairlineHex();
		const raised = groundRaisedHex();
		expect(hairline).toBe("#393c41");
		expect(raised).toBe("#292c32");
		expect(channelSum(hairline as string)).toBeGreaterThan(channelSum(raised as string));
		expect(channelSum(raised as string)).toBeGreaterThan(ground);
	});

	/** A light ground tints toward black — the same fixed contrast delta,
	 * mirrored. Light terminals were previously served pure-dark chrome. */
	it("darkens light grounds by the same deltas", () => {
		setDetectedTerminalGround("#fafafa");
		const hairline = groundHairlineHex();
		expect(hairline).toBe("#dcdcdc");
		expect(channelSum(hairline as string)).toBeLessThan(channelSum("#fafafa"));
	});

	/** Malformed reports (truncated OSC payloads, rgb: forms that leaked
	 * through) must clear, not poison, the derivation. */
	it("rejects malformed hexes and treats them as no detection", () => {
		setDetectedTerminalGround("#1e2127");
		setDetectedTerminalGround("rgb:1e/21/27");
		expect(getDetectedTerminalGround()).toBeUndefined();
		expect(groundHairlineHex()).toBeUndefined();
	});

	it("notifies listeners only on real changes", () => {
		let fired = 0;
		onGroundTintChange(() => fired++);
		setDetectedTerminalGround("#1e2127");
		setDetectedTerminalGround("#1E2127"); // case-normalized duplicate
		setDetectedTerminalGround("#000000");
		expect(fired).toBe(2);
	});

	/** groundTintFgAnsi degrades loudly on non-truecolor: undefined, so the
	 * caller's token path runs — never a 256-color approximation. */
	it("emits a 24-bit open only with truecolor", () => {
		expect(groundTintFgAnsi("#393c41", true)).toBe("\x1b[38;2;57;60;65m");
		expect(groundTintFgAnsi("#393c41", false)).toBeUndefined();
	});
});

describe("composer hairline ground derivation", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		resetGroundTintsForTest();
	});

	/** The hairline keeps its exact static-token bytes without detection —
	 * the tint work must not change rendering on terminals that never answer
	 * OSC 11. */
	it("falls back to the borderMuted token without a detected ground", () => {
		const [row] = new ComposerHairline().render(8);
		expect(row).toBe(theme.fg("borderMuted", theme.boxSharp.horizontal.repeat(8)));
	});
});

describe("composer card ground derivation", () => {
	// The card contract is titanium's (transparent composerBg): install it
	// explicitly — the test-env global init resolves a non-truecolor mode
	// whose empty bg maps to black, which is itself a declared card.
	beforeAll(async () => {
		await initTheme(false);
		setThemeInstance(createTheme(defaultThemes.titanium as ThemeJson, { mode: "truecolor" }));
	});

	afterEach(() => {
		resetGroundTintsForTest();
	});

	/** The composer card is DEAD (user order 2026-07-22: every painted
	 * composer box — absolute hex and derived tint alike — read as a gray
	 * slab on the real terminal). CardPadRow must render a bare blank row
	 * with NO escape bytes even when a ground IS detected: this is the
	 * regression lock that keeps any future "quiet card" from resurrecting
	 * the box behind the prompt. */
	it("CardPadRow paints nothing even with a detected ground", () => {
		setDetectedTerminalGround("#1e2127");
		expect(new CardPadRow().render()).toEqual([""]);
	});

	/** Source lock, same order: no background paint may exist anywhere in the
	 * composer chrome — no bg escape, no composerBg read, no card owner. */
	it("composer-chrome contains no background paint at all", () => {
		const chrome = readFileSync(
			join(import.meta.dir, "../../../src/modes/components/composer-chrome.ts"),
			"utf8",
		);
		expect(chrome).not.toContain("composerCardGround");
		expect(chrome).not.toContain("[48;2;");
		expect(chrome).not.toContain('getBgAnsi("composerBg")');
	});
});
