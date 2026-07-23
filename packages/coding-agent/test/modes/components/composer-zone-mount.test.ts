/**
 * Composer-zone mounting contract (ARCH-2 bottom-chrome slice). The mount
 * ORDER is the design: loader and hook status above the hairline, one
 * CardPadRow of tonal air on each side of the input (bare spacers collapse
 * the card to a cramped tinted strip — the user's 2026-07-22 screenshot),
 * footline and shortcuts under the card, one margin row off the terminal
 * floor. `mountComposerZone` is the ONE owner of that order; these tests pin
 * every row by identity/class so a re-ordered or dropped row fails loudly,
 * and a source lock keeps interactive-mode from re-inlining the paste of
 * addChild calls this extraction replaced.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

	it("sandwiches the editor between two CardPadRows (tonal air, not bare spacers)", () => {
		const { children } = mount();
		expect(children[4]).toBeInstanceOf(CardPadRow);
		expect(children[6]).toBeInstanceOf(CardPadRow);
		// The pads must NOT be Spacers: a bare blank row drops the card ground
		// and collapses the card to a single tinted strip.
		expect(children[4]).not.toBeInstanceOf(Spacer);
		expect(children[6]).not.toBeInstanceOf(Spacer);
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

describe("interactive-mode delegation source lock", () => {
	const source = readFileSync(join(import.meta.dir, "../../../src/modes/interactive-mode.ts"), "utf8");

	it("mounts the composer zone through mountComposerZone, never an inline addChild paste", () => {
		// The extraction this suite guards: the host hands its parts to the one
		// order owner. A parallel writer re-inlining the block re-creates the
		// two-owners drift hazard.
		expect(source).toContain("mountComposerZone(this.ui, {");
		expect(source).not.toContain("addChild(new CardPadRow())");
		expect(source).not.toContain("this.ui.addChild(this.composerHairline)");
		expect(source).not.toContain("this.ui.addChild(this.capabilityLine)");
		expect(source).not.toContain("COMPOSER_BOTTOM_MARGIN_ROWS = ");
	});
});
