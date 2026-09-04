import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

function createSelector(
	overrides: {
		getStatusLinePreview?: (width?: number) => string;
		onCancel?: () => void;
		requestRender?: () => void;
	} = {},
): SettingsSelectorComponent {
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["titanium"],
			availablePersonalities: ["default"],
			providers: [],
			cwd: process.cwd(),
			requestRender: overrides.requestRender,
		},
		{
			onChange: () => {},
			onCancel: overrides.onCancel ?? (() => {}),
			getStatusLinePreview: overrides.getStatusLinePreview,
		},
	);
	component.render(131);
	return component;
}

function strippedFrame(component: SettingsSelectorComponent, width: number): string[] {
	return component.render(width).map(stripVTControlCharacters);
}

describe("subagent roster and unset settings visibility contracts", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});
	it("renders (unset) for empty text settings in the settings list", () => {
		// Ensure an optional text/array setting is empty/unset
		settings.unset("tools.essentialOverride");
		const component = createSelector();
		component.handleInput("essential tools override");

		const frame = strippedFrame(component, 131);
		const row = frame.find(line => line.includes("Essential Tools Override"));
		expect(row).toBeDefined();
		expect(row).toContain("(unset)");
	});

	it("passes paneWidth to getStatusLinePreview without artificial ellipsis", () => {
		let capturedWidth: number | undefined;
		const component = createSelector({
			getStatusLinePreview: width => {
				capturedWidth = width;
				return "location-line\ncapability-line";
			},
		});

		const frame = strippedFrame(component, 131);
		expect(capturedWidth).toBeDefined();
		expect(capturedWidth).toBeGreaterThan(30);
		expect(capturedWidth).toBeLessThan(131);

		const previewLine = frame.find(line => line.includes("capability-line"));
		expect(previewLine).toBeDefined();
		expect(previewLine).not.toContain("…");
	});

	it("renders navigation footer and custom agent hint in subagent roster without clipping", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const component = createSelector({
			requestRender: () => resolve(),
		});

		// Type search query to filter for Roster
		component.handleInput("Roster");
		component.render(131);

		// Activate the Roster row with Return
		component.handleInput("\r");
		component.render(131);

		// Wait deterministically for discoverAgents async loading to trigger requestRender
		await promise;

		const frame = strippedFrame(component, 131);

		// Both CUSTOM_AGENT_HINT and SelectList navigation controls must be present in the frame
		const hintLine = frame.find(line => line.includes("~/.veyyon/subagents/"));
		const listHintLine = frame.find(line => line.includes("select") && line.includes("close"));

		expect(hintLine).toBeDefined();
		expect(listHintLine).toBeDefined();
	});
});
