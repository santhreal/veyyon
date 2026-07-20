/**
 * Sidebar focus model for the settings dialog: Left from the pane focuses the
 * vertical category sidebar (it must never wrap-cycle categories — Left on the
 * first category used to jump to the last one and drop the caret), Up/Down
 * there step categories clamped at the ends, and Right/Enter return focus to
 * the settings rows. Also locks the status-line preview inside the pane: a
 * preview wider than the pane used to punch through the modal's right border.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

function strip(s: string): string {
	return stripVTControlCharacters(s);
}

/** The stripped sidebar row carrying the category cursor, e.g. `› A Appearance`. */
function cursorCategoryRow(frame: readonly string[]): string | undefined {
	return frame.map(strip).find(line => /›\s+(Appearance|Model|Interaction|Context)/.test(line));
}

function footerText(frame: readonly string[]): string {
	return frame
		.map(strip)
		.filter(line => line.includes("navigate") || line.includes("category"))
		.join(" | ");
}

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

function stubStdoutGeometry(rows: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	return {
		restore() {
			if (rowsDesc) Object.defineProperty(process.stdout, "rows", rowsDesc);
		},
	};
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(40);
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
});

function createSelector(preview?: () => string): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: ["alpha"],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel: () => {}, getStatusLinePreview: preview },
	);
}

describe("settings sidebar focus", () => {
	it("Left from the pane focuses the sidebar without changing the category", () => {
		const comp = createSelector();
		comp.render(160);
		comp.handleInput(LEFT);
		const frame = comp.render(160);
		// Still on the first category — the old behavior wrap-cycled to the last tab.
		expect(cursorCategoryRow(frame)).toContain("Appearance");
		expect(footerText(frame)).toContain("up/down category");
	});

	it("Up at the first category clamps; Down steps to the next category", () => {
		const comp = createSelector();
		comp.render(160);
		comp.handleInput(LEFT);
		comp.handleInput(UP);
		expect(cursorCategoryRow(comp.render(160))).toContain("Appearance");
		comp.handleInput(DOWN);
		expect(cursorCategoryRow(comp.render(160))).toContain("Model");
	});

	it("Right hands focus back to the settings rows", () => {
		const comp = createSelector();
		comp.render(160);
		comp.handleInput(LEFT);
		comp.handleInput(RIGHT);
		const frame = comp.render(160);
		expect(footerText(frame)).toContain("up/down navigate");
		expect(footerText(frame)).not.toContain("up/down category");
	});

	it("Left/Right never change a boolean value; activation toggles it in place", () => {
		const SPACE = " ";
		const comp = createSelector();
		comp.render(160);
		// Appearance tab: Dark Theme, Light Theme, Symbol Preset, then the
		// boolean Color-Blind Mode row.
		comp.handleInput(DOWN);
		comp.handleInput(DOWN);
		comp.handleInput(DOWN);
		expect(Settings.instance.get("colorBlindMode")).toBe(false);

		// Right expands the description — it must NOT flip the value (left/right
		// are reserved for sidebar focus and description expand, never edits).
		comp.handleInput(RIGHT);
		expect(Settings.instance.get("colorBlindMode")).toBe(false);
		// Left collapses the description again, still no value change.
		comp.handleInput(LEFT);
		expect(Settings.instance.get("colorBlindMode")).toBe(false);
		// A second Left (nothing left to collapse) focuses the sidebar, again
		// without touching the value.
		comp.handleInput(LEFT);
		expect(Settings.instance.get("colorBlindMode")).toBe(false);
		expect(footerText(comp.render(160))).toContain("up/down category");
		// Return focus to the rows so activation lands on the boolean row.
		comp.handleInput(RIGHT);

		// Activation (Space) is the only thing that toggles the value.
		comp.handleInput(SPACE);
		expect(Settings.instance.get("colorBlindMode")).toBe(true);
		comp.handleInput(SPACE);
		expect(Settings.instance.get("colorBlindMode")).toBe(false);
	});

	it("clamps a wide multi-line status preview inside the pane", () => {
		const wide = `${"X".repeat(400)}\nline-two-${"Y".repeat(400)}`;
		const comp = createSelector(() => wide);
		const frame = comp.render(160);
		// No frame element may carry a raw newline (each row is one painted line)…
		for (const line of frame) expect(line.includes("\n")).toBe(false);
		// …and preview content never extends past the modal's right border.
		const border = frame.map(strip).find(line => line.includes("[x]"));
		const frameWidth = border ? border.trimEnd().length : 0;
		for (const line of frame.map(strip)) {
			if (!line.includes("X") && !line.includes("Y")) continue;
			expect(line.trimEnd().length).toBeLessThanOrEqual(frameWidth);
		}
	});
});
