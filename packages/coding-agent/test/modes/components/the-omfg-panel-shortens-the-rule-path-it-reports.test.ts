/**
 * WHY: `/omfg` writes a rule file and then names it on screen. The panel
 * interpolated that absolute path into three rows verbatim — the "Registered
 * live · <path>" footer, the `Saved <path>` subheader, and, for a failure, the
 * raw error text, which routinely embeds the same path. A transcript is copied
 * into issues and pull requests, so the operator's home directory travelled
 * with it. None of the three was truncated either, and the footer shares one
 * row with the dismiss chip.
 *
 * The class is "a panel row built from a path this process just wrote". Every
 * state the panel can paint is driven through its own public methods, keyed by
 * the exported `OmfgPanelState` union so a new state does not type check until
 * someone decides what it paints, and the assertion is made against the painted
 * rows rather than the fields behind them.
 *
 * Not caught: a home directory this process does not report as its own, and a
 * path that reaches the panel already shortened (there is nothing to detect).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import os from "node:os";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { OmfgPanelComponent, type OmfgPanelState } from "@veyyon/coding-agent/modes/components/omfg-panel";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TUI } from "@veyyon/tui";

const WIDTH = 100;
const HOME = os.homedir();
const RULE_PATH = `${HOME}/workspace/project/AGENTS.md`;

function stubUi(): TUI {
	return { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
}

function paintedText(component: { render(width: number): readonly string[] }): string {
	return component
		.render(WIDTH)
		.map(row => row.replace(/\x1b\[[0-9;]*m/g, ""))
		.join("\n");
}

/** Each state driven the way the controller drives it, carrying a real path. */
const STATES: Record<OmfgPanelState, (panel: OmfgPanelComponent) => void> = {
	generating: panel => panel.appendDraft("## Imports\n\nNever reorder"),
	validating: panel => panel.setStatus("validating", `Checking ${RULE_PATH}…`),
	confirming: panel => {
		panel.setRule("## Imports\n\nNever reorder an untouched import block.");
		panel.setStatus("confirming", `Save to ${RULE_PATH}? y/n`);
	},
	saving: panel => panel.setStatus("saving", `Writing ${RULE_PATH}…`),
	saved: panel => panel.markSaved(RULE_PATH),
	rejected: panel => panel.markRejected(),
	aborted: panel => panel.markAborted(),
	error: panel => panel.markError(`EACCES: permission denied, open '${RULE_PATH}'`),
};

describe("the /omfg panel shortens the rule path it reports", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	for (const [state, drive] of Object.entries(STATES)) {
		it(`prints no home directory in the ${state} state`, () => {
			const panel = new OmfgPanelComponent({ complaint: "stop reformatting my imports", tui: stubUi() });
			drive(panel);
			expect(paintedText(panel)).not.toContain(HOME);
		});
	}

	it("names the saved rule under a tilde in both the subheader and the footer", () => {
		const panel = new OmfgPanelComponent({ complaint: "stop reformatting my imports", tui: stubUi() });
		panel.markSaved(RULE_PATH);
		const text = paintedText(panel);
		expect(text).toContain("Saved ~/workspace/project/AGENTS.md");
		expect(text).toContain("Registered live · ~/workspace/project/AGENTS.md");
	});

	it("keeps the footer on one row when the saved path is far longer than the terminal", () => {
		const panel = new OmfgPanelComponent({ complaint: "c", tui: stubUi() });
		panel.markSaved(`${HOME}/${"deeply-nested-directory/".repeat(20)}AGENTS.md`);
		const footer = paintedText(panel)
			.split("\n")
			.filter(row => row.includes("Registered live"));
		expect(footer).toHaveLength(1);
		expect(footer[0]!.length).toBeLessThanOrEqual(WIDTH);
	});
});
