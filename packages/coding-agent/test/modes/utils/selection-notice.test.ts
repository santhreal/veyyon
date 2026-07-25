import { describe, expect, it } from "bun:test";
import { createSelectionAttemptNotice, SELECTION_HELD_HINT } from "@veyyon/coding-agent/modes/utils/selection-notice";

/**
 * The answer given when a mouse drag selected nothing.
 *
 * Scroll isolation holds the mouse so the wheel can scroll the transcript with
 * the prompt pinned, which also means plain drag-select no longer reaches the
 * terminal. That tradeoff was documented only in a settings description, so the
 * operator's experience was a drag that did nothing and no explanation at all:
 * "i cant copy and paste from the terminal" (2026-07-24). These cases lock the
 * hint's content (every way out is named) and its frequency (once, so a hint
 * does not become noise).
 */

describe("the swallowed-drag hint", () => {
	it("names all three ways to select or copy", () => {
		// A hint that named only shift+drag would leave an operator whose terminal
		// does not support it with no way forward, and one that named only the
		// setting would trade scrolling away for copying.
		expect(SELECTION_HELD_HINT).toContain("shift+drag");
		expect(SELECTION_HELD_HINT).toContain("/copy");
		expect(SELECTION_HELD_HINT).toContain("tui.scrollIsolation=false");
	});

	it("says why the drag did nothing, not just what to press", () => {
		// The operator's model is "copy is broken". The hint has to correct that
		// model, so it states who holds the wheel rather than only listing keys.
		expect(SELECTION_HELD_HINT).toContain("transcript owns the wheel");
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
