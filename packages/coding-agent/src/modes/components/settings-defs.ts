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
	group?: string;
	condition?: () => boolean;
	advanced?: boolean;
	keywords?: readonly string[];
}

export interface BooleanSettingDef extends BaseSettingDef {
	type: "boolean";
}

export interface EnumSettingDef extends BaseSettingDef {
	type: "enum";
	values: readonly string[];
}

export type OptionList = ReadonlyArray<SubmenuOption>;

export interface SubmenuSettingDef extends BaseSettingDef {
	type: "submenu";
	options: OptionList;
	onPreview?: (value: string) => void;
	onPreviewCancel?: (originalValue: string) => void;
}

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

export interface ModelSelectorSettingDef extends BaseSettingDef {
	type: "modelSelector";
}

export interface ModelRolesSettingDef extends BaseSettingDef {
	type: "modelRoles";
}

export interface SubagentAgentsSettingDef extends BaseSettingDef {
	type: "subagentAgents";
}

export interface SubagentModelByDepthSettingDef extends BaseSettingDef {
	type: "subagentModelByDepth";
}

export interface DefaultEffortSettingDef extends BaseSettingDef {
	type: "defaultEffort";
}

export interface DefaultModelSettingDef extends BaseSettingDef {
	type: "defaultModel";
}

export interface RulesSettingDef extends BaseSettingDef {
	type: "rules";
}

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

export const DEFAULT_MODEL_SETTING_ID = "defaultModel" as SettingPath;

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
	statusLineEnabled: () => whenSettingsSay(() => Settings.instance.get("statusLine.enabled") === true),
	cpuLimitEnabled: () => whenSettingsSay(() => Settings.instance.get("session.cpuLimitCores") > 0),
	writeBudgetEnabled: () => whenSettingsSay(() => Settings.instance.get("session.writeBudgetGb") > 0),
	cacheRejectionReported: () => whenSettingsSay(() => Settings.instance.get("cache.reportRejection") === true),
	subagentAutoCloseEnabled: () => whenSettingsSay(() => Settings.instance.get("subagent.autoClose.enabled") === true),
	subagentIsolationEnabled: () => whenSettingsSay(() => Settings.instance.get("subagent.isolation.mode") !== "none"),
	subagentSoftRequestBudgetEnabled: () =>
		whenSettingsSay(() => (Settings.instance.get("subagent.softRequestBudget") ?? 0) > 0),
	bashAutoBackgroundEnabled: () =>
		whenSettingsSay(() => Settings.instance.get("bash.autoBackground.enabled") === true),
	bashStallDetectionEnabled: () =>
		whenSettingsSay(() => Settings.instance.get("bash.stallDetection.enabled") === true),
	hindsightActive: () => whenSettingsSay(() => Settings.instance.get("memory.backend") === "hindsight"),
	mnemopiActive: () => whenSettingsSay(() => Settings.instance.get("memory.backend") === "mnemopi"),
	autolearnActive: () => whenSettingsSay(() => Settings.instance.get("autolearn.enabled") === true),
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
	unexpectedStopDetection: () =>
		whenSettingsSay(() => Settings.instance.get("features.unexpectedStopDetection") === true),
	lspEnabled: () => whenSettingsSay(() => Settings.instance.get("lsp.enabled") === true),
	browserEnabled: () => whenSettingsSay(() => Settings.instance.get("browser.enabled") === true),
	githubEnabled: () => whenSettingsSay(() => Settings.instance.get("github.enabled") === true),
	launchEnabled: () => whenSettingsSay(() => Settings.instance.get("launch.enabled") === true),
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

export const LSP_SETTING_PATHS = [
	"lsp.enabled",
	"lsp.tool",
	"lsp.lazy",
	"lsp.formatOnWrite",
	"lsp.diagnosticsOnWrite",
	"lsp.diagnosticsOnEdit",
	"lsp.diagnosticsDeduplicate",
] as const satisfies readonly SettingPath[];

export function isNestedLspKnob(path: SettingPath): boolean {
	return path.startsWith("lsp.") && path !== "lsp.enabled";
}

export function lspPanelPaths(): readonly SettingPath[] {
	if (Settings.instance.get("lsp.enabled") !== true) return ["lsp.enabled"];
	return LSP_SETTING_PATHS;
}

export function settingsSearchLandingPath(path: SettingPath): SettingPath {
	return isNestedLspKnob(path) ? "lsp.enabled" : path;
}

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
		return { ...base, type: "submenu", options: options === "runtime" ? [] : options };
	}

	if (schemaType === "number") {
		if (!options || options === "runtime") return { ...base, type: "text" };
		return { ...base, type: "submenu", options };
	}

	if (schemaType === "modelChain") {
		return { ...base, type: "modelSelector" };
	}

	if (schemaType === "string") {
		if (path === "compaction.threshold") {
			return { ...base, type: "compactionThreshold", options: options && options !== "runtime" ? options : [] };
		}
		if (options === "runtime") {
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

	if (schemaType === "array") {
		if (path === "ttsr.disabledRules") return { ...base, type: "rules" };
		return { ...base, type: "text" };
	}

	return null;
}

let cachedDefs: SettingDef[] | null = null;

export function invalidateSettingDefsCache(): void {
	cachedDefs = null;
}

export function getAllSettingDefs(): SettingDef[] {
	if (cachedDefs) return cachedDefs;

	const defs: SettingDef[] = [];
	for (const tab of SETTING_TABS) {
		for (const path of getPathsForTab(tab)) {
			const def = pathToSettingDef(path);
			if (def) defs.push(def);
		}
	}
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

export function getSettingDef(path: SettingPath): SettingDef | undefined {
	return getAllSettingDefs().find(def => def.path === path);
}

export function getDisplayDefault(path: SettingPath): string {
	const value = getDefault(path);
	if (value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}
