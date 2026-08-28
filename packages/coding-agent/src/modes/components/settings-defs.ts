/** UI adapter over the schema. Reads `ui.options` declared inline in settings-schema.ts and produces typed widget definitions for the */

import { TERMINAL } from "@veyyon/tui";
import { resolveEffort, withLegacyDefaultEffort } from "../../config/effort-resolver";
import { Settings } from "../../config/settings";
import {
	type AnyUiMetadata,
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	SETTING_TABS,
	type SettingPath,
	type SettingTab,
	type SubmenuOption,
	TAB_GROUPS,
} from "../../config/settings-schema";
import { SUBAGENT_MODEL_BY_DEPTH_PATH } from "../../task/subagent-settings";
import { AUTO_THINKING } from "../../thinking";

export type SettingValue = boolean | string;

interface BaseSettingDef {
	path: SettingPath;
	label: string;
	description: string;
	tab: SettingTab;
	/** Section within the tab; items are ordered by TAB_GROUPS[tab] and rendered under a heading row. */
	group?: string;
	/** Optional visibility predicate. When supplied and returning false, the setting is hidden from the UI. Applies to every variant — booleans, */
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

/** The `compaction.threshold` drill-down: three modes (Auto / Percent / Tokens) on the first level, the mode's preset values plus a Custom entry on the */
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

/** Searchable model picker (auth badges). Used for subagent/compaction model slots. */
export interface ModelSelectorSettingDef extends BaseSettingDef {
	type: "modelSelector";
}

/** Per-role model assignments via the same searchable picker. */
export interface ModelRolesSettingDef extends BaseSettingDef {
	type: "modelRoles";
}

/** The `subagent.agents` table: one row per discovered agent, each carrying whether it is offered, its model, and its effort. */
export interface SubagentAgentsSettingDef extends BaseSettingDef {
	type: "subagentAgents";
}

/** The `subagent.modelByDepth` map: one row per configured spawn depth, each edited with the same ordered-chain picker as `subagent.model`, bound to that */
export interface SubagentModelByDepthSettingDef extends BaseSettingDef {
	type: "subagentModelByDepth";
}

/** The profile's default effort per model: rows of `provider/id` (or `*` for any model) to an effort, edited as a list. The one persisted effort surface, so a */
export interface DefaultEffortSettingDef extends BaseSettingDef {
	type: "defaultEffort";
}

/** The profile's DEFAULT model — the model each new session starts on. Rendered with the same searchable model+effort picker as the role/subagent slots, but */
export interface DefaultModelSettingDef extends BaseSettingDef {
	type: "defaultModel";
}

/** The rule list: every discovered rule, each on or off. Backed by `ttsr.disabledRules`, which stores only the exceptions. That inversion is */
export interface RulesSettingDef extends BaseSettingDef {
	type: "rules";
}

/** Files → LSP. One row you enter; the nested page is every `lsp.*` boolean. The schema keys stay independent so config, the agent tool, and injection */
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
	| ModelRolesSettingDef
	| SubagentAgentsSettingDef
	| SubagentModelByDepthSettingDef
	| DefaultEffortSettingDef
	| DefaultModelSettingDef
	| RulesSettingDef
	| LspSettingDef;

/** Synthetic settings id for the {@link DefaultModelSettingDef}. Not a real config key: the value lives in the {@link DEFAULT_MODEL_SLOT} model-role slot, */
export const DEFAULT_MODEL_SETTING_ID = "defaultModel" as SettingPath;

/** Read a settings-backed visibility condition, treating an unreachable Settings singleton as "off". Every condition below asks the live settings whether a feature is on, and `Settings.instance` throws */
function whenSettingsSay(read: () => boolean): boolean {
	try {
		return read();
	} catch {
		return false;
	}
}

const CONDITIONS: Record<string, () => boolean> = {
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	advisorEnabled: () => whenSettingsSay(() => Settings.instance.get("advisor.enabled") === true),
	argotEnabled: () => whenSettingsSay(() => Settings.instance.get("argot.enabled") === true),
	autoQaEnabled: () => whenSettingsSay(() => Settings.instance.get("dev.autoqa") === true),
	// The footline is opt-in, and a preset or a thinking-level spelling for a row that
	// does not render is a knob with nothing behind it.
	statusLineEnabled: () => whenSettingsSay(() => Settings.instance.get("statusLine.enabled") === true),
	// The kill policy only matters while a budget exists; at 0 cores the toggle
	// would be a knob with nothing behind it.
	cpuLimitEnabled: () => whenSettingsSay(() => Settings.instance.get("session.cpuLimitCores") > 0),
	// Same shape for the write budget: at 0 GB nothing is metered, so a choice
	// between refusing and killing has no case where it applies.
	writeBudgetEnabled: () => whenSettingsSay(() => Settings.instance.get("session.writeBudgetGb") > 0),
	// Blocking on a rejection only makes sense while rejections are reported: a
	// run that stopped for a reason nothing was going to tell you about is worse
	// than one that quietly overpays.
	cacheRejectionReported: () => whenSettingsSay(() => Settings.instance.get("cache.reportRejection") === true),
	// Both close budgets are meaningless while nothing closes, and a visible timer
	// that does not run reads as a bug in the feature rather than an off switch.
	subagentAutoCloseEnabled: () => whenSettingsSay(() => Settings.instance.get("subagent.autoClose.enabled") === true),
	// Isolation ships off, and the merge strategy and commit style only describe
	// how an isolated run's changes come back. Shown while no backend is selected
	// they are two choices with no case where either applies.
	subagentIsolationEnabled: () => whenSettingsSay(() => Settings.instance.get("subagent.isolation.mode") !== "none"),
	// The wrap-up notice announces crossing a budget; with the guard at 0 there is
	// no crossing, so the row would be a switch over nothing.
	subagentSoftRequestBudgetEnabled: () =>
		whenSettingsSay(() => (Settings.instance.get("subagent.softRequestBudget") ?? 0) > 0),
	bashAutoBackgroundEnabled: () =>
		whenSettingsSay(() => Settings.instance.get("bash.autoBackground.enabled") === true),
	bashStallDetectionEnabled: () =>
		whenSettingsSay(() => Settings.instance.get("bash.stallDetection.enabled") === true),
	hindsightActive: () => whenSettingsSay(() => Settings.instance.get("memory.backend") === "hindsight"),
	mnemopiActive: () => whenSettingsSay(() => Settings.instance.get("memory.backend") === "mnemopi"),
	autolearnActive: () => whenSettingsSay(() => Settings.instance.get("autolearn.enabled") === true),
	// Reads the Default Effort list through its one owner, so a `*` row of `auto`
	// counts: checking the retired `defaultThinkingLevel` here would have gone
	// stale the moment the list became the surface people edit.
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
	planModeEnabled: () => whenSettingsSay(() => Settings.instance.get("plan.enabled")),
	speechEnabled: () => whenSettingsSay(() => Settings.instance.get("speech.enabled") === true),
	sttEnabled: () => whenSettingsSay(() => Settings.instance.get("stt.enabled") === true),
	// `providers.unexpectedStopModel` has declared `condition: "unexpectedStopDetection"` since it shipped and this predicate did not exist, so the lookup answered
	unexpectedStopDetection: () =>
		whenSettingsSay(() => Settings.instance.get("features.unexpectedStopDetection") === true),
	// Four tools that ship OFF and whose knobs rendered anyway. The Files tab offered lazy startup, format-on-write and three diagnostics rules to a
	lspEnabled: () => whenSettingsSay(() => Settings.instance.get("lsp.enabled") === true),
	browserEnabled: () => whenSettingsSay(() => Settings.instance.get("browser.enabled") === true),
	githubEnabled: () => whenSettingsSay(() => Settings.instance.get("github.enabled") === true),
	launchEnabled: () => whenSettingsSay(() => Settings.instance.get("launch.enabled") === true),
	// The two TTLs read both toggles: a window on a cache nothing writes to is as
	// empty a knob as one on a tool nothing runs.
	githubCacheEnabled: () =>
		whenSettingsSay(
			() =>
				Settings.instance.get("github.enabled") === true && Settings.instance.get("github.cache.enabled") === true,
		),
	secretsEnabled: () => whenSettingsSay(() => Settings.instance.get("secrets.enabled") === true),
	prewalkEnabled: () => whenSettingsSay(() => Settings.instance.get("prewalk.enabled") === true),
};

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

/** Rows on the nested LSP page. Language Servers is always there; every other switch is hidden until servers are on, so you enter the page and enable */
export function lspPanelPaths(): readonly SettingPath[] {
	if (Settings.instance.get("lsp.enabled") !== true) return ["lsp.enabled"];
	return LSP_SETTING_PATHS;
}

/** Search can still name nested LSP knobs, but Files has no sibling row for them. Landing after search must open the parent, not a missing id. */
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
	if (!ui) return null;
	// Declared state rather than a declared control. One setting uses this, and it says
	// so; see `hidden` in settings-schema.ts.
	if (ui.hidden) return null;

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

	if (schemaType === "boolean") {
		return { ...base, type: "boolean" };
	}

	const options = resolveOptions(ui);

	if (schemaType === "enum") {
		if (options === undefined) {
			return { ...base, type: "enum", values: getEnumValues(path) ?? [] };
		}
		// "runtime" is not a valid sentinel for enums — schema types prevent this,
		// but treat defensively as an empty submenu.
		return { ...base, type: "submenu", options: options === "runtime" ? [] : options };
	}

	if (schemaType === "number") {
		// A number with a list picks from it; a number without one is typed, exactly as `string`, `record` and `array` already are. This used to `return null`, on the
		if (!options || options === "runtime") return { ...base, type: "text" };
		return { ...base, type: "submenu", options };
	}

	// A chain setting is edited by picking models, never by typing a type name. This used to be a hardcoded pair of paths inside the string branch, so a
	if (schemaType === "modelChain") {
		return { ...base, type: "modelSelector" };
	}

	if (schemaType === "string") {
		if (path === "compaction.threshold") {
			return { ...base, type: "compactionThreshold", options: options && options !== "runtime" ? options : [] };
		}
		if (options === "runtime") {
			// Empty list now; the selector layer (theme handling, etc.) injects choices.
			return { ...base, type: "submenu", options: [] };
		}
		if (options) {
			return { ...base, type: "submenu", options };
		}
		return { ...base, type: "text" };
	}

	if (schemaType === "record") {
		if (path === "providers.maxInFlightRequests") return { ...base, type: "providerLimits" };
		if (path === "modelRoles") return { ...base, type: "modelRoles" };
		if (path === "subagent.agents") return { ...base, type: "subagentAgents" };
		if (path === SUBAGENT_MODEL_BY_DEPTH_PATH) return { ...base, type: "subagentModelByDepth" };
		if (path === "defaultEffort") return { ...base, type: "defaultEffort" };
		return { ...base, type: "text" };
	}

	// Arrays edit as a text control: a string array (the common case, e.g. `argot.encode.models`) shows and edits as a comma-separated list; an object array
	if (schemaType === "array") {
		// The one array that is a set of exceptions rather than a list of values, so it
		// reads as the thing it controls: every rule, each on or off.
		if (path === "ttsr.disabledRules") return { ...base, type: "rules" };
		return { ...base, type: "text" };
	}

	return null;
}

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
	// Synthetic entry: the default model has no schema key of its own (it lives in the `default` model-role slot), so it is injected here rather than derived
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

/** Get settings for a specific tab, ordered by the tab's group layout (TAB_GROUPS). Ungrouped settings sort first; within a group, schema */
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

/** Get default value for display */
export function getDisplayDefault(path: SettingPath): string {
	const value = getDefault(path);
	if (value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}
