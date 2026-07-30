import { describe, expect, it } from "bun:test";
import { createSelectionAttemptNotice, SELECTION_HELD_HINT } from "@veyyon/coding-agent/modes/utils/selection-notice";

/**
 * The answer given when a mouse drag selected nothing.
 *
 * Scroll isolation holds the mouse so the wheel can scroll the transcript with
 * the prompt pinned, which also means plain drag-select no longer reaches the
 * terminal. That tradeoff was documented only in a settings description, so the
 * operator's experience was a drag that did nothing and no explanation at all:
 * "i cant copy and paste from the terminal" (2026-07-24). The hold is now
 * time-boxed and expires on a few seconds of quiet, which adds a fourth and
 * cheapest answer -- wait -- and makes ORDER part of the contract: leading with
 * a key combo would teach an operator to reach for shift forever on a hold that
 * lasts seconds. These cases lock the hint's content (every way out is named),
 * its order (cheapest first), and its frequency (once, so it does not become
 * noise).
 */

describe("the swallowed-drag hint", () => {
	it("names all three ways to select or copy, cheapest first", () => {
		// A hint that named only shift+drag would leave an operator whose terminal
		// does not support it with no way forward, and one that named only the
		// setting would trade scrolling away for copying. All three must be present
		// so every terminal and every preference has a route out.
		expect(SELECTION_HELD_HINT).toContain("shift and drag");
		expect(SELECTION_HELD_HINT).toContain("/copy");
		expect(SELECTION_HELD_HINT).toContain("tui.scrollIsolation=false");
	});

	it("never promises the mouse comes back on its own", () => {
		// An earlier build released the grab after ~3s of quiet and this hint told
		// the operator to "Pause a moment" and drag. That timer was removed because
		// it unpinned the composer at random and made selection depend on timing.
		// The wording outlived the behaviour, which is worse than no hint: it sends
		// the operator off to wait for a handback that never arrives. If the timer
		// ever returns, restore the wording deliberately rather than by accident.
		expect(SELECTION_HELD_HINT).not.toContain("Pause a moment");
		expect(SELECTION_HELD_HINT).not.toContain("hands the mouse back");
		expect(SELECTION_HELD_HINT).not.toMatch(/hands it back|wait a|few seconds/i);
	});

	it("leads with shift+drag, the answer that works right now", () => {
		// Order is the message. With no timed handback, the cheapest real answer is
		// the terminal's own override: it needs no setting change and no picker, so
		// burying it under /copy or a config path would teach the long way round.
		const shift = SELECTION_HELD_HINT.indexOf("shift and drag");
		expect(shift).toBeGreaterThan(-1);
		expect(shift).toBeLessThan(SELECTION_HELD_HINT.indexOf("/copy"));
		expect(shift).toBeLessThan(SELECTION_HELD_HINT.indexOf("tui.scrollIsolation=false"));
	});

	it("says why the drag did nothing, not just what to press", () => {
		// The operator's model is "copy is broken". The hint has to correct that
		// model, so it states who holds the mouse rather than only listing keys.
		expect(SELECTION_HELD_HINT).toContain("holds the mouse");
	});

	it("delivers the hint on the first swallowed drag", () => {
		const shown: string[] = [];
		const notice = createSelectionAttemptNotice(message => shown.push(message));
		notice();
		expect(shown).toEqual([SELECTION_HELD_HINT]);
	});

	it("stays quiet on every later drag", () => {
		// The engine reports EVERY drag it swallows (it keeps no "already told
		// them" state), so suppressing repeats is this wrapper's job. Without it
		// a normal selecting habit would print a line per gesture.
		const shown: string[] = [];
		const notice = createSelectionAttemptNotice(message => shown.push(message));
		for (let i = 0; i < 5; i++) notice();
		expect(shown.length).toBe(1);
	});

	it("tracks 'told' per notice, not per module", () => {
		// Module-level state would silence the hint for a second session in the
		// same process (the SDK embeds several), so each host gets its own.
		const first: string[] = [];
		const second: string[] = [];
		const a = createSelectionAttemptNotice(m => first.push(m));
		const b = createSelectionAttemptNotice(m => second.push(m));
		a();
		a();
		b();
		expect(first.length).toBe(1);
		expect(second.length).toBe(1);
	});
});
