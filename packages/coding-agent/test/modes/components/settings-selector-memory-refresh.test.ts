import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

function strip(s: string): string {
	return stripVTControlCharacters(s);
}

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const rows = 40;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(onCancel: () => void = () => {}): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default", "friendly", "pragmatic"],
			providers: [],
			cwd: process.cwd(),
		},
		{
			onChange: () => {},
			onCancel,
		},
	);
}

/** Jump to Memory Backend on the Memory tab. */
function focusMemoryBackend(comp: SettingsSelectorComponent): void {
	comp.openTab("memory");
	expect(comp.selectSetting("memory.backend")).toBe(true);
}

describe("SettingsSelectorComponent memory tab", () => {
	it("reveals condition-gated Hindsight rows the moment memory.backend changes via the submenu", () => {
		settings.set("memory.backend", "off");
		const comp = createSelector();
		focusMemoryBackend(comp);
		// Width 70 keeps the flat single-column layout (the wide split layout
		// shows only the active section's rows, covered by the sidebar test).
		const before = comp.render(70).join("\n");
		expect(before).toContain("Memory Backend");
		expect(before).not.toContain("Hindsight API URL");

		// Memory Backend is the only visible row, so it's already selected at index 0.
		// Enter opens the SelectSubmenu pre-positioned on "off"; navigate to "hindsight" (index 2) and confirm.
		comp.handleInput("\n");
		comp.handleInput("\x1b[B");
		comp.handleInput("\x1b[B");
		comp.handleInput("\n");

		expect(settings.get("memory.backend")).toBe("hindsight");
		const after = comp.render(70).join("\n");
		expect(after).toContain("Memory Backend");
		expect(after).toContain("Hindsight API URL");
		expect(after).toContain("Hindsight Auto Recall");
	});

	it("hides Hindsight rows again when the backend is switched back to off without leaving the tab", () => {
		settings.set("memory.backend", "hindsight");
		const comp = createSelector();
		focusMemoryBackend(comp);
		// Width 70 keeps the flat layout so all sections' rows render inline.
		expect(comp.render(70).join("\n")).toContain("Hindsight API URL");

		// Open Memory Backend → SelectSubmenu pre-selects the current value
		// ("hindsight" at index 2) → step up twice to reach "off" → Enter confirms.
		comp.handleInput("\n");
		comp.handleInput("\x1b[A");
		comp.handleInput("\x1b[A");
		comp.handleInput("\n");

		expect(settings.get("memory.backend")).toBe("off");
		const after = comp.render(70).join("\n");
		expect(after).toContain("Memory Backend");
		expect(after).not.toContain("Hindsight API URL");
		expect(after).not.toContain("Hindsight Auto Recall");
	});

	it("clears the global settings search on Escape before closing the selector", () => {
		let cancelCount = 0;
		const comp = createSelector(() => {
			cancelCount++;
		});

		// Typing starts the cross-tab search: banner shows the query and matches.
		comp.handleInput("b");
		const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
		const searching = comp.render(120).map(strip).join("\n");
		const banner =
			comp
				.render(120)
				.map(strip)
				.find(line => /\d+ match/.test(line)) ?? "";
		expect(banner).toContain(" b ");
		expect(searching).toMatch(/\d+ match/);

		// First Escape exits search mode without closing the panel.
		comp.handleInput("\x1b");
		expect(cancelCount).toBe(0);
		expect(comp.render(120).join("\n")).not.toContain("matches");

		comp.handleInput("\x1b");
		expect(cancelCount).toBe(1);
	});

	it("puts the exact global settings search hit before incidental matches", () => {
		const comp = createSelector();
		for (const ch of "image provider") comp.handleInput(ch);

		const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
		const rendered = comp.render(120).map(strip).join("\n");
		const providersIndex = rendered.indexOf("Providers");
		const appearanceIndex = rendered.indexOf("Appearance");

		expect(rendered).toContain("Image Provider");
		expect(rendered).not.toContain("Include Model in Prompt");
		expect(rendered).not.toContain("Service Tier");
		expect(providersIndex).toBeGreaterThanOrEqual(0);
		if (appearanceIndex >= 0) {
			expect(appearanceIndex).toBeGreaterThan(providersIndex);
		}
	});

	it("supports editor hotkeys in the global search bar", () => {
		const comp = createSelector();
		const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
		const banner = (): string =>
			comp
				.render(120)
				.map(strip)
				.find(line => /\d+ match/.test(line)) ?? "";

		// alt+backspace deletes the trailing word from the query.
		for (const ch of "image provider") comp.handleInput(ch);
		comp.handleInput("\x1b\x7f");
		expect(banner()).toContain("image");
		expect(banner()).not.toContain("provider");

		// Arrow keys move the cursor; typing inserts mid-query instead of appending.
		comp.handleInput("\x15"); // ctrl+u clears the rest of the query
		for (const ch of "model") comp.handleInput(ch);
		for (let i = 0; i < 5; i++) comp.handleInput("\x1b[D");
		comp.handleInput("x");
		expect(banner()).toContain("xmodel");
	});

	it("delegates Escape to an open settings submenu before closing the selector", () => {
		let cancelCount = 0;
		settings.set("memory.backend", "off");
		const comp = createSelector(() => {
			cancelCount++;
		});
		focusMemoryBackend(comp);

		comp.handleInput("\n");
		const openSub = strip(comp.render(120).join("\n"));
		expect(openSub).toMatch(/esc/i);
		expect(openSub).toMatch(/back/i);

		comp.handleInput("\x1b");
		const afterBack = strip(comp.render(120).join("\n"));
		expect(cancelCount).toBe(0);
		expect(afterBack).toContain("Memory Backend");
		expect(afterBack.toLowerCase()).toContain("esc close");
		expect(afterBack.toLowerCase()).not.toContain("esc back");

		comp.handleInput("\x1b");
		expect(cancelCount).toBe(1);
	});
});
