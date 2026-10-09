/**
 * WHY: a record setting holds independent entries, and the store deep-merges its
 * layers entry by entry. `/settings` used to mark the whole row read-only as soon
 * as ANY entry came from a runtime override or a `--config` file, and dropped its
 * submenu, so Enter opened nothing. One role the app assigned at runtime made every
 * other role in Role Models unreachable.
 *
 * Class closed: every record-typed row the settings screen draws, enumerated from
 * the schema at run time, opens its editor under an override from either layer.
 * Inside it, the overridden entry reads its source and does not act, a sibling
 * entry still edits, and the write lands in the profile without copying the
 * override's entry into it. A record setting added to the screen without a
 * scenario here fails the coverage case until one is written.
 *
 * Not covered: a record whose override supplies only part of one entry (a nested
 * key inside an agent row). Entries are sourced by their top-level key, so such an
 * entry reads as overridden in full.
 * A scalar row under an override stays read-only; `settings-source-ownership.test.ts`
 * pins that.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import type { SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { isRecordSetting } from "@veyyon/coding-agent/modes/terminal/components/selectors/setting-source";
import { getAllSettingDefs } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-selector";
import { discoverAgents } from "@veyyon/coding-agent/task/discovery";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { SettingTab } from "@veyyon/settings";
import * as YAML from "yaml";
import { stubStdoutGeometry } from "../../../helpers/stdout-geometry";
import { useTrackedTempDirs } from "../../../helpers/tracked-temp-dir";

const ENTER = "\n";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const DELETE = "\x1b[3~";
const BACKSPACE = "\x7f";
const WIDTH = 220;

const makeTempDir = useTrackedTempDirs("veyyon-record-override-");

const model: Model = buildModel({
	id: "reasoning-model",
	name: "Reasoning model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
});

const modelRegistry = {
	isKeylessProvider: () => false,
	hasConfiguredAuth: () => true,
	authStorage: { hasAuth: () => true, getAll: () => ({}) },
} as unknown as ModelRegistry;

type OverrideLayer = "runtime" | "config-file";

const LAYERS: ReadonlyArray<{ layer: OverrideLayer; label: string }> = [
	{ layer: "runtime", label: "runtime override" },
	{ layer: "config-file", label: "--config file" },
];

interface Opened {
	component: SettingsSelectorComponent;
	changes: SettingPath[];
}

interface Scenario {
	/** The overriding layer's record: exactly one entry. */
	override: Record<string, unknown>;
	/** The profile's own record, with a different entry. */
	profile: Record<string, unknown>;
	/** Providers the selector context lists. */
	providers?: string[];
	/** Drive the open editor. `label` is the overriding layer's display label. */
	exercise(opened: Opened, label: string, setting: SettingPath): Promise<void>;
}

let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	resetSettingsForTest();
	geometryStub = stubStdoutGeometry({ columns: WIDTH, rows: 80 });
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
	resetSettingsForTest();
});

function nest(setting: string, value: unknown): Record<string, unknown> {
	const segments = setting.split(".");
	let nested: unknown = value;
	for (let index = segments.length - 1; index >= 0; index--) nested = { [segments[index]!]: nested };
	return nested as Record<string, unknown>;
}

async function initSettings(setting: SettingPath, layer: OverrideLayer, scenario: Scenario): Promise<string> {
	const root = makeTempDir();
	const agentDir = path.join(root, "profile");
	const cwd = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(nest(setting, scenario.profile)));
	if (layer === "runtime") {
		await Settings.init({ agentDir, cwd, overrides: { [setting]: scenario.override } });
	} else {
		const overlay = path.join(root, "overlay.yml");
		fs.writeFileSync(overlay, YAML.stringify(nest(setting, scenario.override)));
		await Settings.init({ agentDir, cwd, configFiles: [overlay] });
	}
	return cwd;
}

function frameOf(component: SettingsSelectorComponent): string {
	return component
		.render(WIDTH)
		.map(line => stripVTControlCharacters(line))
		.join("\n");
}

function lineWith(component: SettingsSelectorComponent, needle: string): string {
	const line = frameOf(component)
		.split("\n")
		.find(candidate => candidate.includes(needle));
	expect(line).toBeDefined();
	return line!;
}

/** A submenu is open when the footer offers the sub-pane's "esc back" chip. */
function submenuIsOpen(component: SettingsSelectorComponent): boolean {
	return frameOf(component).includes("esc back");
}

async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !condition(); attempt++) await delay(10);
	expect(condition()).toBe(true);
}

function profileRecord(setting: SettingPath): unknown {
	return settings.layerValue("profile", setting.split("."));
}

function openRow(setting: SettingPath, tab: SettingTab, cwd: string, providers: string[]): Opened {
	const changes: SettingPath[] = [];
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers,
			cwd,
			modelRegistry,
			availableModels: [model],
		},
		{ onChange: changed => changes.push(changed), onCancel: () => {} },
	);
	component.openTab(tab);
	expect(component.selectSetting(setting)).toBe(true);
	expect(submenuIsOpen(component)).toBe(false);
	component.handleInput(ENTER);
	return { component, changes };
}

/** A text-edited record opens on the profile's record and names the overridden entry. */
function textRecord(overrideValue: unknown, profileValue: unknown): Scenario {
	return {
		override: { probe: overrideValue },
		profile: { kept: profileValue },
		async exercise({ component }, label, setting) {
			const frame = frameOf(component);
			expect(frame).toContain('"kept"');
			expect(frame).not.toContain('"probe"');
			expect(frame).toContain(`Set by ${label}: probe.`);

			component.handleInput(ENTER);
			await Settings.instance.flush();
			expect(profileRecord(setting)).toEqual({ kept: profileValue });
			expect(settings.get(setting)).toEqual({ kept: profileValue, probe: overrideValue });
		},
	};
}

/** One scenario per record-typed row, built fresh for each case. */
const SCENARIOS: Record<string, () => Scenario | Promise<Scenario>> = {
	modelRoles: () => ({
		override: { smol: "test/reasoning-model" },
		profile: {},
		async exercise({ component }, label) {
			expect(lineWith(component, "Fast")).toContain(`${label} · read-only`);
			expect(lineWith(component, "Thinking")).not.toContain("read-only");

			// The overridden role is the first row: Enter on it opens no picker.
			component.handleInput(ENTER);
			expect(frameOf(component)).not.toContain("Fast model");
			// A sibling role still opens its picker.
			component.handleInput(DOWN);
			component.handleInput(ENTER);
			expect(frameOf(component)).toContain("Thinking model");
		},
	}),
	defaultEffort: () => ({
		override: { "test/reasoning-model": "high" },
		profile: { "*": "low" },
		async exercise({ component }, label, setting) {
			expect(lineWith(component, "test/reasoning-model")).toContain(`high · ${label} · read-only`);
			expect(lineWith(component, "any model")).not.toContain("read-only");

			// Rows sort `*` first; the overridden model row is second.
			component.handleInput(DOWN);
			component.handleInput(ENTER);
			expect(frameOf(component)).toContain("Add a model");
			component.handleInput(DELETE);
			expect(settings.get(setting)).toEqual({ "*": "low", "test/reasoning-model": "high" });

			// Removing the profile's own row writes the profile without the override's row.
			component.handleInput(UP);
			component.handleInput(DELETE);
			await Settings.instance.flush();
			expect(profileRecord(setting)).toEqual({});
			expect(settings.get(setting)).toEqual({ "test/reasoning-model": "high" });
		},
	}),
	"providers.maxInFlightRequests": () => ({
		providers: ["alpha", "beta"],
		override: { alpha: 2 },
		profile: { beta: 3 },
		async exercise({ component }, label, setting) {
			expect(lineWith(component, "alpha")).toContain(`Limit: 2 · ${label} · read-only`);
			expect(lineWith(component, "beta")).not.toContain("read-only");

			component.handleInput(ENTER);
			expect(frameOf(component)).not.toContain("Max In-Flight Requests: alpha");
			component.handleInput(DOWN);
			component.handleInput(ENTER);
			expect(frameOf(component)).toContain("Max In-Flight Requests: beta");
			component.handleInput(BACKSPACE);
			component.handleInput("5");
			component.handleInput(ENTER);
			await Settings.instance.flush();
			expect(profileRecord(setting)).toEqual({ beta: 5 });
			expect(settings.get(setting)).toEqual({ alpha: 2, beta: 5 });
		},
	}),
	"agent.agents": agentScenario,
	"retry.fallbackChains": () => textRecord(["test/other-model"], ["test/reasoning-model"]),
	"retry.perProvider": () => textRecord({ maxRetries: 1 }, { maxRetries: 2 }),
	"tools.approval": () => textRecord("deny", "allow"),
};

const RECORD_DEFS = getAllSettingDefs().filter(def => isRecordSetting(def.path));

/** The row of one agent in the roster: its name, then its state and model. */
function agentRow(component: SettingsSelectorComponent, name: string): string | undefined {
	const row = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b.*·`);
	return frameOf(component)
		.split("\n")
		.find(line => row.test(line));
}

/** The first two discovered agents: the first overridden, the second left to the profile. */
async function agentScenario(): Promise<Scenario> {
	const { agents } = await discoverAgents(makeTempDir());
	const [overridden, free] = agents.map(agent => agent.name).sort((a, b) => a.localeCompare(b));
	expect(overridden).toBeDefined();
	expect(free).toBeDefined();
	return {
		override: { [overridden!]: { enabled: false } },
		profile: { [free!]: { thinkingLevel: "low" } },
		async exercise({ component, changes }, label, setting) {
			await until(() => agentRow(component, free!) !== undefined);
			expect(agentRow(component, overridden!)).toContain(`${label} · read-only`);
			expect(agentRow(component, free!)).not.toContain("read-only");

			component.handleInput(ENTER);
			expect(frameOf(component)).not.toContain(`Agent: ${overridden!}`);
			component.handleInput(DOWN);
			component.handleInput(ENTER);
			expect(frameOf(component)).toContain(`Agent: ${free!}`);
			// The Enabled row is first: toggling it writes this agent's lane.
			component.handleInput(ENTER);
			await Settings.instance.flush();
			expect(changes).toContain(setting);
			const written = (profileRecord(setting) ?? {}) as Record<string, unknown>;
			expect(Object.keys(written)).not.toContain(overridden!);
			expect(Object.keys(settings.get(setting) as Record<string, unknown>)).toContain(overridden!);
		},
	};
}

describe("a record setting with one overridden entry", () => {
	it("has a scenario for every record-typed row the settings screen draws", () => {
		expect(RECORD_DEFS.map(def => def.path as string).sort()).toEqual(Object.keys(SCENARIOS).sort());
	});

	for (const def of RECORD_DEFS) {
		for (const { layer, label } of LAYERS) {
			it(`${def.path} opens under a ${label} and edits only the profile's entries`, async () => {
				const scenario = await SCENARIOS[def.path]!();
				const cwd = await initSettings(def.path, layer, scenario);
				expect(settings.getSource(def.path)).toBe(layer);

				const opened = openRow(def.path, def.tab, cwd, scenario.providers ?? []);
				expect(submenuIsOpen(opened.component)).toBe(true);
				await scenario.exercise(opened, label, def.path);
			});
		}
	}
});
