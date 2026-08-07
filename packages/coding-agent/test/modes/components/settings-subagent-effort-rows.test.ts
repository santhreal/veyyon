/**
 * WHY THIS SUITE EXISTS (EFFORT-ROWS-NARROW-TO-THE-MODEL).
 *
 * `/effort` and `/thinking` ask the model which efforts it exposes, so a model that routes effort through
 * separate model ids correctly offers none. The Subagents tab printed a fixed ladder of every level Veyyon
 * knows, so `xhigh` was selectable there while the same session model rejected it everywhere else, and
 * picking it wrote a value the provider rejects.
 *
 * The narrowing itself is unit-tested against `configuredThinkingLevelOptions` in
 * `test/task/subagent-settings.test.ts`. This suite is the WIRING: the row declares `options: "runtime"`, which
 * means the def carries no options at all, so a selector that forgot to fill them would render an empty picker
 * and the unit test would still be green. Every case here drives the real component and reads the rows it
 * actually shows.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@veyyon/ai";
import { type GeneratedProvider, getBundledModel } from "@veyyon/catalog/models";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { configuredThinkingLevelsForModel } from "@veyyon/coding-agent/thinking";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

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

/** Open the Subagent Effort submenu with `model` as the session model, and return what it renders. */
function openSubagentEffort(model: Model<Api> | undefined): string {
	const component = new SettingsSelectorComponent(
		{
			model,
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: [],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	component.openTab("subagents");
	expect(component.selectSetting("subagent.thinkingLevel")).toBe(true);
	component.handleInput("\n");
	return stripVTControlCharacters(component.render(70).join("\n"));
}

function requireModel(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`the bundled catalog has no ${provider}/${id} to narrow against`);
	return model;
}

describe("the Subagent Effort row offers what the model exposes", () => {
	/**
	 * The reported case. A Cursor row that bakes the effort into the model id exposes no selectable effort, so
	 * the only honest row is Inherit — and the picker says why, because a one-row list with no explanation reads
	 * as a broken screen.
	 */
	it("offers Inherit alone, with a reason, for a model with no selectable effort", () => {
		const model = requireModel("cursor", "composer-1.5");
		expect(configuredThinkingLevelsForModel(model)).toEqual([]);

		const rendered = openSubagentEffort(model);
		expect(rendered).toContain("Inherit");
		expect(rendered).toContain("exposes no selectable effort");
		for (const absent of ["xhigh", "minimal"]) {
			expect(rendered, absent).not.toContain(absent);
		}
	});

	/**
	 * The other half: a model that DOES declare a ladder must get its own levels, not the fixed one. Without
	 * this the case above would also pass on a selector that renders nothing but Inherit for every model, which
	 * is the failure mode a narrowing change is most likely to introduce.
	 */
	it("offers exactly the levels a model declares", () => {
		const model = requireModel("anthropic", "claude-sonnet-4-6");
		const declared = configuredThinkingLevelsForModel(model);
		expect(declared.length).toBeGreaterThan(0);

		const rendered = openSubagentEffort(model);
		expect(rendered).toContain("Inherit");
		for (const level of declared) {
			expect(rendered, level).toContain(level);
		}
		expect(rendered).not.toContain("exposes no selectable effort");
	});

	/**
	 * No model in scope is the one case where the whole vocabulary is right: the caller cannot know which row the
	 * level will be clamped against, so narrowing would hide levels that are legal on the model actually used.
	 */
	it("offers the whole vocabulary when no model is in scope", () => {
		const rendered = openSubagentEffort(undefined);
		for (const level of ["minimal", "low", "medium", "high", "xhigh"]) {
			expect(rendered, level).toContain(level);
		}
	});
});
