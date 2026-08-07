/**
 * Composer-zone mounting contract (ARCH-2 bottom-chrome slice). The mount
 * ORDER is the design: loader and hook status above the hairline, one blank
 * pad row on each side of the input, footline and shortcuts under the card,
 * one margin row off the terminal floor. The pads paint nothing — every
 * tinted composer ground read as a grey slab on a mismatched terminal, so
 * the air around the input is the terminal's own
 * background. `mountComposerZone` is the ONE owner of that order; these tests
 * pin every row by identity and by what it renders, so a re-ordered, dropped,
 * or re-painted row fails loudly.
 */
import { describe, expect, it } from "bun:test";
import {
	CardPadRow,
	COMPOSER_BOTTOM_MARGIN_ROWS,
	type ComposerZoneParts,
	mountComposerZone,
} from "@veyyon/coding-agent/modes/components/composer-chrome";
import type { Component } from "@veyyon/tui";
import { Spacer } from "@veyyon/tui";

function part(name: string): Component {
	return {
		render: () => [name],
		invalidate: () => {},
	};
}

function mount(): { parts: ComposerZoneParts; children: Component[] } {
	const parts: ComposerZoneParts = {
		statusContainer: part("statusContainer"),
		statusLine: part("statusLine"),
		hookWidgetsAbove: part("hookWidgetsAbove"),
		hairline: part("hairline"),
		editorContainer: part("editorContainer"),
		capabilityLine: part("capabilityLine"),
		shortcuts: part("shortcuts"),
		hookWidgetsBelow: part("hookWidgetsBelow"),
	};
	const children: Component[] = [];
	mountComposerZone({ addChild: c => children.push(c) }, parts);
	return { parts, children };
}

describe("mountComposerZone", () => {
	it("mounts exactly 11 rows: 8 parts, 2 card pads, 1 bottom margin", () => {
		const { children } = mount();
		expect(children).toHaveLength(11);
	});

	it("mounts every part in the canonical design order, by identity", () => {
		const { parts, children } = mount();
		// Status block above the hairline, card below it, footline under the card.
		expect(children[0]).toBe(parts.statusContainer);
		expect(children[1]).toBe(parts.statusLine);
		expect(children[2]).toBe(parts.hookWidgetsAbove);
		expect(children[3]).toBe(parts.hairline);
		expect(children[5]).toBe(parts.editorContainer);
		expect(children[7]).toBe(parts.capabilityLine);
		expect(children[8]).toBe(parts.shortcuts);
		expect(children[9]).toBe(parts.hookWidgetsBelow);
	});

	/**
	 * The two pad rows are the vertical air around the input, and they PAINT NOTHING. An earlier
	 * revision tinted them, and every painted composer ground read as a grey slab on a terminal
	 * whose own background differed; `CardPadRow`'s doc names reintroducing
	 * paint here as the regression. So the assertion is on what the slots RENDER — exactly one row
	 * each, blank, with no SGR at all — rather than on which class occupies them: the class identity
	 * held while the rows painted a slab, and would hold again.
	 */
	it("sandwiches the editor between two unpainted single-row pads", () => {
		const { children } = mount();
		for (const index of [4, 6]) {
			const pad = children[index] as Component;
			expect(pad, `slot ${index}`).toBeInstanceOf(CardPadRow);
			expect(pad.render(80), `slot ${index} must be exactly one row of air`).toEqual([""]);
		}
	});

	it("ends with exactly one bottom-margin row of the pinned height", () => {
		const { children } = mount();
		const last = children[10] as Component;
		expect(last).toBeInstanceOf(Spacer);
		// Spacer(n) renders n blank rows; the margin is exactly the owned const.
		expect(last.render(80)).toHaveLength(COMPOSER_BOTTOM_MARGIN_ROWS);
		expect(COMPOSER_BOTTOM_MARGIN_ROWS).toBe(1);
	});
});
