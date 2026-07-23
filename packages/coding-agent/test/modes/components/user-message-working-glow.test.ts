/**
 * The working glow on the newest user prompt.
 *
 * Why this suite exists: prompts rendered gray-on-gray (titanium's
 * `userMessageText` was the dim tone) and nothing indicated WHICH message the
 * agent was working on (user report, 2026-07-22). Two contracts are pinned
 * here so neither regresses silently:
 *
 * 1. Prompt text renders in the theme's bright `userMessageText` color, not
 *    the dim history tone.
 * 2. `setWorking(true)` paints the follow's sheen over the LAST content row
 *    (visible characters, never the ANSI-wrapped right padding — the glow
 *    once landed entirely on invisible trailing cells), keeps the block
 *    unfinalized so the transcript live region repaints it every frame, and
 *    `setWorking(false)` restores the exact memoized idle bytes.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils";

// The glow is truecolor-only (a loud, documented degrade elsewhere), and
// TERMINAL.trueColor is detected from COLORTERM at tui import time — so the
// env must be set BEFORE the module graph loads. Everything below therefore
// imports dynamically inside beforeAll.
process.env.COLORTERM = "truecolor";

const OSC_ZONE = /\x1b\]133;[AB]\x07/g;

// biome-ignore lint/suspicious/noExplicitAny: resolved in beforeAll after COLORTERM is pinned
let UserMessageComponent: any;

describe("UserMessageComponent working glow", () => {
	beforeAll(async () => {
		const { Settings } = await import("@veyyon/coding-agent/config/settings");
		const themeMod = await import("@veyyon/coding-agent/modes/theme/theme");
		await Settings.init({ inMemory: true });
		themeMod.setThemeInstance((await themeMod.getThemeByName("titanium"))!);
		({ UserMessageComponent } = await import("@veyyon/coding-agent/modes/components/user-message"));
	});

	/** Locks the visibility fix: prompt text carries titanium's bright silver
	 * (#C6CBD4 → 38;2;198;203;212), not the dim gray (#565F77) that made
	 * prompts unreadable against the gray ground. */
	it("renders prompt text in bright silver, not the dim history tone", () => {
		const rows = new UserMessageComponent("fix the flaky auth test").render(60);
		const content = rows.find(row => stripAnsi(row).includes("fix the flaky auth test"))!;
		expect(content).toContain("\x1b[38;2;198;203;212m");
		expect(content).not.toContain("\x1b[38;2;86;95;119mfix");
	});

	/** The moving sheen is wall-clock driven, so a working prompt must return a
	 * FRESH array every render — reference-stable rows would let the
	 * transcript's identity reuse freeze the first frame of the glow. */
	it("returns fresh row arrays while working and memoized rows when idle", () => {
		const component = new UserMessageComponent("run the tests");
		const idleA = component.render(60);
		const idleB = component.render(60);
		expect(idleB).toBe(idleA);
		component.setWorking(true);
		const workA = component.render(60);
		const workB = component.render(60);
		expect(workB).not.toBe(workA);
	});

	/** The glow must land on VISIBLE characters: the painted row's sheen SGRs
	 * (per-character truecolor mixes) must wrap the prompt's trailing text,
	 * not the right-padding spaces. The regression this pins: padded rows end
	 * in SGR-wrapped spaces, paintHotTail's bare-space strip never fired, and
	 * the whole glow was invisible ink. */
	it("paints the sheen over the prompt's visible tail characters", () => {
		const component = new UserMessageComponent("fix the flaky auth test in ci");
		component.setWorking(true);
		const rows = component.render(80);
		const content = rows.find(row => stripAnsi(row.replace(OSC_ZONE, "")).includes("ci"))!;
		// The final visible character `i` (of "ci") must sit directly inside a
		// truecolor SGR that is NOT the flat base silver — the gradient's tip
		// always carries the fixed tip glow (paintHotTail tipGlow ≥ 0.5 at p=1),
		// so it is measurably brighter than the base at every sheen phase. Take
		// the LAST match: interior `i`s (of "in") sit mid-trail at ~base color.
		const tips = [...content.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)mi/g)];
		expect(tips.length).toBeGreaterThan(0);
		expect(tips[tips.length - 1]![0]).not.toBe("\x1b[38;2;198;203;212mi");
	});

	/** While glowing, the block must report unfinalized so the transcript keeps
	 * it in the live (repaintable) region; the frame the turn ends it must
	 * finalize again so history freezes into native scrollback. */
	it("stays unfinalized while working and finalizes when the turn ends", () => {
		const component = new UserMessageComponent("hello");
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		component.setWorking(true);
		expect(component.isTranscriptBlockFinalized()).toBe(false);
		component.setWorking(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	/** Ending the turn must restore the EXACT idle bytes (the memoized rows),
	 * so a finished prompt leaves no sheen residue in the transcript. */
	it("restores byte-identical idle rows after the glow ends", () => {
		const component = new UserMessageComponent("ship it");
		const idle = component.render(60);
		component.setWorking(true);
		component.render(60);
		component.setWorking(false);
		expect(component.render(60)).toEqual(idle);
	});

	/** The OSC 133 zone markers survive the glow untouched: the painted row is
	 * re-wrapped with the same start/end bytes, so terminal prompt-zone
	 * navigation keeps working mid-turn. */
	it("preserves OSC 133 zone markers on glowing rows", () => {
		const component = new UserMessageComponent("hi");
		component.setWorking(true);
		const rows = component.render(60);
		expect(rows[0]!.startsWith("\x1b]133;A\x07")).toBe(true);
		expect(rows[rows.length - 1]!.endsWith("\x1b]133;B\x07")).toBe(true);
	});
});
