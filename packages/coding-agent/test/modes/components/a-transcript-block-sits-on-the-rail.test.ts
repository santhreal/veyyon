/**
 * A transcript block that owns a turn sits on the transcript's one left rail
 * and draws no full-width rule.
 *
 * WHY: `/btw` and `/omfg` painted a `───` rule at column 0 above and below four
 * short lines, and indented their content one column. That is two defects in
 * one block: the loudest thing on the screen was chrome, and it sat two columns
 * off the rail every other block follows (`COMPOSER_INSET_COLS`, owned by
 * `composer-chrome.ts`). The execution blocks had already settled this — see
 * `buildExecutionFrame` — so these two were the surviving exceptions.
 *
 * The class this closes is "a transcript block that invents its own geometry":
 * the assertions run over EVERY state each panel can paint, driven through the
 * panel's own public methods, and they read the painted rows rather than the
 * child list, so a future block that reintroduces a rule or an inset of its own
 * fails here whichever way it builds it. The state maps are keyed by the
 * exported state unions, so adding a state without deciding what it paints does
 * not type check.
 *
 * What it does not catch: a NEW transcript component that never routes through
 * `mountTranscriptBlock` is not enumerable from source (a transcript child is
 * any `Component`), so it is not swept here. It also says nothing about colour:
 * the rail is geometry, and the tone of a header is a theme question proven by
 * the render-proof images.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { BtwPanelComponent, type BtwPanelState } from "@veyyon/coding-agent/modes/components/btw-panel";
import { COMPOSER_INSET_COLS } from "@veyyon/coding-agent/modes/components/composer-chrome";
import { OmfgPanelComponent, type OmfgPanelState } from "@veyyon/coding-agent/modes/components/omfg-panel";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TUI } from "@veyyon/tui";

const WIDTH = 100;

function strip(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function stubUi(): TUI {
	return { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
}

/** Every painted row, ANSI removed, in render order. */
function paintedRows(component: { render(width: number): readonly string[] }): string[] {
	return component.render(WIDTH).map(strip);
}

function assertOnTheRail(rows: string[], label: string): void {
	for (const row of rows) {
		if (row.trim() === "") continue;
		const inset = row.length - row.trimStart().length;
		// The row text is carried for a readable failure; `inset` is the claim.
		expect({ label, row: row.trim().slice(0, 24), inset }).toEqual({
			label,
			row: row.trim().slice(0, 24),
			inset: COMPOSER_INSET_COLS,
		});
	}
}

function assertNoFullWidthRule(rows: string[], label: string): void {
	for (const row of rows) {
		const body = row.trim();
		if (body.length < 8) continue;
		const ruleGlyphs = /^[─━–—-]+$/;
		expect({ label, row: body.slice(0, 16), isRule: ruleGlyphs.test(body) }).toEqual({
			label,
			row: body.slice(0, 16),
			isRule: false,
		});
	}
}

/** Drive one panel into each state through its own public API. */
const BTW_STATES: Record<BtwPanelState, (panel: BtwPanelComponent) => void> = {
	running: panel => panel.appendText("partial answer"),
	complete: panel => {
		panel.setAnswer("A **focus string** names the tests a run executes.");
		panel.markComplete();
	},
	aborted: panel => panel.markAborted(),
	error: panel => panel.markError("provider refused the request"),
};

const OMFG_STATES: Record<OmfgPanelState, (panel: OmfgPanelComponent) => void> = {
	generating: panel => panel.appendDraft("## Imports\n\nNever reorder"),
	validating: panel => panel.setStatus("validating", "Checking the rule…"),
	confirming: panel => {
		panel.setRule("## Imports\n\nNever reorder an untouched import block.");
		panel.setStatus("confirming", "Save this rule? y/n");
	},
	saving: panel => panel.setStatus("saving", "Writing AGENTS.md…"),
	saved: panel => panel.markSaved("/repo/AGENTS.md"),
	rejected: panel => panel.markRejected(),
	aborted: panel => panel.markAborted(),
	error: panel => panel.markError("rule failed validation"),
};

describe("a transcript block sits on the rail", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	it("paints every /btw state at the rail, with no rule", () => {
		for (const [state, drive] of Object.entries(BTW_STATES)) {
			const panel = new BtwPanelComponent({ question: "what is a focus string?", tui: stubUi() });
			drive(panel);
			const rows = paintedRows(panel);
			assertOnTheRail(rows, `btw/${state}`);
			assertNoFullWidthRule(rows, `btw/${state}`);
		}
	});

	it("paints every /omfg state at the rail, with no rule", () => {
		for (const [state, drive] of Object.entries(OMFG_STATES)) {
			const panel = new OmfgPanelComponent({ complaint: "stop reformatting my imports", tui: stubUi() });
			drive(panel);
			const rows = paintedRows(panel);
			assertOnTheRail(rows, `omfg/${state}`);
			assertNoFullWidthRule(rows, `omfg/${state}`);
		}
	});

	it("opens each block with the command that made it", () => {
		const btw = new BtwPanelComponent({ question: "what is a focus string?", tui: stubUi() });
		expect(paintedRows(btw)[0]?.trimEnd()).toBe(`${" ".repeat(COMPOSER_INSET_COLS)}/btw what is a focus string?`);

		const omfg = new OmfgPanelComponent({ complaint: "stop reformatting my imports", tui: stubUi() });
		expect(paintedRows(omfg)[0]?.trimEnd()).toBe(
			`${" ".repeat(COMPOSER_INSET_COLS)}/omfg stop reformatting my imports`,
		);
	});

	it("keeps the hint row last, so the block ends on what to press", () => {
		const panel = new BtwPanelComponent({ question: "what is a focus string?", tui: stubUi() });
		panel.setAnswer("An answer.");
		panel.markComplete();
		const rows = paintedRows(panel).filter(row => row.trim() !== "");
		expect(rows.at(-1)?.trimEnd()).toBe(`${" ".repeat(COMPOSER_INSET_COLS)}c copy · b branch to chat · Esc dismiss`);
	});
});
