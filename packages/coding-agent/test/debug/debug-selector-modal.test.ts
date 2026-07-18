import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { DebugSelectorComponent } from "@veyyon/coding-agent/debug";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";

beforeAll(async () => {
	await initTheme();
});

function plain(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n"));
}

function makeCtx(overrides: Partial<InteractiveModeContext> = {}): InteractiveModeContext {
	return {
		sessionManager: { getSessionFile: () => undefined },
		showWarning: () => {},
		showError: () => {},
		...overrides,
	} as unknown as InteractiveModeContext;
}

/**
 * `/debug` used to sandwich its SelectList between two `DynamicBorder` rules
 * hosted in the editor slot. It is now a floating ModalShell card hosted
 * fullscreen via `showModalSelector`, matching theme/queue-mode/reset-usage.
 */
describe("DebugSelectorComponent — ModalShell migration", () => {
	it("paints ModalShell chrome (title-in-border, close glyph, footer chips) instead of a DynamicBorder sandwich", () => {
		let done = false;
		const selector = new DebugSelectorComponent(makeCtx(), () => {
			done = true;
		});

		const text = plain(selector.render(100));

		// Title lives inside the top border row (ModalShell), not a bare line
		// below a horizontal rule (the old DynamicBorder + Text + Spacer stack).
		expect(text).toContain("Debug Tools");
		expect(text).toContain("[x]");
		// Every visible menu item still renders inside the card body.
		expect(text).toContain("Report: dump session");
		expect(text).toContain("View: recent logs");
		// Shared ModalShell footer chips (SELECT_LIST_SHORTCUTS), not the old
		// bare "Esc"-only hint.
		expect(text).toContain("select");
		expect(text).toContain("close");
		expect(done).toBe(false);
	});

	it("closes via the shared ModalShell cancel path on Escape", () => {
		let done = false;
		const selector = new DebugSelectorComponent(makeCtx(), () => {
			done = true;
		});
		selector.render(100);

		selector.handleInput("\x1b");

		expect(done).toBe(true);
	});

	it("dispatches the selected menu action and closes on Enter", async () => {
		let done = false;
		let warned: string | undefined;
		const selector = new DebugSelectorComponent(
			makeCtx({
				showWarning: (message: string) => {
					warned = message;
				},
			}),
			() => {
				done = true;
			},
		);
		selector.render(100);

		// First item is "Open: artifact folder"; with no active session file
		// the handler warns instead of touching the filesystem.
		selector.handleInput("\n");
		await Promise.resolve();
		await Promise.resolve();

		expect(done).toBe(true);
		expect(warned).toBe("No active session file.");
	});
});
