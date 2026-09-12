/**
 * WHY: the `/btw` and `/omfg` panels end in one of several outcomes — complete or saved, rejected,
 * aborted, error — and each outcome used to be its own copy of the same four lines: the closed
 * guard, the state, the error text, the repaint. Every outcome now settles through one private
 * helper per panel, and this suite pins what a settled panel paints through the public methods the
 * controllers call, since no other suite reads the error body, a footer after a second outcome, or
 * a panel painted after `close()`.
 *
 * The class: an outcome that paints the wrong body or footer, an error text that survives a later
 * outcome, and a panel that repaints after the operator dismissed it. Every outcome is driven the
 * way its controller drives it and asserted against the painted rows.
 *
 * Not caught: the controllers' choice of which outcome to call, which
 * `controllers/btw-controller.test.ts` and the `/omfg` controller suites own.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { BtwPanelComponent } from "@veyyon/coding-agent/modes/terminal/components/dialogs/btw-panel";
import { OmfgPanelComponent } from "@veyyon/coding-agent/modes/terminal/components/dialogs/omfg-panel";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { TUI } from "@veyyon/tui";

const WIDTH = 100;

function stubUi(): TUI {
	return { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
}

function paintedText(component: { render(width: number): readonly string[] }): string {
	return component
		.render(WIDTH)
		.map(row => row.replace(/\x1b\[[0-9;]*m/g, ""))
		.join("\n");
}

describe("a settled panel paints its outcome and a closed one stays put", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	describe("/btw", () => {
		it("paints the error text it was given, and drops it when a later outcome replaces the error", () => {
			const panel = new BtwPanelComponent({ question: "why", tui: stubUi() });
			panel.markError("provider refused the request");
			const errored = paintedText(panel);
			expect(errored).toContain("provider refused the request");
			expect(errored).toContain("Error · Esc dismiss");

			panel.markAborted();
			const aborted = paintedText(panel);
			expect(aborted).not.toContain("provider refused the request");
			expect(aborted).toContain("Cancelled · Esc dismiss");
		});

		it("paints a complete answer as copyable and an aborted one as cancelled", () => {
			const panel = new BtwPanelComponent({ question: "why", tui: stubUi() });
			panel.setAnswer("Because.");
			panel.markComplete();
			expect(paintedText(panel)).toContain("c copy · b branch to chat · Esc dismiss");
			expect(panel.getCopyText()).toBe("Because.");

			panel.markAborted();
			expect(paintedText(panel)).toContain("Cancelled · Esc dismiss");
			expect(panel.getCopyText()).toBeUndefined();
		});

		it("ignores every outcome after it is closed", () => {
			const panel = new BtwPanelComponent({ question: "why", tui: stubUi() });
			panel.setAnswer("Because.");
			panel.markComplete();
			const before = paintedText(panel);
			panel.close();
			panel.markError("late failure");
			panel.markAborted();
			expect(paintedText(panel)).toBe(before);
			expect(panel.getCopyText()).toBe("Because.");
		});
	});

	describe("/omfg", () => {
		it("paints the error text it was given, and drops it when a later outcome replaces the error", () => {
			const panel = new OmfgPanelComponent({ complaint: "stop it", tui: stubUi() });
			panel.markError("rule failed validation");
			const errored = paintedText(panel);
			expect(errored).toContain("rule failed validation");
			expect(errored).toContain("Could not create rule.");
			expect(errored).toContain("Error · Esc dismiss");

			panel.markRejected();
			const rejected = paintedText(panel);
			expect(rejected).not.toContain("rule failed validation");
			expect(rejected).toContain("Rule was not saved.");
			expect(rejected).toContain("Not saved · Esc dismiss");
		});

		it("paints each status it is set, then the outcome that ends it", () => {
			const panel = new OmfgPanelComponent({ complaint: "stop it", tui: stubUi() });
			panel.setStatus("validating", "Checking the rule…");
			expect(paintedText(panel)).toContain("Checking the rule…");
			panel.markAborted();
			const aborted = paintedText(panel);
			expect(aborted).not.toContain("Checking the rule…");
			expect(aborted).toContain("Cancelled.");
			expect(aborted).toContain("Cancelled · Esc dismiss");
		});

		it("ignores every status and outcome after it is closed", () => {
			const panel = new OmfgPanelComponent({ complaint: "stop it", tui: stubUi() });
			panel.markSaved("/repo/AGENTS.md");
			const before = paintedText(panel);
			panel.close();
			panel.setStatus("saving", "Writing again…");
			panel.markError("late failure");
			panel.markSaved("/elsewhere/AGENTS.md");
			expect(paintedText(panel)).toBe(before);
		});
	});
});
