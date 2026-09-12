import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { buildModel } from "@veyyon/catalog/build";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { ModelSelectorPanel } from "@veyyon/coding-agent/modes/terminal/components/selectors/model-selector";
import {
	ModelChainSubmenu,
	SettingsSelectorComponent,
} from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-selector";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { TERMINAL } from "@veyyon/tui";
import { parseSgrMouse } from "@veyyon/utils/mouse";
import { stubStdoutGeometry } from "../../../helpers/stdout-geometry";

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
	geometryStub = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

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

	it("renders fallback message and returns on Escape when model catalog is unavailable", () => {
		const comp = createSelector();
		comp.openTab("model");
		expect(comp.selectSetting("compaction.model")).toBe(true);
		comp.handleInput("\n");
		const rendered = strip(comp.render(120).join("\n"));
		expect(rendered).toContain("Model catalog unavailable");
		expect(rendered).toContain("Esc to go back");

		comp.handleInput("\x1b");
		const after = strip(comp.render(120).join("\n"));
		expect(after).not.toContain("Model catalog unavailable");
		expect(after).toContain("Compaction Model");
	});

	it("formats model roles value correctly when unassigned or assigned", () => {
		const comp = createSelector();
		expect(comp.formatModelRolesValue()).toBe("all inherit");
		settings.setModelRole("smol", "anthropic/claude-3-5-haiku");
		expect(comp.formatModelRolesValue()).toBe("1 assigned");
	});

	it("formats rules value correctly for built-in, disabled, and experimental rules", () => {
		const comp = createSelector();
		settings.set("ttsr.builtinRules", true);
		expect(comp.formatRulesValue()).toBe("all on");
		settings.set("ttsr.disabledRules", ["rule1", "rule2"]);
		expect(comp.formatRulesValue()).toBe("2 off");
		settings.set("ttsr.experimentalRules", ["exp1"]);
		expect(comp.formatRulesValue()).toBe("2 off, 1 experimental on");
		settings.set("ttsr.builtinRules", false);
		expect(comp.formatRulesValue()).toBe("built-ins off, 2 more off, 1 experimental on");
	});

	it("redraws model picker on mouse hover with dynamic submenu receiver binding", () => {
		const terminalCaps = TERMINAL as unknown as { trueColor: boolean };
		const originalTrueColor = terminalCaps.trueColor;
		terminalCaps.trueColor = true;
		const model = buildModel({
			id: "claude-3-5-sonnet",
			provider: "anthropic",
			name: "Claude 3.5 Sonnet",
			api: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200000,
			maxTokens: 8192,
		});
		const models = [model];
		const registry = {
			getAllModels: () => models,
			findModel: () => model,
			isKeylessProvider: () => false,
			hasConfiguredAuth: () => true,
			authStorage: { hasAuth: () => true },
		} as unknown as ModelRegistry;
		let initialCalls = 0;
		let replacedCalls = 0;
		let lastReceiver: unknown;
		const submenu = new ModelChainSubmenu(
			"compaction.model",
			registry,
			models,
			"Compaction Model",
			["anthropic/claude-3-5-sonnet"],
			() => {},
			() => {},
			function (this: ModelChainSubmenu) {
				lastReceiver = this;
				initialCalls++;
			},
		);

		try {
			submenu.handleInput("\n");
			const panel = submenu.children.find((c): c is ModelSelectorPanel => c instanceof ModelSelectorPanel);
			expect(panel).toBeDefined();

			submenu.render(80);

			submenu.requestRender = function (this: ModelChainSubmenu) {
				lastReceiver = this;
				replacedCalls++;
			};

			const hoverEvent = parseSgrMouse("\x1b[<35;6;7M");
			if (!hoverEvent) throw new Error("Expected a decoded hover event");

			expect(initialCalls).toBe(1);
			expect(replacedCalls).toBe(0);

			panel?.routeMouse(hoverEvent, 6);

			expect(initialCalls).toBe(1);
			expect(replacedCalls).toBe(1);
			expect(lastReceiver).toBe(submenu);
		} finally {
			submenu.clear();
			terminalCaps.trueColor = originalTrueColor;
		}
	});
});
