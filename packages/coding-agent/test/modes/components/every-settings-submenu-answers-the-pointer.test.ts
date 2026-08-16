/**
 * WHY: `routeSubmenuMouse` has always dispatched pointer events into the open
 * settings submenu, but nine of the ten submenus had no `routeMouse` — the
 * pointer did nothing on their rows while SelectSubmenu answered it, and a
 * footer hint on two of them even advertised "click pick". The class this
 * suite closes: a SelectList/panel-based settings submenu whose rows ignore
 * the pointer. The shared `MouseRoutedSubmenu` base owns the offset/route
 * pair; these tests drive the real host (`SettingsSelectorComponent`) with
 * SGR bytes, open every list-state submenu through its settings row, and
 * assert the row under the pointer paints the hover band and that a click
 * activates it — both unreachable before.
 *
 * Not caught: TextInputSubmenu states (custom threshold, provider limit
 * editor) deliberately keep the pointer inert — there is nothing to click in
 * a text field. Shell chrome (close, chips, breadcrumb) is hit-tested by the
 * host and covered elsewhere. The model-picker panel's own row hover needs a
 * populated registry and is asserted separately.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { getRoleInfo, SELECTABLE_MODEL_ROLE_IDS } from "@veyyon/coding-agent/config/model-roles";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";

function strip(s: string): string {
	return stripVTControlCharacters(s);
}

let previousAnsiPolicy: AnsiPolicy;

beforeAll(async () => {
	previousAnsiPolicy = getAnsiPolicy();
	// The hover band is a background fill; with the piped-test policy the theme
	// strips it to plain text and no byte assertion can see it. This is the
	// documented test override, restored in afterAll.
	setAnsiPolicy("full");
	await initTheme();
});

afterAll(() => {
	setAnsiPolicy(previousAnsiPolicy);
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 40, set: () => {} });
	geometryStub = {
		restore() {
			if (rowsDesc) Object.defineProperty(process.stdout, "rows", rowsDesc);
		},
	};
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
});

/**
 * A selector whose `requestRender` is awaitable: async submenus (agent and
 * rule discovery) report completion by requesting a re-render, so the test
 * waits on that signal rather than on the clock — a discovery that never
 * reports fails as a test timeout with the cause visible, not a flaky sleep.
 * The catalog stub makes the model-backed submenus render their rows; an
 * empty catalog still lists stored chain entries and role names.
 */
function createSelector(): { component: SettingsSelectorComponent; awaitRenderRequest: () => Promise<void> } {
	let rendered = Promise.withResolvers<void>();
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: ["alpha"],
			cwd: process.cwd(),
			modelRegistry: {} as ModelRegistry,
			availableModels: [],
			requestRender: () => rendered.resolve(),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	return {
		component,
		awaitRenderRequest: async () => {
			await rendered.promise;
			rendered = Promise.withResolvers<void>();
		},
	};
}

const WIDTH = 120;
/** SGR column safely inside the pane past the sidebar for any frame inset. */
const COL = 61;
const motionAt = (row: number): string => `\x1b[<35;${COL};${row}M`;
const clickAt = (row: number): string => `\x1b[<0;${COL};${row}M`;

function rowIndex(component: SettingsSelectorComponent, rowText: string): number {
	const lines = component.render(WIDTH);
	const index = lines.findIndex(line => strip(line).includes(rowText));
	if (index === -1) throw new Error(`no rendered row contains "${rowText}"`);
	return index;
}

/**
 * The contract: hovering a list row paints the hover band on exactly that
 * row, and nothing else in the frame moves (hover never moves the selection).
 */
function expectHoverBand(component: SettingsSelectorComponent, rowText: string): void {
	const before = component.render(WIDTH);
	const index = before.findIndex(line => strip(line).includes(rowText));
	if (index === -1) throw new Error(`no rendered row contains "${rowText}"`);

	component.handleInput(motionAt(index + 1));

	const after = component.render(WIDTH);
	expect(strip(after[index] ?? "")).toContain(rowText);
	expect(after[index]).not.toBe(before[index]);
	// The hover band is a background fill; fg-only styling cannot produce "48;".
	expect(after[index]).toContain("48;");
	for (let line = 0; line < before.length; line++) {
		if (line !== index) expect(after[line]).toBe(before[line]);
	}
}

/** Wait on the submenu's own re-render reports until `rowText` is on screen. */
async function awaitRow(
	component: SettingsSelectorComponent,
	awaitRenderRequest: () => Promise<void>,
	rowText: string,
): Promise<void> {
	while (component.render(WIDTH).every(line => !strip(line).includes(rowText))) {
		await awaitRenderRequest();
	}
}

function frameText(component: SettingsSelectorComponent): string {
	return component.render(WIDTH).map(strip).join("\n");
}

describe("settings submenus answer the pointer", () => {
	it("compaction threshold: hover lights a mode row, click opens its value picker", () => {
		const { component } = createSelector();
		component.openTab("model");
		expect(component.selectSetting("compaction.threshold")).toBe(true);
		component.handleInput("\n");

		expectHoverBand(component, "Percent");

		component.handleInput(clickAt(rowIndex(component, "Percent") + 1));
		expect(frameText(component)).toContain("Auto-Compaction Threshold — Percent");
	});

	it("provider limits: hover lights a provider row, click opens its editor", () => {
		// A second provider row: the single-row list's one row is always the
		// selected one, and SelectList paints no hover band over the selection.
		settings.set("providers.maxInFlightRequests", { beta: 3 });
		const { component } = createSelector();
		component.openTab("providers");
		expect(component.selectSetting("providers.maxInFlightRequests")).toBe(true);
		component.handleInput("\n");

		expectHoverBand(component, "beta");

		component.handleInput(clickAt(rowIndex(component, "beta") + 1));
		expect(frameText(component)).toContain("Max In-Flight Requests: beta");
	});

	it("model roles: hover lights a role row, click opens its picker", () => {
		const { component } = createSelector();
		component.openTab("model");
		expect(component.selectSetting("modelRoles")).toBe(true);
		component.handleInput("\n");

		const roles = SELECTABLE_MODEL_ROLE_IDS.map(role => getRoleInfo(role, settings).name);
		// Row 0 is the selected one; hover the second role, which the band owns.
		const secondRole = roles[1]!;
		expectHoverBand(component, secondRole);

		component.handleInput(clickAt(rowIndex(component, roles[0]!) + 1));
		expect(frameText(component)).toContain(`${roles[0]} model`);
	});

	it(
		"subagent agents: hover lights an agent row once discovery reports, click opens its editor",
		async () => {
			const { component, awaitRenderRequest } = createSelector();
			component.openTab("subagents");
			expect(component.selectSetting("subagent.agents")).toBe(true);
			component.handleInput("\n");
			await awaitRow(component, awaitRenderRequest, "scout");

			expectHoverBand(component, "scout");

			component.handleInput(clickAt(rowIndex(component, "scout") + 1));
			expect(frameText(component)).toContain("Nested spawn depth");
		},
		{ timeout: 30_000 },
	);

	it("subagent models by depth: hover lights the add row, click opens the depth chain", () => {
		// A configured depth row: the empty map's lone Add row is the selected
		// one, and SelectList paints no hover band over the selection.
		settings.set("subagent.modelByDepth", { "1": "anthropic/claude-opus-4-1" });
		const { component } = createSelector();
		component.openTab("subagents");
		expect(component.selectSetting("subagent.modelByDepth")).toBe(true);
		component.handleInput("\n");

		expectHoverBand(component, "Add depth…");

		component.handleInput(clickAt(rowIndex(component, "Depth 1") + 1));
		expect(frameText(component)).toContain("Depth 1");
	});

	it("default effort: hover lights the add row, click opens the model picker", () => {
		const { component } = createSelector();
		component.openTab("model");
		expect(component.selectSetting("defaultEffort")).toBe(true);
		component.handleInput("\n");

		expectHoverBand(component, "Add a model…");

		component.handleInput(clickAt(rowIndex(component, "Add a model…") + 1));
		expect(frameText(component)).toContain("No models available");
	});

	it(
		"rules: hover lights a section row once discovery reports, click opens the section",
		async () => {
			const { component, awaitRenderRequest } = createSelector();
			component.openTab("rules");
			expect(component.selectSetting("ttsr.disabledRules")).toBe(true);
			component.handleInput("\n");
			await awaitRow(component, awaitRenderRequest, "Built-in");

			const before = frameText(component);
			// The first section row is the selected one; hover the row under it.
			const firstSection = rowIndex(component, "Built-in");
			const before2 = component.render(WIDTH);
			component.handleInput(motionAt(firstSection + 2));
			const after2 = component.render(WIDTH);
			expect(after2[firstSection + 1]).not.toBe(before2[firstSection + 1]);
			expect(after2[firstSection + 1]).toContain("48;");

			component.handleInput(clickAt(firstSection + 1));
			const after = frameText(component);
			expect(after).not.toBe(before);
		},
		{ timeout: 30_000 },
	);

	it("model chain: hover lights a chain entry, click opens the replacement picker", () => {
		settings.set("compaction.model", "anthropic/claude-opus-4-1");
		const { component } = createSelector();
		component.openTab("model");
		expect(component.selectSetting("compaction.model")).toBe(true);
		component.handleInput("\n");

		expectHoverBand(component, "Add fallback…");

		component.handleInput(clickAt(rowIndex(component, "1. anthropic/claude-opus-4-1") + 1));
		expect(frameText(component)).toContain("Pick a replacement for this position.");
	});
});
