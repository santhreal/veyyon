/**
 * The working indicator on the newest user prompt.
 *
 * Why this suite exists: prompts rendered gray-on-gray (titanium's
 * `userMessageText` was the dim tone) and nothing indicated WHICH message the
 * agent was working on (user report, 2026-07-22). The first shipped fix
 * animated a per-frame sheen and kept the block unfinalized for the whole
 * turn — that pinned the transcript's live-region seam open and committed a
 * giant blank hole into the transcript (user screenshot, 2026-07-22). The
 * indicator is therefore STATIC: an ember `›` glyph while working, bytes
 * changing only at arm/disarm, surfaced through the block version. These
 * tests pin both the visibility fix and the static-indicator contract so
 * neither the gray-on-gray text nor the animated-seam regression can return.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { UserMessageComponent } from "@veyyon/coding-agent/modes/components/user-message";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { TERMINAL } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";

// The color assertions below pin exact 24-bit bytes (`38;2;r;g;b`). The theme
// bakes each color to ANSI at construction using `detectColorMode()`, which
// returns `256color` when `TERM` is `""`/`dumb`/`linux` (a CI runner) unless
// `COLORTERM` says truecolor — so the glyph/text degrade to `38;5;n` and the
// suite passes on a developer's truecolor terminal but fails in CI. Force
// `COLORTERM=truecolor` BEFORE the theme is built (getThemeByName builds fresh,
// no cache), and also flip `TERMINAL.trueColor` for any sub-path that reads that
// second depth signal (markdown/shimmer). Restore both after.
const trueColorHandle = TERMINAL as unknown as { trueColor: boolean };
const originalTrueColor = trueColorHandle.trueColor;
const originalColorterm = Bun.env.COLORTERM;

describe("UserMessageComponent working indicator", () => {
	beforeAll(async () => {
		Bun.env.COLORTERM = "truecolor";
		trueColorHandle.trueColor = true;
		await Settings.init({ inMemory: true });
		setThemeInstance((await getThemeByName("titanium"))!);
	});

	afterAll(() => {
		trueColorHandle.trueColor = originalTrueColor;
		if (originalColorterm === undefined) delete (Bun.env as Record<string, string | undefined>).COLORTERM;
		else Bun.env.COLORTERM = originalColorterm;
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

	/** While working, the `›` glyph turns ember (titanium borderAccent #F0862E
	 * → 38;2;240;134;46); idle it is dim. This is the whole indicator — any
	 * richer per-frame treatment re-opens the seam regression. */
	it("turns the gutter glyph ember while working and dim when idle", () => {
		const component = new UserMessageComponent("run the tests");
		const idleRow = component.render(60).find(row => stripAnsi(row).includes("›"))!;
		expect(idleRow).toContain("\x1b[38;2;86;95;119m›");
		component.setWorking(true);
		const workRow = component.render(60).find(row => stripAnsi(row).includes("›"))!;
		expect(workRow).toContain("\x1b[38;2;240;134;46m›");
	});

	/** The block must stay FINALIZED at all times: an unfinalized block near
	 * the transcript top pins the live-region seam open and commits a blank
	 * hole (the shipped regression this suite exists to lock out). The
	 * component must not even define the finalization hook. */
	it("never reports itself unfinalized, working or not", () => {
		const component = new UserMessageComponent("hello") as unknown as {
			isTranscriptBlockFinalized?: () => boolean;
			setWorking(on: boolean): void;
		};
		expect(component.isTranscriptBlockFinalized).toBeUndefined();
	});

	/** Arm/disarm is a post-finalize mutation, so it must bump the block
	 * version — that is what lets an already-committed prompt repaint its
	 * glyph instead of replaying stale bytes. Setting the same state twice
	 * must NOT bump (a no-op toggle would churn the committed-prefix audit). */
	it("bumps the block version exactly once per state change", () => {
		const component = new UserMessageComponent("hello");
		const v0 = component.getTranscriptBlockVersion();
		component.setWorking(true);
		const v1 = component.getTranscriptBlockVersion();
		expect(v1).toBe(v0 + 1);
		component.setWorking(true);
		expect(component.getTranscriptBlockVersion()).toBe(v1);
		component.setWorking(false);
		expect(component.getTranscriptBlockVersion()).toBe(v1 + 1);
	});

	/** Rows must be reference-stable WITHIN a state (the transcript's identity
	 * reuse depends on it) and rebuilt across a state change. A fresh array
	 * every frame was the animated regression's signature. */
	it("returns reference-stable rows within a state, fresh rows across states", () => {
		const component = new UserMessageComponent("ship it");
		const idleA = component.render(60);
		expect(component.render(60)).toBe(idleA);
		component.setWorking(true);
		const workA = component.render(60);
		expect(workA).not.toBe(idleA);
		expect(component.render(60)).toBe(workA);
	});

	/** Ending the turn restores byte-identical idle rows — no residue of the
	 * working state may remain in the transcript. */
	it("restores byte-identical idle rows after the turn ends", () => {
		const component = new UserMessageComponent("ship it");
		const idle = [...component.render(60)];
		component.setWorking(true);
		component.render(60);
		component.setWorking(false);
		expect([...component.render(60)]).toEqual(idle);
	});

	/** The OSC 133 zone markers are gone in both states: terminals painting
	 * prompt zones drew them as an uncontrolled background block over the
	 * message (operator screenshots, 2026-07-23). */
	it("emits no OSC 133 zone markers in either state", () => {
		const component = new UserMessageComponent("hi");
		component.setWorking(true);
		for (const line of component.render(60)) {
			expect(line).not.toContain("\x1b]133;");
		}
		component.setWorking(false);
		for (const line of component.render(60)) {
			expect(line).not.toContain("\x1b]133;");
		}
	});
});
