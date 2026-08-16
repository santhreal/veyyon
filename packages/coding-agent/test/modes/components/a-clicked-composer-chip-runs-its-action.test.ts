/**
 * A click on a composer chip runs the chip's action.
 *
 * The composer chips ("dequeue", "interrupt", "background") were inert text:
 * the pointer answered nothing on the busiest chrome row in the app even
 * though the pinned-footer mouse route already delivered clicks to any child
 * that asked for them. This suite pins the contract both ways: a left click
 * inside a chip's span fires that chip's id through onChipClick, and a click
 * anywhere else in the band (the inset, a separator, the empty tail) fires
 * nothing. It also pins that chips exist only while their action is live, so
 * a click can never reach a stale action.
 *
 * Not covered: the host's id-to-action dispatch (editor callbacks), and hover
 * paint — the main session holds press/release tracking only so native
 * drag-select keeps working, so no motion events ever reach the bar. The bar
 * also has to ASK for that tracking (wantsPointer), or the terminal reports no
 * buttons at all in a session short enough that nothing scrolls and every chip
 * is dead; the engine side of that is pinned in the TUI package by
 * a-footer-click-target-holds-the-mouse-in-a-session-that-never-scrolls.test.ts.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { COMPOSER_INSET_COLS } from "@veyyon/coding-agent/modes/components/composer-chrome";
import { buildComposerShortcuts, ComposerShortcutsBar } from "@veyyon/coding-agent/modes/components/composer-shortcuts";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { SgrMouseEvent } from "@veyyon/tui";

beforeAll(() => initTheme());

function clickAt(col: number, row = 0): { event: SgrMouseEvent; line: number; col: number } {
	return {
		event: { button: 0, col, row, release: false, wheel: null, motion: false, leftClick: true },
		line: row,
		col,
	};
}

function click(bar: ComposerShortcutsBar, col: number, row = 0): void {
	const at = clickAt(col, row);
	bar.routeMouse(at.event, at.line, at.col);
}

function setupBar(): { bar: ComposerShortcutsBar; lines: string[]; clicked: string[] } {
	const bar = new ComposerShortcutsBar();
	bar.setShortcuts(
		buildComposerShortcuts(new KeybindingsManager(), {
			busy: true,
			hasDraft: false,
			hasQueue: true,
			focused: false,
			canBackgroundBash: true,
		}),
	);
	const clicked: string[] = [];
	bar.onChipClick = id => clicked.push(id);
	const lines = bar.render(100);
	return { bar, lines, clicked };
}

// Chips pack in visual columns; the styled row prepends SGR bytes, so
// measure positions on the plain text instead of the rendered string.
function plainOf(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function chipCol(lines: string[], label: string): number {
	const col = plainOf(lines[0]!).indexOf(label);
	expect(col).toBeGreaterThanOrEqual(COMPOSER_INSET_COLS);
	return col;
}

describe("composer chip clicks", () => {
	it("fires each chip's id when its label is clicked", () => {
		const { bar, lines, clicked } = setupBar();
		expect(lines).toHaveLength(1);

		click(bar, chipCol(lines, "dequeue") + 1);
		click(bar, chipCol(lines, "interrupt") + 1);
		click(bar, chipCol(lines, "background") + 1);

		expect(clicked).toEqual(["dequeue", "interrupt", "background"]);
	});

	it("fires nothing outside a chip span", () => {
		const { bar, lines, clicked } = setupBar();
		const dequeueCol = chipCol(lines, "dequeue");

		// The content inset before the first chip.
		click(bar, 0);
		// The separator between the interrupt and background chips (after the
		// interrupt label, before the background chip's key prefix).
		click(bar, chipCol(lines, "interrupt") + "interrupt".length + 2);
		// The empty tail past the last chip.
		click(bar, plainOf(lines[0]!).length + 5);
		// A release report is not a click.
		const release = clickAt(dequeueCol + 1);
		bar.routeMouse({ ...release.event, release: true, leftClick: false }, release.line, release.col);

		expect(clicked).toEqual([]);
	});

	it("renders only chips whose action is live", () => {
		const bar = new ComposerShortcutsBar();
		bar.setShortcuts(
			buildComposerShortcuts(new KeybindingsManager(), {
				busy: false,
				hasDraft: false,
				hasQueue: false,
				focused: false,
				canBackgroundBash: false,
			}),
		);
		const idleRows = bar.render(100);
		expect(idleRows).toHaveLength(1);
		expect(idleRows[0]!.trim()).toBe("");

		bar.setShortcuts(
			buildComposerShortcuts(new KeybindingsManager(), {
				busy: true,
				hasDraft: false,
				hasQueue: false,
				focused: false,
				canBackgroundBash: false,
			}),
		);
		const lines = bar.render(100);
		expect(lines[0]).toContain("interrupt");
		expect(lines[0]).not.toContain("dequeue");
		expect(lines[0]).not.toContain("background");
	});

	it("asks for the pointer exactly while a chip is on screen", () => {
		// The grab costs the terminal's native drag-select, so it is claimed
		// only for a row that has something to click, and dropped the moment
		// the chips clear. Before rendering the bar owns no screen row at all.
		const bar = new ComposerShortcutsBar();
		expect(bar.wantsPointer()).toBe(false);

		bar.setShortcuts(
			buildComposerShortcuts(new KeybindingsManager(), {
				busy: true,
				hasDraft: false,
				hasQueue: true,
				focused: false,
				canBackgroundBash: true,
			}),
		);
		bar.render(100);
		expect(bar.wantsPointer()).toBe(true);

		bar.setShortcuts([]);
		bar.render(100);
		expect(bar.wantsPointer()).toBe(false);
	});
});
