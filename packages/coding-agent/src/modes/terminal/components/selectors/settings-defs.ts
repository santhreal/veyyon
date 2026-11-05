/**
 * UI adapter over the schema. Reads `ui.options` declared inline in
 * settings-schema.ts and produces typed widget definitions for the
 * settings selector.
 *
 * Settings surface is intentionally lean: see TAB_GROUPS in settings-schema.ts
 * for which tabs/groups remain visible vs schema-only (no `ui` block).
 */

import type { AnyUiMetadata, SettingTab, SubmenuOption } from "@veyyon/settings";
import { TERMINAL } from "@veyyon/tui";
import { resolveEffort, withLegacyDefaultEffort } from "../../../../config/effort-resolver";
import { Settings } from "../../../../config/settings";
import {
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	type SettingValue as SchemaSettingValue,
	SETTING_TABS,
	type SettingPath,
	TAB_GROUPS,
} from "../../../../config/settings-schema";
import { AUTO_THINKING } from "../../../../thinking";

// ═══════════════════════════════════════════════════════════════════════════
// UI Definition Types
// ═══════════════════════════════════════════════════════════════════════════

export type SettingValue = boolean | string;

interface BaseSettingDef {
	path: SettingPath;
	label: string;
	description: string;
	tab: SettingTab;
	/** Section within the tab; items are ordered by TAB_GROUPS[tab] and rendered under a heading row. */
	group?: string;
	/**
	 * Optional visibility predicate. When supplied and returning false, the
	 * setting is hidden from the UI. Applies to every variant — booleans,
	 * enums, submenus, and text inputs.
	 */
	condition?: () => boolean;
	/** When true, the setting renders inside the tab's collapsed "Advanced" fold instead of its normal group. */
	advanced?: boolean;
	/** Search synonyms declared on the schema entry; see UiBase.keywords. */
	keywords?: readonly string[];
}

export interface BooleanSettingDef extends BaseSettingDef {
	type: "boolean";
}

export interface EnumSettingDef extends BaseSettingDef {
	type: "enum";
	values: readonly string[];
}

/** The choices a submenu setting offers. Exported so the selector's runtime
 *  option owner (`#submenuOptions`) returns the same shape the defs declare. */
export type OptionList = ReadonlyArray<SubmenuOption>;

export interface SubmenuSettingDef extends BaseSettingDef {
	type: "submenu";
	options: OptionList;
	onPreview?: (value: string) => void;
	onPreviewCancel?: (originalValue: string) => void;
}

/**
 * The `compaction.threshold` drill-down: three modes (Auto / Percent / Tokens)
 * on the first level, the mode's preset values plus a Custom entry on the
 * second. A dedicated type rather than the flat submenu because the stored
 * string mixes three semantics (`auto`, `85%`, `200000`) and one 19-row list
 * hid that structure; the schema options stay the single source of presets and
 * are partitioned by unit at render time.
 */
export interface CompactionThresholdSettingDef extends BaseSettingDef {
	type: "compactionThreshold";
	options: OptionList;
}

export interface TextInputSettingDef extends BaseSettingDef {
	type: "text";
}

export interface ProviderLimitsSettingDef extends BaseSettingDef {
	type: "providerLimits";
}

/** Searchable model picker (auth badges). Used for agent/compaction model slots. */
export interface ModelSelectorSettingDef extends BaseSettingDef {
	type: "modelSelector";
}

/**
 * The `agent.agents` table: one row per discovered agent, each carrying
 * whether it is offered, its model, and its effort.
 *
 * A dedicated type rather than the generic record-as-text control because the
 * keys are not free-form — they are the agents this project actually has, and an
 * operator editing JSON by hand cannot see which names exist or what a blank
 * model resolves to. The editor reads `task/agent-settings.ts` for both, so
 * the settings tab and `/agents` cannot disagree about precedence.
 */
export interface AgentsSettingDef extends BaseSettingDef {
	type: "agents";
}

/**
 * The profile's default effort per model: rows of `provider/id` (or `*` for any
 * model) to an effort, edited as a list. The one persisted effort surface, so a
 * second row writing the same axis cannot reappear.
 */
export interface DefaultEffortSettingDef extends BaseSettingDef {
	type: "defaultEffort";
}

/**
 * `agent.thinkingLevel`: the effort every agent runs at while the roster is
 * on shared scope.
 *
 * A dedicated type rather than the generic text control because the levels a
 * model accepts are not free-form, and a stored level no endpoint declares is
 * clamped away at dispatch and reads as the picker having done nothing. The
 * ladder narrows against `agent.model`, which is the model those agents
 * actually run, so the row and the spawn cannot disagree.
 */
export interface AgentSharedEffortSettingDef extends BaseSettingDef {
	type: "agentSharedEffort";
}

/**
 * The profile's DEFAULT model: the model each new session starts on, stored in
 * `defaultModel`. The schema key has no `ui` block because this row is drawn by
 * its own picker: one model, no effort step, and a clear row that restores
 * auto-select on launch. It edits the profile value; a `--model` override is
 * shown beside it and never written back.
 */
export interface DefaultModelSettingDef extends BaseSettingDef {
	type: "defaultModel";
}

/**
 * The rule list: every discovered rule, each on or off.
 *
 * Backed by `ttsr.disabledRules`, which stores only the exceptions. That inversion is
 * the point — a rule is on unless its name is listed, so a bundled rule added in a later
 * release arrives on rather than waiting for every existing config to opt in. The row
 * used to render as a text box holding a comma-separated list of names, which required
 * knowing a rule's exact name before you could turn it off and offered no way to find
 * out what the names were.
 */
export interface RulesSettingDef extends BaseSettingDef {
	type: "rules";
}

/**
 * Files → LSP. One row you enter; the nested page is every `lsp.*` boolean.
 * The schema keys stay independent so config, the agent tool, and injection
 * can disagree. The screen is what used to dump them as sibling Files rows.
 */
export interface LspSettingDef extends BaseSettingDef {
	type: "lsp";
}

export type SettingDef =
	| BooleanSettingDef
	| EnumSettingDef
	| SubmenuSettingDef
	| CompactionThresholdSettingDef
	| TextInputSettingDef
	| ProviderLimitsSettingDef
	| ModelSelectorSettingDef
	| AgentsSettingDef
	| DefaultEffortSettingDef
	| AgentSharedEffortSettingDef
	| DefaultModelSettingDef
	| RulesSettingDef
	| LspSettingDef;

/** The settings path the {@link DefaultModelSettingDef} row edits. */
export const DEFAULT_MODEL_SETTING_ID = "defaultModel" satisfies SettingPath;

// ═══════════════════════════════════════════════════════════════════════════
// Condition Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read a settings-backed visibility condition, treating an unreachable Settings singleton as "off".
 *
 * Every condition below asks the live settings whether a feature is on, and `Settings.instance` throws
 * when there is no initialized settings context (a bare library caller, a unit test that renders a
 * definition without booting a session). Each condition used to carry its own `try`/`catch` returning
 * false, seven byte-identical copies of the same decision, so the reason lived nowhere and a change of
 * mind would have had to be made seven times.
 *
 * False means the conditional row is not shown, which is the same thing an off setting means. That is
 * safe here because it can only happen before settings exist, when there is no `/settings` screen to
 * show a row on; it is not a fallback for a setting that failed to read at runtime.
 */
function whenSettingsSay(read: () => boolean): boolean {
	try {
		return read();
	} catch {
		return false;
	}
}

const settingFlag = (path: SettingPath) => () => whenSettingsSay(() => Settings.instance.get(path) === true);
const settingValue =
	<P extends SettingPath>(path: P, check: (val: SchemaSettingValue<P>) => boolean) =>
	() =>
		whenSettingsSay(() => check(Settings.instance.get(path)));

const CONDITIONS: Record<string, () => boolean> = {
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	advisorEnabled: settingFlag("advisor.enabled"),
	argotEnabled: settingFlag("argot.enabled"),
	autoQaEnabled: settingFlag("dev.autoqa"),
	statusLineEnabled: settingFlag("statusLine.enabled"),
	cpuLimitEnabled: settingValue("session.cpuLimitCores", v => v > 0),
	writeBudgetEnabled: settingValue("session.writeBudgetGb", v => v > 0),
	cacheRejectionReported: settingFlag("cache.reportRejection"),
	agentSharedModel: settingFlag("agent.sharedModel"),
	agentIsolationEnabled: settingValue("agent.isolation.mode", v => v !== "none"),
	agentSoftRequestBudgetEnabled: settingValue("agent.softRequestBudget", v => (v ?? 0) > 0),
	bashAutoBackgroundEnabled: settingFlag("bash.autoBackground.enabled"),
	bashStallDetectionEnabled: settingFlag("bash.stallDetection.enabled"),
	hindsightActive: settingValue("memory.backend", v => v === "hindsight"),
	mnemopiActive: settingValue("memory.backend", v => v === "mnemopi"),
	autolearnActive: settingFlag("autolearn.enabled"),
	autoThinkingActive: () =>
		whenSettingsSay(
			() =>
				resolveEffort({
					defaultEffort: withLegacyDefaultEffort(
						Settings.instance.isConfigured("defaultEffort") ? Settings.instance.get("defaultEffort") : undefined,
						Settings.instance.get("defaultThinkingLevel"),
					),
				}).level === AUTO_THINKING,
		),
	planModeEnabled: settingValue("plan.enabled", Boolean),
	speechEnabled: settingFlag("speech.enabled"),
	sttEnabled: settingFlag("stt.enabled"),
	unexpectedStopDetection: settingFlag("features.unexpectedStopDetection"),
	lspEnabled: settingFlag("lsp.enabled"),
	browserEnabled: settingFlag("browser.enabled"),
	githubEnabled: settingFlag("github.enabled"),
	launchEnabled: settingFlag("launch.enabled"),
	githubCacheEnabled: settingValue(
		"github.enabled",
		v => v === true && Settings.instance.get("github.cache.enabled") === true,
	),
	secretsEnabled: settingFlag("secrets.enabled"),
	prewalkEnabled: settingFlag("prewalk.enabled"),
	composerPredictionsCustom: settingValue("composer.predictions.mode", v => v === "custom"),
};

// ═══════════════════════════════════════════════════════════════════════════
// Schema to UI Conversion
// ═══════════════════════════════════════════════════════════════════════════

function resolveOptions(ui: AnyUiMetadata): OptionList | "runtime" | undefined {
	if (!ui.options) return undefined;
	if (ui.options === "runtime") return "runtime";
	return ui.options;
}

/** Every switch on the LSP nested page, Language Servers first. */
export const LSP_SETTING_PATHS = [
	"lsp.enabled",
	"lsp.tool",
	"lsp.lazy",
	"lsp.formatOnWrite",
	"lsp.diagnosticsOnWrite",
	"lsp.diagnosticsOnEdit",
	"lsp.diagnosticsDeduplicate",
] as const satisfies readonly SettingPath[];

/** Nested LSP knobs: on the Files tab they live behind the LSP row, not beside it. */
export function isNestedLspKnob(path: SettingPath): boolean {
	return path.startsWith("lsp.") && path !== "lsp.enabled";
}

/**
 * Rows on the nested LSP page. Language Servers is always there; every other
 * switch is hidden until servers are on, so you enter the page and enable
 * each piece rather than toggling orphans with no server behind them.
 */
export function lspPanelPaths(): readonly SettingPath[] {
	if (Settings.instance.get("lsp.enabled") !== true) return ["lsp.enabled"];
	return LSP_SETTING_PATHS;
}

/**
 * Search can still name nested LSP knobs, but Files has no sibling row for
 * them. Landing after search must open the parent, not a missing id.
 */
export function settingsSearchLandingPath(path: SettingPath): SettingPath {
	return isNestedLspKnob(path) ? "lsp.enabled" : path;
}

/** Short Files-row value: Off, or On plus which nested pieces are on. */
export function formatLspSummary(): string {
	if (Settings.instance.get("lsp.enabled") !== true) return "Off";
	const bits: string[] = [];
	if (Settings.instance.get("lsp.tool") === true) bits.push("tool");
	if (Settings.instance.get("lsp.diagnosticsOnWrite") === true) bits.push("write");
	if (Settings.instance.get("lsp.diagnosticsOnEdit") === true) bits.push("edit");
	if (Settings.instance.get("lsp.formatOnWrite") === true) bits.push("format");
	return bits.length === 0 ? "On · servers only" : `On · ${bits.join(" · ")}`;
}

function pathToSettingDef(path: SettingPath): SettingDef | null {
	const ui = getUi(path);
	if (!ui || ui.hidden) return null;
	const schemaType = getType(path);
	const condition = ui.condition ? CONDITIONS[ui.condition] : undefined;
	const base = {
		path,
		label: ui.label,
		description: ui.description,
		tab: ui.tab,
		group: ui.group,
		condition,
		advanced: ui.advanced,
		keywords: ui.keywords,
	};

	if (path === "lsp.enabled") {
		return {
			...base,
			type: "lsp",
			description:
				"Enter to turn language servers, the agent tool, injected diagnostics, and format-after-write on or off independently.",
		};
	}

	if (schemaType === "boolean") return { ...base, type: "boolean" };

	const options = resolveOptions(ui);

	if (schemaType === "enum") {
		if (options === undefined) return { ...base, type: "enum", values: getEnumValues(path) ?? [] };
		return { ...base, type: "submenu", options: options === "runtime" ? [] : options };
	}

	if (schemaType === "number") {
		// A number with a list picks from it; a number without one is typed, exactly as
		// `string`, `record` and `array` already are. This used to `return null`, on the
		// reasoning that "numbers without options are intentionally hidden from the UI".
		// That stopped being true once fifteen of them carried a full `ui` block with a
		// label and a description: `getPathsForTab` found the path and `getAllSettingDefs`
		// dropped it, so the row was documented, defaulted, honored, and unreachable.
		// Declaring a `ui` block IS the request to be shown; the number branch returning
		// nothing was the anomaly among the scalar types, not the rule.
		if (!options || options === "runtime") return { ...base, type: "text" };
		return { ...base, type: "submenu", options };
	}

	if (schemaType === "modelChain") return { ...base, type: "modelSelector" };
	if (schemaType === "string") {
		if (path === "agent.thinkingLevel") return { ...base, type: "agentSharedEffort" };
		if (path === "compaction.threshold") {
			return { ...base, type: "compactionThreshold", options: options && options !== "runtime" ? options : [] };
		}
		if (options) return { ...base, type: "submenu", options: options === "runtime" ? [] : options };
		return { ...base, type: "text" };
	}

	if (schemaType === "record") {
		if (path === "providers.maxInFlightRequests") return { ...base, type: "providerLimits" };
		if (path === "agent.agents") return { ...base, type: "agents" };
		if (path === "defaultEffort") return { ...base, type: "defaultEffort" };
		return { ...base, type: "text" };
	}

	// Arrays edit as a text control: a string array (the common case, e.g.
	// `argot.encode.models`) shows and edits as a comma-separated list; an object array
	// (e.g. `bashInterceptor.patterns`) round-trips as JSON. The selector's
	// text-save path (#setSettingValue) splits/parses back to an array by the
	// schema type, so a `ui`-annotated array is reachable instead of silently
	// dropped. Arrays with no `ui` block are still TOML/CLI-only, as before.
	if (schemaType === "array") {
		// The one array that is a set of exceptions rather than a list of values, so it
		// reads as the thing it controls: every rule, each on or off.
		if (path === "ttsr.disabledRules") return { ...base, type: "rules" };
		return { ...base, type: "text" };
	}

	return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/** Cache of generated definitions */
let cachedDefs: SettingDef[] | null = null;

/** Drop the cached defs (tests / hot schema reload). */
export function invalidateSettingDefsCache(): void {
	cachedDefs = null;
}

/** Get all setting definitions with UI */
export function getAllSettingDefs(): SettingDef[] {
	if (cachedDefs) return cachedDefs;

	const defs: SettingDef[] = [];
	for (const tab of SETTING_TABS) {
		for (const path of getPathsForTab(tab)) {
			const def = pathToSettingDef(path);
			if (def) defs.push(def);
		}
	}
	// `defaultModel` declares no `ui` block, so its row is injected here. Placed
	// first so it heads the model tab's "Models" group: the top of the tab, where
	// "what model do I start on?" is looked for.
	defs.unshift({
		path: DEFAULT_MODEL_SETTING_ID,
		type: "defaultModel",
		tab: "model",
		group: "Models",
		label: "Default Model",
		description:
			"The model each new session starts on, restored on launch. This picker stores only the model; set its saved effort in Default Effort. Scoped to the active profile.",
	});
	cachedDefs = defs;
	return defs;
}

/**
 * Get settings for a specific tab, ordered by the tab's group layout
 * (TAB_GROUPS). Ungrouped settings sort first; within a group, schema
 * declaration order is preserved.
 */
export function getSettingsForTab(tab: SettingTab): SettingDef[] {
	const defs = getAllSettingDefs().filter(def => def.tab === tab);
	const order = TAB_GROUPS[tab];
	const rank = (def: SettingDef): number => {
		if (!def.group) return -1;
		const index = order.indexOf(def.group);
		return index >= 0 ? index : order.length;
	};
	return defs.sort((a, b) => rank(a) - rank(b));
}

/** Get a setting definition by path */
export function getSettingDef(path: SettingPath): SettingDef | undefined {
	return getAllSettingDefs().find(def => def.path === path);
}
