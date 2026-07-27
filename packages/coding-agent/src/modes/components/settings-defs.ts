/**
 * UI adapter over the schema. Reads `ui.options` declared inline in
 * settings-schema.ts and produces typed widget definitions for the
 * settings selector.
 *
 * Settings surface is intentionally lean: see TAB_GROUPS in settings-schema.ts
 * for which tabs/groups remain visible vs schema-only (no `ui` block).
 */

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
import { AUTO_THINKING } from "../../thinking";

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

type OptionList = ReadonlyArray<SubmenuOption>;

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

/** Searchable model picker (auth badges). Used for subagent/compaction model slots. */
export interface ModelSelectorSettingDef extends BaseSettingDef {
	type: "modelSelector";
}

/** Per-role model assignments via the same searchable picker. */
export interface ModelRolesSettingDef extends BaseSettingDef {
	type: "modelRoles";
}

/**
 * The `subagent.agents` table: one row per discovered agent, each carrying
 * whether it is offered, its model, and its effort.
 *
 * A dedicated type rather than the generic record-as-text control because the
 * keys are not free-form — they are the agents this project actually has, and an
 * operator editing JSON by hand cannot see which names exist or what a blank
 * model resolves to. The editor reads `task/subagent-settings.ts` for both, so
 * the settings tab and `/agents` cannot disagree about precedence.
 */
export interface SubagentAgentsSettingDef extends BaseSettingDef {
	type: "subagentAgents";
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
 * The profile's DEFAULT model — the model each new session starts on. Rendered
 * with the same searchable model+effort picker as the role/subagent slots, but
 * backed by the `default` model-role slot (the slot the interactive `/model`
 * choice writes to and startup restores from), so it has no schema key of its
 * own and never duplicates that source of truth.
 */
export interface DefaultModelSettingDef extends BaseSettingDef {
	type: "defaultModel";
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
	| DefaultEffortSettingDef
	| DefaultModelSettingDef;

/**
 * Synthetic settings id for the {@link DefaultModelSettingDef}. Not a real
 * config key: the value lives in the {@link DEFAULT_MODEL_SLOT} model-role slot,
 * read/written via `settings.getModelRole(DEFAULT_MODEL_SLOT)` / `setModelRole`.
 * Kept as a shared const so the def, the item builder, and the change handler all
 * agree on the id.
 *
 * The id is a SETTINGS PATH, a different namespace from the role string, so it is
 * deliberately not one of `DEFAULT_MODEL_SLOT_ALIASES`: `resolveModelSlot` accepts
 * role arguments, and a settings row id has no business resolving as one.
 *
 * Typed as {@link SettingPath} at this single definition (rather than cast at
 * each use) so `def.path === DEFAULT_MODEL_SETTING_ID` comparisons and the
 * item-builder `unshift` both typecheck against the real path union. The id is
 * intentionally not one of the schema-derived paths; the cast records that.
 */
export const DEFAULT_MODEL_SETTING_ID = "defaultModel" as SettingPath;

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

const CONDITIONS: Record<string, () => boolean> = {
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	advisorEnabled: () => whenSettingsSay(() => Settings.instance.get("advisor.enabled") === true),
	argotEnabled: () => whenSettingsSay(() => Settings.instance.get("argot.enabled") === true),
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
						Settings.instance.get("defaultEffort"),
						Settings.instance.get("defaultThinkingLevel"),
					),
				}).level === AUTO_THINKING,
		),
	planModeEnabled: () => whenSettingsSay(() => Settings.instance.get("plan.enabled")),
};

// ═══════════════════════════════════════════════════════════════════════════
// Schema to UI Conversion
// ═══════════════════════════════════════════════════════════════════════════

function resolveOptions(ui: AnyUiMetadata): OptionList | "runtime" | undefined {
	if (!ui.options) return undefined;
	if (ui.options === "runtime") return "runtime";
	return ui.options;
}

function pathToSettingDef(path: SettingPath): SettingDef | null {
	const ui = getUi(path);
	if (!ui) return null;

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
		// Numbers without options are intentionally hidden from the UI.
		if (!options || options === "runtime") return null;
		return { ...base, type: "submenu", options };
	}

	if (schemaType === "string") {
		if (path === "subagent.model" || path === "compaction.model") {
			return { ...base, type: "modelSelector" };
		}
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
	// Synthetic entry: the default model has no schema key of its own (it lives in
	// the `default` model-role slot), so it is injected here rather than derived
	// from the schema. Placed first so it heads the model tab's "Models" group —
	// the top of the tab, where "what model do I start on?" is looked for.
	defs.unshift({
		path: DEFAULT_MODEL_SETTING_ID,
		type: "defaultModel",
		tab: "model",
		group: "Models",
		label: "Default Model",
		description:
			"The model each new session starts on, restored on launch. Searchable picker with auth status, then a thinking-effort step. Scoped to the active profile.",
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

/** Get default value for display */
export function getDisplayDefault(path: SettingPath): string {
	const value = getDefault(path);
	if (value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}
