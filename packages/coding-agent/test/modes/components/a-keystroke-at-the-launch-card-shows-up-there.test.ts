/**
 * WHY: the launch card paints a composer and session startup then runs for the
 * better part of a second, so the card shows something that looks ready to type
 * into long before the session exists. Earlier shapes drew a picture of a
 * composer and held keystrokes in a gate, and every version of that arrangement
 * lost the echo somewhere: the operator typed at a visible prompt and saw
 * nothing come back.
 *
 * The class this closes is "the card lies about being live". It is closed by
 * construction now — the card mounts the real editor — so what is left to pin
 * is that the live composer, dressed the way the launch path dresses it, still
 * behaves like the resting zone the mode mounts into:
 *
 * 1. The ghost prompt is what an untouched card shows.
 * 2. A draft replaces the ghost prompt rather than joining it.
 * 3. A one-line draft does not move the row count. The mounted composer takes
 *    these exact rows, and a card that grew a row as soon as you typed would
 *    push the whole zone.
 * 4. It still draws at a width with no room for the gutter.
 *
 * WHAT IT DOES NOT CATCH: that a keystroke reaches this editor at all. That is
 * routing through a real TUI and a real terminal, and it is asserted in
 * `test/what-you-type-at-the-launch-card-reaches-the-composer.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	applyComposerChrome,
	COMPOSER_PLACEHOLDER,
	COMPOSER_RESTING_ROWS,
	computeEditorMaxHeight,
	mountLaunchComposer,
	PRISTINE_COMPOSER_ACCENT_STATE,
	resolveComposerAccents,
} from "@veyyon/coding-agent/modes/terminal/components/composer/composer-chrome";
import { CustomEditor } from "@veyyon/coding-agent/modes/terminal/components/composer/custom-editor";
import { getEditorTheme, initTheme } from "@veyyon/coding-agent/theme/theme";
import type { Component } from "@veyyon/tui";

beforeAll(async () => {
	// The card's footline is the configured status row, so this suite owns its own settings store
	// rather than inheriting whatever a neighbouring file in the bucket left initialized.
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

/** The launch composer and the live editor inside it, built the launch way. */
function launchComposer(): { editor: CustomEditor; render: (width: number) => string[] } {
	const editor = new CustomEditor(getEditorTheme());
	applyComposerChrome(editor, resolveComposerAccents(PRISTINE_COMPOSER_ACCENT_STATE));
	editor.setMaxHeight(computeEditorMaxHeight(30));
	const mounted: Component[] = [];
	mountLaunchComposer({ addChild: child => mounted.push(child) }, editor);
	return {
		editor,
		render: width => mounted.flatMap(child => child.render(width)).map(row => stripVTControlCharacters(row)),
	};
}

/** The one row that carries the gutter and whatever the composer is showing. */
function inputRow(rows: readonly string[]): string {
	const row = rows.find(line => line.includes("›"));
	expect(row).toBeDefined();
	return row as string;
}

describe("the launch card's composer", () => {
	it("shows the ghost prompt until something is typed", () => {
		expect(inputRow(launchComposer().render(80))).toContain(COMPOSER_PLACEHOLDER);
	});

	it("shows what was typed at it instead of the ghost prompt", () => {
		const composer = launchComposer();
		composer.editor.setText("fix the parser");

		const row = inputRow(composer.render(80));
		expect(row).toContain("fix the parser");
		expect(row).not.toContain(COMPOSER_PLACEHOLDER);
	});

	it("keeps the resting row count once a draft is showing", () => {
		const composer = launchComposer();
		expect(composer.render(80)).toHaveLength(COMPOSER_RESTING_ROWS);
		composer.editor.setText("a draft long enough to be interesting");

		expect(composer.render(80)).toHaveLength(COMPOSER_RESTING_ROWS);
	});

	it("draws rows rather than throwing when the terminal has no room for one", () => {
		const composer = launchComposer();
		composer.editor.setText("wide enough to not fit");

		expect(composer.render(1).length).toBeGreaterThan(0);
	});
});
