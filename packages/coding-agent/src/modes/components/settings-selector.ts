import { AUTO_COMPACTION_THRESHOLD, parseCompactionThreshold, type ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Effort, Model } from "@veyyon/ai";
import {
	type Component,
	Container,
	extractPrintableText,
	getKeybindings,
	type ImageBudget,
	Input,
	matchesKey,
	padding,
	rankSettingItems,
	replaceTabs,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	type SgrMouseEvent,
	Spacer,
	type Tab,
	TabBar,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import { clamp, collapseWhitespace, errorMessage, isRecord, VERSION } from "@veyyon/utils";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "../../capability/rule";
import { ANY_MODEL_EFFORT_KEY, withLegacyDefaultEffort } from "../../config/effort-resolver";
import type { ModelRegistry } from "../../config/model-registry";
import {
	extractExplicitThinkingSelector,
	normalizeModelPatternList,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
} from "../../config/model-resolver";
import {
	DEFAULT_MODEL_SLOT,
	getRoleInfo,
	ROLE_INHERIT_LABEL,
	SELECTABLE_MODEL_ROLE_IDS,
} from "../../config/model-roles";
import { UNSET_NUMBER, UNSET_NUMBER_OPTION_VALUE } from "../../config/optional-number";
import {
	getDefault,
	getType,
	normalizeProviderMaxInFlightRequests,
	type SettingPath,
	type SettingSource,
	settings,
	validateProviderMaxInFlightRequests,
} from "../../config/settings";
import type { SubagentAgentSettings, SubagentLaneSettings } from "../../config/settings-domains/subagents";
import type { SettingTab, StatusLinePreset, StatusLineSegmentId, SubmenuOption } from "../../config/settings-schema";
import { getUi, isUnsetNumberPath, SETTING_TABS, TAB_METADATA } from "../../config/settings-schema";
import { loadCapability } from "../../discovery";
import { BUILTIN_RULE_SECTIONS, type BuiltinRuleSection } from "../../discovery/builtin-rules";
import { withIcon } from "../../modes/theme/icon-label";
import { getCurrentThemeName, getSelectListTheme, getSettingsListTheme, theme } from "../../modes/theme/theme";
import { BUILTIN_PERSONALITY_DESCRIPTIONS, NONE_PERSONALITY } from "../../personality/resolver";
import { discoverAgents } from "../../task/discovery";
import {
	clearSubagentModelByDepthRow,
	delegationBlockedNotice,
	isSubagentEnableDefaulted,
	nextSubagentEnableValue,
	nextSubagentModelByDepth,
	resolveDelegation,
	resolveSubagentMaxNestedSpawnDepth,
	resolveSubagentModel,
	resolveSubagentThinkingLevel,
	SUBAGENT_ENABLE_STATE_LABEL,
	SUBAGENT_MODEL_BY_DEPTH_PATH,
	subagentEnableState,
	subagentModelByDepthRowPath,
	subagentModelByDepthRows,
	subagentModelSourceLabel,
	subagentSettingsFor,
} from "../../task/subagent-settings";
import { type AgentDefinition, canSpawnAtDepth } from "../../task/types";
import {
	configuredThinkingLevelOptions,
	hasConfigurableThinkingEffort,
	INHERIT_EFFORT_OPTION_VALUE,
	noSelectableEffortNotice,
} from "../../thinking";
import { getTabBarTheme } from "../shared";
import { formatSelectorSummary, renderEffortStep } from "./effort-picker";
import {
	applyModalReveal,
	BREADCRUMB_HOVER_ID,
	beginModalExit,
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_SETTINGS,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	modalRevealEnabled,
	planModalChrome,
	renderModalShell,
	SETTINGS_BROWSE_SHORTCUTS,
	SETTINGS_FILTER_SHORTCUTS,
	SETTINGS_SUBPANE_SHORTCUTS,
	sizingForArea,
} from "./modal-shell";
import { ModelSelectorPanel } from "./model-selector";
import { handleInputOrEscape, PluginSettingsComponent } from "./plugin-settings";
import { RollbackPanelComponent } from "./rollback-panel";
import { MouseRoutedSubmenu, routeSettingsListPointer } from "./select-list-mouse-routing";
import {
	DEFAULT_MODEL_SETTING_ID,
	getSettingDef,
	getSettingsForTab,
	type OptionList,
	type SettingDef,
} from "./settings-defs";
import { getPreset } from "./status-line/presets";

/**
 * A decimal number and nothing else. Deliberately narrower than `Number()`, which
 * accepts `0x10` as 16, `1e400` as Infinity, ` 5 ` after trimming and `""` as zero.
 * Every one of those is a value the operator did not mean to type into a retry delay.
 */
const DECIMAL_NUMBER = /^-?\d+(?:\.\d+)?$/;

/** An empty box clears the setting, which for a number means the default comes back. */
export const UNSET_NUMBER_INPUT = "unset";

/**
 * What a typed number does to the setting: store this value, clear it, or refuse.
 *
 * A text input hands back a string and these settings are numbers with meaning: retry
 * delays, cache TTLs, a concurrency cap, line thresholds. The write path used to do
 * `Number(value)` and store the result, so `"abc"` became NaN and `""` became 0. A
 * threshold that quietly becomes zero is worse than a row the operator could not see,
 * because the invisible row was at least honest about being absent. So an unreadable
 * value is refused where it was typed: the thrown message renders in red under the
 * input and the submenu stays open, rather than closing over a stored surprise.
 *
 * An empty box is the one string that is not a refusal. The input's own footer says
 * "Clear field to unset", and for a number the honest reading of that is to remove the
 * key so the schema default applies again. Storing 0 for it would be the exact silent
 * coercion this function exists to stop.
 *
 * Bounds come from the schema (`ui.min` / `ui.max`) and nowhere else. A setting that
 * declares none accepts any decimal: the job is to enforce what was written down, not
 * to invent a range at the input and refuse a value that was legal. Today every bound
 * in the schema is a `min`; no number setting declares a `max`.
 *
 * Exported because it IS the contract. Left private it could only be tested by driving
 * the whole selector, which is how "`Number(value)` and hope" survived this long.
 */
export function parseNumberSetting(path: SettingPath, text: string): number | typeof UNSET_NUMBER_INPUT {
	if (text.trim() === "") return UNSET_NUMBER_INPUT;
	if (!DECIMAL_NUMBER.test(text)) throw new Error(`"${text}" is not a number. Type digits only, for example 250.`);
	const parsed = Number(text);
	if (!Number.isFinite(parsed)) throw new Error(`"${text}" is too large to store.`);
	const ui = getUi(path);
	if (ui?.min !== undefined && parsed < ui.min) throw new Error(`Must be at least ${ui.min}.`);
	if (ui?.max !== undefined && parsed > ui.max) throw new Error(`Must be at most ${ui.max}.`);
	return parsed;
}

/**
 * A submenu component for selecting from a list of options.
 */
/**
 * Submenu component for free-text string settings.
 * Mirrors the ConfigInputSubmenu pattern from plugin-settings.ts.
 */
class TextInputSubmenu extends Container {
	#input: Input;
	#error: Text;

	constructor(
		label: string,
		description: string,
		currentValue: string,
		private readonly onSubmit: (value: string) => void,
		private readonly onCancel: () => void,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", label)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));

		this.#input = new Input();
		if (currentValue) {
			this.#input.setValue(currentValue);
		}
		this.#error = new Text("", 0, 0);
		this.#input.onSubmit = value => {
			try {
				this.onSubmit(value); // empty string clears the setting
			} catch (error) {
				const message = errorMessage(error);
				this.#error.setText(theme.fg("error", truncateToWidth(replaceTabs(message).replace(/[\r\n]+/g, " "), 100)));
			}
		};
		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		this.addChild(this.#error);
		this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel · Clear field to unset"), 0, 0));
	}

	handleInput(data: string): void {
		handleInputOrEscape(data, this.#input, this.onCancel);
	}
}

class SelectSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList;
	#previewText: Text | null = null;
	#previewUpdateRequestId: number = 0;

	constructor(
		title: string,
		description: string,
		options: ReadonlyArray<SelectItem>,
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void | Promise<void>,
		private readonly getPreview?: () => string,
		footer?: Component,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Preview (if provided)
		if (getPreview) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", "Preview:"), 0, 0));
			this.#previewText = new Text(getPreview(), 0, 0);
			this.addChild(this.#previewText);
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.#selectList = new SelectList(options, Math.min(options.length, 10), getSelectListTheme());

		// Pre-select current value
		const currentIndex = options.findIndex(o => o.value === currentValue);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value);
		};

		this.#selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.#selectList.onSelectionChange = item => {
				const requestId = ++this.#previewUpdateRequestId;
				const result = onSelectionChange(item.value);
				if (result && typeof (result as Promise<void>).then === "function") {
					void (result as Promise<void>).finally(() => {
						if (requestId === this.#previewUpdateRequestId) {
							this.#updatePreview();
						}
					});
					return;
				}
				if (requestId === this.#previewUpdateRequestId) {
					this.#updatePreview();
				}
			};
		}

		this.addChild(this.#selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));

		// Optional footer component below the interactive rows, so the list never
		// shifts while browsing.
		if (footer) {
			this.addChild(new Spacer(1));
			this.addChild(footer);
		}
	}

	#updatePreview(): void {
		if (this.#previewText && this.getPreview) {
			this.#previewText.setText(this.getPreview());
		}
	}

	/**
	 * The select list is the only interactive child; the base records where it
	 * lands and routes wheel/hover/click to it.
	 */
	mouseTarget(): SelectList {
		return this.#selectList;
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}

/** Sentinel for the drill-down's free-text entries; never a stored value. */
const THRESHOLD_CUSTOM_VALUE = "__custom__";

type ThresholdMode = "auto" | "percent" | "tokens";

/**
 * The stored string's mode, decided by the same parser auto-compaction runs
 * on, so the drill-down can never disagree with the session about which mode
 * a value means. Garbage parses to auto WITH `invalidRaw`, which the mode view
 * surfaces as a warning instead of silently presenting Auto as chosen.
 */
function thresholdModeOf(raw: string): { mode: ThresholdMode; invalidRaw?: string } {
	const spec = parseCompactionThreshold(raw);
	if (spec.kind === "percent") return { mode: "percent" };
	if (spec.kind === "tokens") return { mode: "tokens" };
	return { mode: "auto", ...(spec.invalidRaw !== undefined ? { invalidRaw: spec.invalidRaw } : {}) };
}

/**
 * Short display form for a stored threshold: `200000` renders `200k`,
 * `1000000` renders `1M`, a percent normalizes to `<n>%` (`85 %` renders
 * `85%`); `auto` and anything unparseable pass through untouched. Used by the
 * outer settings row and the mode rows' current markers, so both always spell
 * one value the same way.
 */
function formatThresholdShort(raw: string): string {
	const spec = parseCompactionThreshold(raw);
	if (spec.kind === "tokens") {
		if (spec.tokens % 1_000_000 === 0) return `${spec.tokens / 1_000_000}M`;
		if (spec.tokens % 1_000 === 0) return `${spec.tokens / 1_000}k`;
		return String(spec.tokens);
	}
	if (spec.kind === "percent") return `${spec.percent}%`;
	return raw;
}

/**
 * Two-level picker for `compaction.threshold`: mode first (Auto / Percent /
 * Tokens), then the mode's values. The flat submenu listed all 19 presets in
 * one list, which hid that the setting has three semantics — auto follows the
 * model's window, a percent scales with it, a token amount is fixed across
 * models. The active mode carries the green check and its current value, so
 * the mode view alone answers "what will trigger compaction".
 *
 * The schema's `ui.options` stay the single source of presets; they are
 * partitioned by unit at render time. A stored value no preset spells (a
 * hand-edited `170000`, a legacy fold-in) appears as a marked custom row in
 * its mode's list, never silently presented as a preset pick.
 */
class CompactionThresholdSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;

	constructor(
		private readonly options: ReadonlyArray<SubmenuOption>,
		private readonly onPersist: () => void,
		private readonly onClose: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showModes();
	}

	/** The raw stored value; read fresh so re-renders after a persist show the new pick. */
	#currentRaw(): string {
		return String(settings.get("compaction.threshold") ?? AUTO_COMPACTION_THRESHOLD);
	}

	/** Green check for the active row, blank padding for the rest, so labels align. */
	#marker(active: boolean): string {
		return active ? `${theme.fg("success", theme.status.enabled)} ` : "  ";
	}

	#showModes(): void {
		this.clear();
		this.#selectList = undefined;
		this.addChild(new Text(theme.bold(theme.fg("accent", "Auto-Compaction Threshold")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"When auto-compaction triggers. Auto uses the model's window minus the reserve; a percent scales with each model's window; a token amount is the same trigger on every model.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const raw = this.#currentRaw();
		const { mode, invalidRaw } = thresholdModeOf(raw);
		if (invalidRaw !== undefined) {
			this.addChild(
				new Text(
					theme.fg(
						"warning",
						`Stored value "${invalidRaw}" is not auto, a percent, or a token amount; Auto is in effect.`,
					),
					0,
					0,
				),
			);
			this.addChild(new Spacer(1));
		}

		// The current amount rides on the Percent/Tokens rows; Auto names itself.
		const current = theme.fg("dim", `(current: ${formatThresholdShort(raw)})`);
		const items: SelectItem[] = [
			{
				value: "auto",
				label: `${this.#marker(mode === "auto")}Auto`,
				description: "The model's context window minus the reserve",
			},
			{
				value: "percent",
				label: `${this.#marker(mode === "percent")}Percent${mode === "percent" ? ` ${current}` : ""}`,
				description: "Scales with each model's window",
			},
			{
				value: "tokens",
				label: `${this.#marker(mode === "tokens")}Tokens${mode === "tokens" ? ` ${current}` : ""}`,
				description: "The same trigger on every model",
			},
		];

		this.#selectList = new SelectList(items, items.length, getSelectListTheme());
		this.#selectList.setSelectedIndex(items.findIndex(item => item.value === mode));
		this.#selectList.onSelect = item => {
			if (item.value === "auto") {
				this.#persist(AUTO_COMPACTION_THRESHOLD);
				return;
			}
			if (item.value === "percent" || item.value === "tokens") {
				this.#showValuePicker(item.value);
				this.requestRender?.();
			}
		};
		this.#selectList.onCancel = this.onClose;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to choose · Esc to go back"), 0, 0));
	}

	#showValuePicker(mode: "percent" | "tokens"): void {
		this.clear();
		this.#selectList = undefined;
		const title = mode === "percent" ? "Auto-Compaction Threshold — Percent" : "Auto-Compaction Threshold — Tokens";
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					mode === "percent"
						? "Compact once the context passes this share of the model's window. Follows the window when you switch models."
						: "Compact once the context passes this many tokens, on every model. Larger than the window compacts at the window's edge instead.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const raw = this.#currentRaw();
		const presets = this.options.filter(option =>
			mode === "percent" ? option.value.endsWith("%") : /^[0-9_]+$/.test(option.value),
		);
		const items: SelectItem[] = presets.map(option => ({
			value: option.value,
			label: `${this.#marker(option.value === raw)}${option.label}`,
			...(option.description !== undefined ? { description: option.description } : {}),
		}));
		// A stored value no preset spells (hand-edited config, legacy fold-in)
		// still gets a truthful row, checked, instead of vanishing behind Custom.
		if (thresholdModeOf(raw).mode === mode && !presets.some(option => option.value === raw)) {
			items.unshift({
				value: raw,
				label: `${this.#marker(true)}${formatThresholdShort(raw)} ${theme.fg("dim", "(custom)")}`,
				description: "Set by hand; not one of the presets",
			});
		}
		items.push({
			value: THRESHOLD_CUSTOM_VALUE,
			label: `  Custom…`,
			description: mode === "percent" ? "Type any whole percent from 1 to 99" : "Type any token amount",
		});

		this.#selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
		const currentIndex = items.findIndex(item => item.value === raw);
		if (currentIndex !== -1) this.#selectList.setSelectedIndex(currentIndex);
		this.#selectList.onSelect = item => {
			if (item.value === THRESHOLD_CUSTOM_VALUE) {
				this.#showCustomInput(mode);
			} else {
				this.#persist(item.value);
			}
			this.requestRender?.();
		};
		this.#selectList.onCancel = () => {
			this.#showModes();
			this.requestRender?.();
		};
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	#showCustomInput(mode: "percent" | "tokens"): void {
		this.clear();
		this.#selectList = undefined;
		const raw = this.#currentRaw();
		const input = new TextInputSubmenu(
			mode === "percent" ? "Custom Percent" : "Custom Token Amount",
			mode === "percent"
				? "A whole percent from 1 to 99 (the parser's clamp range); the % sign is optional."
				: "A positive token amount, e.g. 170000. Underscores are fine (170_000).",
			thresholdModeOf(raw).mode === mode ? raw : "",
			value => {
				this.#persist(this.#validateCustom(mode, value));
				this.requestRender?.();
			},
			() => {
				this.#showValuePicker(mode);
				this.requestRender?.();
			},
		);
		this.addChild(input);
	}

	/**
	 * Validate and normalize a typed value to its stored form. Throws with the
	 * fix in the message; TextInputSubmenu renders it in the error line.
	 */
	#validateCustom(mode: "percent" | "tokens", value: string): string {
		const text = value.trim();
		if (mode === "percent") {
			const percent = Number(text.replace(/%$/, "").trim());
			if (!Number.isInteger(percent) || percent < 1 || percent > 99) {
				throw new Error(`"${value}" is not a whole percent from 1 to 99.`);
			}
			return `${percent}%`;
		}
		const tokens = Number(text.replace(/_/g, ""));
		if (!Number.isInteger(tokens) || tokens <= 0) {
			throw new Error(`"${value}" is not a positive token amount (e.g. 170000).`);
		}
		return String(tokens);
	}

	#persist(value: string): void {
		settings.set("compaction.threshold", value);
		this.onPersist();
		this.#showModes();
		this.requestRender?.();
	}

	/** The list is the only interactive child; undefined in the custom-input state, which consumes pointer events silently. */
	mouseTarget(): SelectList | undefined {
		return this.#selectList;
	}

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

class ProviderLimitsSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;

	constructor(
		private readonly providers: readonly string[],
		private readonly onChange: (value: Record<string, number>) => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showProviderList();
	}

	#providerIds(): string[] {
		const limits = normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"));
		return [...new Set([...this.providers, ...Object.keys(limits)])].sort((a, b) => a.localeCompare(b));
	}

	#showProviderList(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Max In-Flight Requests")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Select a provider, enter a positive number to cap concurrent LLM requests, or clear it for unlimited.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const limits = normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"));
		const providerItems = this.#providerIds().map((provider): SelectItem => {
			const limit = limits[provider];
			return {
				value: provider,
				label: provider,
				description: limit === undefined ? "Unlimited" : `Limit: ${limit}`,
			};
		});
		const clearItem: SelectItem[] =
			Object.keys(limits).length === 0
				? []
				: [{ value: "__clear_all", label: "Clear all limits", description: "Make every provider unlimited" }];
		const items = [...providerItems, ...clearItem];
		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === "__clear_all") {
				settings.set("providers.maxInFlightRequests", {});
				this.onChange({});
				this.#showProviderList();
				this.requestRender?.();
				return;
			}
			this.#showProviderEditor(item.value);
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to edit provider · Esc to go back"), 0, 0));
	}

	#showProviderEditor(provider: string): void {
		const limits = normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"));
		this.clear();
		this.#selectList = undefined;
		this.addChild(
			new TextInputSubmenu(
				`Max In-Flight Requests: ${provider}`,
				"Enter a positive number. Decimals round down. Clear the field to make this provider unlimited.",
				limits[provider]?.toString() ?? "",
				value => {
					const next = { ...limits };
					const trimmed = value.trim();
					if (trimmed === "") {
						delete next[provider];
					} else {
						const limit = Number(trimmed);
						if (!Number.isFinite(limit) || limit <= 0) throw new Error("Limit must be a positive number.");
						next[provider] = Math.max(1, Math.floor(limit));
					}
					const normalized = validateProviderMaxInFlightRequests(next);
					settings.set("providers.maxInFlightRequests", normalized);
					this.onChange(normalized);
					this.#showProviderList();
					this.requestRender?.();
				},
				() => {
					this.#showProviderList();
					this.requestRender?.();
				},
			),
		);
	}

	/** The list is the only interactive child; undefined in the provider editor state, which consumes pointer events silently. */
	mouseTarget(): SelectList | undefined {
		return this.#selectList;
	}

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

/**
 * Bare `provider/id` for picker preselection from a stored value that may
 * carry a `:effort` suffix (`provider/id:high`) — the encoding
 * {@link renderEffortStep} persists. Without this the picker cannot match the
 * current row, so selection lands on the pinned (inherit) row and a quick
 * Enter clears instead of re-picking. Falls back to the raw string when the
 * value does not resolve, so an unmatched selector still shows as typed.
 */
export function barePickerSelector(raw: string | undefined, models: ReadonlyArray<Model<Api>>): string | undefined {
	if (!raw) return undefined;
	const resolved = resolveModelRoleValue(raw, models).model;
	return resolved ? `${resolved.provider}/${resolved.id}` : raw;
}

/**
 * Append or replace one chain position without allowing the same logical model
 * to occupy two fallback slots under different effort suffixes.
 */
export function replaceModelChainEntry(
	chain: readonly string[],
	index: number | null,
	value: string,
	models: ReadonlyArray<Model<Api>>,
): string[] | undefined {
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	const bare = barePickerSelector(trimmed, models);
	const duplicate = chain.some(
		(candidate, candidateIndex) => candidateIndex !== index && barePickerSelector(candidate, models) === bare,
	);
	if (duplicate) return undefined;
	const next = [...chain];
	if (index === null) {
		next.push(trimmed);
		return next;
	}
	if (!Number.isInteger(index) || index < 0 || index >= next.length) return undefined;
	next[index] = trimmed;
	return next;
}

/**
 * Role list → reusable {@link ModelSelectorPanel} for each role.
 * Assignments write through `settings.setModelRole` (profile-scoped).
 */
class ModelRolesSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#models: ReadonlyArray<Model>;
	#registry: ModelRegistry;

	constructor(
		models: ReadonlyArray<Model>,
		registry: ModelRegistry,
		private readonly onChange: () => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#models = models;
		this.#registry = registry;
		this.#showRoleList();
	}

	#showRoleList(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Role Models")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Assign a model per role. Searchable picker · auth status on each row. Per active profile.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const items: SelectItem[] = SELECTABLE_MODEL_ROLE_IDS.map(role => {
			const info = getRoleInfo(role, settings);
			const assigned = settings.getModelRole(role)?.trim();
			return {
				value: role,
				label: info.name,
				description:
					assigned && assigned.length > 0
						? formatSelectorSummary(assigned)
						: (info.unsetLabel ?? ROLE_INHERIT_LABEL),
			};
		});
		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			this.#showModelPicker(item.value);
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to pick model · Esc to go back"), 0, 0));
	}

	#showModelPicker(role: string): void {
		this.clear();
		this.#selectList = undefined;
		const info = getRoleInfo(role, settings);
		const current = settings.getModelRole(role)?.trim();
		const panel = new ModelSelectorPanel(
			settings,
			this.#registry,
			this.#models,
			{
				title: `${info.name} model`,
				description: `Role \`${role}\` — used when that work type runs. Del or the (inherit) row clears (${info.unsetLabel ?? "inherit main model"}).`,
				currentSelector: barePickerSelector(current, this.#models as Model<Api>[]),
				allowClear: true,
			},
			{
				onPick: (model, selector) => {
					if (!hasConfigurableThinkingEffort(model)) {
						this.#persistRole(role, selector);
						return;
					}
					this.#showEffortPicker(role, selector, model);
					this.requestRender?.();
				},
				onClear: () => {
					settings.setModelRole(role, undefined);
					this.onChange();
					this.#showRoleList();
					this.requestRender?.();
				},
				onCancel: () => {
					this.#showRoleList();
					this.requestRender?.();
				},
			},
		);
		panel.setHoverMotion({ requestRender: () => this.requestRender?.(), enabled: modalRevealEnabled() });
		this.addChild(panel);
	}

	#showEffortPicker(role: string, selector: string, model: Model): void {
		this.#selectList = renderEffortStep(
			this,
			selector,
			model,
			value => this.#persistRole(role, value),
			() => {
				this.#showModelPicker(role);
				this.requestRender?.();
			},
		);
	}

	#persistRole(role: string, value: string): void {
		settings.setModelRole(role, value);
		this.onChange();
		this.#showRoleList();
		this.requestRender?.();
	}

	/** The role list or effort list; the model-picker state targets its panel. */
	mouseTarget(): SelectList | ModelSelectorPanel | undefined {
		return this.#selectList ?? this.#pickerPanel();
	}

	#pickerPanel(): ModelSelectorPanel | undefined {
		return this.children.find((child): child is ModelSelectorPanel => child instanceof ModelSelectorPanel);
	}

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

/**
 * Rows either rule screen shows before it scrolls, and the line above which
 * `SelectList` starts accepting a typed filter query.
 */
const RULE_LIST_MAX_ROWS = 12;

/**
 * Section order on the rule screen, and what each heading says.
 *
 * A rule the project itself supplies comes first: it is the one the reader
 * wrote, and it outranks a bundled rule of the same name anyway. Then the
 * bundled sections in the order the bundle declares them, so the file tree and
 * the screen cannot disagree about order. Experimental is last on purpose —
 * anything above it ships on, and a reader scanning downward should meet the
 * opt-in rules only after everything that is actually running.
 */
const BUNDLED_SECTION_ORDER: readonly BuiltinRuleSection[] = Object.keys(BUILTIN_RULE_SECTIONS) as BuiltinRuleSection[];

function ruleSectionRank(rule: Rule): number {
	if (rule._source?.provider !== BUILTIN_DEFAULTS_PROVIDER_ID) return -1;
	const index = BUNDLED_SECTION_ORDER.indexOf(rule.section as BuiltinRuleSection);
	// A bundled rule whose section is not one we know sorts after every known
	// one rather than silently joining the project group at the top.
	return index < 0 ? BUNDLED_SECTION_ORDER.length : index;
}

/** The heading a rule renders under. */
function ruleSectionLabel(rule: Rule): string {
	if (rule._source?.provider !== BUILTIN_DEFAULTS_PROVIDER_ID) {
		return rule._source?.provider ? `From ${rule._source.provider}` : "From this project";
	}
	const meta = BUILTIN_RULE_SECTIONS[rule.section as BuiltinRuleSection];
	return meta ? `Built-in · ${meta.label}` : "Built-in";
}

/**
 * The rule list: every rule this project loads, each on or off.
 *
 * Backed by `ttsr.disabledRules`, which stores exceptions only. The list itself is
 * DISCOVERED rather than read from that setting, for the same reason the agents table is
 * discovered: a setting that holds only what you turned off describes an empty list on a
 * stock install, so a settings-driven list would show nothing at all while thirty rules
 * were quietly running. Discovery is also the only way to learn the names, and a name is
 * what the old comma-separated text box demanded before it would let you disable
 * anything.
 *
 * Two levels. The index is one row per section; entering a section lists the rules
 * under it, where Enter toggles in place. Thirty-one rules in one flat list made the
 * first screen a wall the reader had to scroll before learning what kinds of rule
 * even exist, and the section a rule sits in is the fact that decides whether it
 * ships on — so the section is worth being a screen rather than a heading.
 */
class RulesSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#rules: Rule[] = [];
	#loadError: string | undefined;
	#loaded = false;
	/** Kept by NAME, not index: toggling re-sorts nothing but re-creates the list. */
	#focused: string | undefined;
	/** The section being browsed, or undefined at the index. Two levels, one field. */
	#openSection: string | undefined;
	/** Which section row to land back on when you leave one. */
	#focusedSection: string | undefined;

	constructor(
		private readonly cwd: string,
		private readonly onChange: () => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#show();
		void this.#load();
	}

	async #load(): Promise<void> {
		try {
			const result = await loadCapability<Rule>(ruleCapability.id, { cwd: this.cwd });
			// First wins by name: providers arrive in priority order and a project rule
			// overriding a bundled one of the same name is ONE rule, shown once, whose
			// toggle governs whichever copy actually loads.
			const byName = new Map<string, Rule>();
			for (const rule of result.items) if (!byName.has(rule.name)) byName.set(rule.name, rule);
			this.#rules = [...byName.values()].sort(
				(a, b) => ruleSectionRank(a) - ruleSectionRank(b) || a.name.localeCompare(b.name),
			);
		} catch (error) {
			// Loud: a partial list reads as "these are all the rules there are", and the
			// reader would turn one off believing the rest do not exist.
			this.#loadError = errorMessage(error);
		}
		this.#loaded = true;
		this.#show();
		this.requestRender?.();
	}

	/** Names currently turned off, trimmed the same way `bucketRules` trims them. */
	#disabled(): Set<string> {
		return this.#nameSet("ttsr.disabledRules");
	}

	/** Experimental rules the operator turned on; empty on a stock install. */
	#enabledExperiments(): Set<string> {
		return this.#nameSet("ttsr.experimentalRules");
	}

	#nameSet(path: "ttsr.disabledRules" | "ttsr.experimentalRules"): Set<string> {
		const stored = settings.get(path);
		const names = Array.isArray(stored) ? stored : [];
		return new Set(names.map(name => String(name).trim()).filter(name => name.length > 0));
	}

	/**
	 * Flip one rule, writing to whichever list expresses "off" for it.
	 *
	 * An experimental rule ships off, so its on-state lives in an opt-in list and
	 * `disabledRules` — which stores exceptions to on — cannot represent it. One
	 * row, one Enter, two backing lists: the operator is told which rules are
	 * experimental by the section they are under, not by having to know which
	 * setting their answer lands in.
	 */
	#toggle(name: string): void {
		const rule = this.#rules.find(candidate => candidate.name === name);
		if (rule?.experimental === true) {
			const enabled = this.#enabledExperiments();
			if (enabled.has(name)) enabled.delete(name);
			else enabled.add(name);
			settings.set("ttsr.experimentalRules", [...enabled].sort());
		} else {
			const disabled = this.#disabled();
			if (disabled.has(name)) disabled.delete(name);
			else disabled.add(name);
			settings.set("ttsr.disabledRules", [...disabled].sort());
		}
		this.onChange();
		this.#focused = name;
		this.#show();
		this.requestRender?.();
	}

	/**
	 * How this rule reaches the model, which decides what turning it off costs.
	 *
	 * The three buckets are `bucketRules`', in its precedence order, so this cannot
	 * describe a rule differently from the funnel that routes it.
	 */
	#kind(rule: Rule): string {
		if ((rule.condition?.length ?? 0) > 0 || (rule.astCondition?.length ?? 0) > 0) return "on match";
		if (rule.alwaysApply === true) return "always";
		if (rule.description) return "on request";
		return "inert";
	}

	/** Whether a rule is currently reaching the model, by the same three levers the funnel reads. */
	#isOff(rule: Rule, disabled: ReadonlySet<string>, experiments: ReadonlySet<string>, builtinOff: boolean): boolean {
		if (disabled.has(rule.name)) return true;
		if (builtinOff && rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) return true;
		// Experimental inverts the question: it is off unless opted in, so its row
		// must read the opt-in list or every one of them would claim "on".
		return rule.experimental === true && !experiments.has(rule.name);
	}

	/** The sections, in render order, each with the rules under it. */
	#sections(): { label: string; rules: Rule[] }[] {
		const sections: { label: string; rules: Rule[] }[] = [];
		for (const rule of this.#rules) {
			const label = ruleSectionLabel(rule);
			const existing = sections.find(section => section.label === label);
			if (existing) existing.rules.push(rule);
			else sections.push({ label, rules: [rule] });
		}
		return sections;
	}

	/**
	 * What a section row says about itself without being opened.
	 *
	 * A two-level list buys a short first screen and costs the at-a-glance answer,
	 * so the count pays it back: an operator scanning the index still learns that
	 * something below is off, and which section to open to find it. Without it the
	 * only way to know would be to enter every one.
	 */
	#sectionSummary(rules: readonly Rule[], off: number): string {
		const total = `${rules.length} rule${rules.length === 1 ? "" : "s"}`;
		if (off === 0) return `${total} · ${theme.fg("success", "all on")}`;
		if (off === rules.length) return `${total} · ${theme.fg("dim", "all off")}`;
		return `${total} · ${theme.fg("dim", `${off} off`)}`;
	}

	#header(subtitle: string): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Rules")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", subtitle), 0, 0));
		this.addChild(new Spacer(1));
		this.#selectList = undefined;
	}

	/** Both warnings apply to every section, so they belong on the screen you always pass through. */
	#warnings(builtinOff: boolean): void {
		if (settings.get("ttsr.enabled") !== true) {
			this.addChild(new Text(theme.fg("warning", "  Rule matching is off (Stream Interrupts → TTSR)."), 0, 0));
			this.addChild(new Spacer(1));
		}
		if (builtinOff) {
			this.addChild(new Text(theme.fg("warning", "  Built-in rules are off, so every bundled rule is."), 0, 0));
			this.addChild(new Spacer(1));
		}
	}

	/**
	 * Build the list plus the footer that describes it.
	 *
	 * The filter hint is conditional because the filter is: `SelectList` accepts a
	 * typed query only while the list overflows its visible rows, and splitting
	 * thirty-one rules across five sections took every one of these lists below
	 * that line. A footer reading "type to filter" over five rows that ignore
	 * every key you press is worse than no hint, so the hint appears exactly when
	 * the list will answer it.
	 */
	#finishList(items: SelectItem[], focused: string | undefined, action: string, back: string): void {
		const visible = clamp(items.length, 1, RULE_LIST_MAX_ROWS);
		// The name column shrinks to the longest name present rather than holding the
		// default 32. A section summary is 17 characters and the fixed column left
		// twelve for it at 96 columns, so the count that justifies collapsing thirty
		// rules into five rows rendered as `4 rules · a…`. The cap is unchanged, so a
		// long project rule name still gets the room it always had.
		this.#selectList = new SelectList(items, visible, getSelectListTheme(), {
			minPrimaryColumnWidth: 1,
			maxPrimaryColumnWidth: 32,
		});
		const focusedIndex = focused ? items.findIndex(item => item.value === focused) : -1;
		if (focusedIndex >= 0) this.#selectList.setSelectedIndex(focusedIndex);
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		const filterHint = items.length > visible ? " · type to filter" : "";
		this.addChild(new Text(theme.fg("dim", `  ${action}${filterHint} · ${back}`), 0, 0));
	}

	#show(): void {
		if (this.#loadError) {
			this.#header("Every rule this project loads.");
			this.addChild(new Text(theme.fg("error", `  Could not read the rule sources: ${this.#loadError}`), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			return;
		}
		if (!this.#loaded) {
			this.#header("Every rule this project loads.");
			this.addChild(new Text(theme.fg("dim", "  Reading rules…"), 0, 0));
			return;
		}
		if (this.#openSection === undefined) this.#showSections();
		else this.#showSection(this.#openSection);
	}

	/** The index: one row per section, so the first screen is five rows rather than thirty-one. */
	#showSections(): void {
		const builtinOff = settings.get("ttsr.builtinRules") !== true;
		this.#header("Rules by section. Enter opens one.");
		this.#warnings(builtinOff);

		const disabled = this.#disabled();
		const experiments = this.#enabledExperiments();
		const sections = this.#sections();
		if (sections.length === 0) {
			this.addChild(new Text(theme.fg("dim", "  No rules found."), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			return;
		}

		const items: SelectItem[] = sections.map(section => {
			const off = section.rules.filter(rule => this.#isOff(rule, disabled, experiments, builtinOff)).length;
			return {
				value: section.label,
				label: section.label,
				description: this.#sectionSummary(section.rules, off),
			};
		});
		this.#finishList(items, this.#focusedSection, "Enter to open", "Esc to go back");
		if (this.#selectList) {
			this.#selectList.onSelect = item => {
				this.#openSection = item.value;
				this.#focusedSection = item.value;
				this.#focused = undefined;
				this.#show();
				this.requestRender?.();
			};
			this.#selectList.onCancel = this.onCancel;
		}
	}

	/** One section's rules. Esc returns to the index rather than leaving the list entirely. */
	#showSection(label: string): void {
		const builtinOff = settings.get("ttsr.builtinRules") !== true;
		const section = this.#sections().find(candidate => candidate.label === label);
		if (!section) {
			// The section went away under us; the index is the only honest screen left.
			this.#openSection = undefined;
			this.#showSections();
			return;
		}
		this.#header(`${label} — Enter turns a rule off, or back on.`);
		this.#warnings(builtinOff);

		const disabled = this.#disabled();
		const experiments = this.#enabledExperiments();
		const items: SelectItem[] = section.rules.map(rule => {
			const state = this.#isOff(rule, disabled, experiments, builtinOff)
				? theme.fg("dim", "off")
				: theme.fg("success", "on");
			const detail = rule.description ? ` · ${collapseWhitespace(rule.description)}` : "";
			return {
				value: rule.name,
				label: rule.name,
				description: `${state} · ${this.#kind(rule)}${detail}`,
			};
		});
		this.#finishList(items, this.#focused, "Enter to toggle", "Esc for sections");
		if (this.#selectList) {
			this.#selectList.onSelect = item => this.#toggle(item.value);
			this.#selectList.onCancel = () => {
				this.#openSection = undefined;
				this.#show();
				this.requestRender?.();
			};
		}
	}

	/** The section/rule list is the only interactive child. */
	mouseTarget(): SelectList | undefined {
		return this.#selectList;
	}

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

/**
 * Row ids inside the per-agent editor. NUL-prefixed for the same reason as
 * {@link ADD_EFFORT_ROW}: an agent may legitimately be named `model`.
 */
const AGENT_ROW_OFFERED = "\u0000agent-offered";
const AGENT_ROW_NESTED = "\u0000agent-nested";
const AGENT_ROW_RESET = "\u0000agent-reset";

/**
 * Row ids for the two settings the roster edits beside the agents themselves:
 * the model and the effort every subagent runs. They appear at the top of the
 * roster list and again inside a per-subagent page, and both spellings write
 * the same setting — the screen that shows what a lane runs is the screen that
 * changes it, because the previous shape showed it and then named a different
 * screen to go and change it on.
 */
const AGENT_ROW_MODEL = "\u0000subagent-model";
const AGENT_ROW_EFFORT = "\u0000subagent-effort";

/** The settings one pass through the roster can write. */
type SubagentRosterPath = "subagent.agents" | "subagent.model" | "subagent.thinkingLevel";

/**
 * What `subagent.thinkingLevel` narrows against, as three distinct answers
 * rather than one nullable model.
 *
 * `model` — a model is named and resolved: the chain head, or the session's own
 * model when no chain is set, because unset means every subagent inherits it.
 * `unresolved` — a model is named and this session has no catalog entry for it
 * (an unauthenticated provider, a pattern matching nothing). Offering a ladder
 * here invents one: the picker says which pattern it cannot read instead.
 * `blanket` — nothing is named at all, so the row spans the catalog and the
 * honest list is the union of what the catalog declares.
 *
 * The three used to be one `Model | undefined`, and undefined fell through to
 * the full vocabulary: `minimal` on a row whose endpoint declares `low, high,
 * max`, and an invented ladder for an id like `cursor-grok-4.6-medium` whose id
 * IS its effort.
 *
 * ONE owner, because two screens narrow the same ladder: the tab's Subagent
 * Effort row and the roster's Effort row. Two copies would drift into offering
 * different levels for one setting.
 */
type SubagentEffortScope =
	| { kind: "model"; model: Model }
	| { kind: "unresolved"; pattern: string }
	| { kind: "blanket" };

/**
 * The scope one resolved model pattern implies. Separate from the blanket-row
 * reader below because a lane resolves its own head, and the narrowing rule
 * must be identical for both or the two screens offer different ladders.
 */
function effortScopeForPattern(
	models: ReadonlyArray<Model> | undefined,
	head: string | undefined,
	sessionModel: Model | undefined,
): SubagentEffortScope {
	if (!head) return sessionModel ? { kind: "model", model: sessionModel } : { kind: "blanket" };
	const bare = models ? barePickerSelector(head, models as Model<Api>[]) : head;
	const found = models?.find(candidate => `${candidate.provider}/${candidate.id}` === bare);
	return found ? { kind: "model", model: found } : { kind: "unresolved", pattern: head };
}

function subagentEffortScope(
	models: ReadonlyArray<Model> | undefined,
	sessionModel: Model | undefined,
): SubagentEffortScope {
	return effortScopeForPattern(
		models,
		resolveConfiguredModelPatterns(settings.get("subagent.model"), settings)[0],
		sessionModel,
	);
}

/** The picker rows and the sentence that explains a short list, from one scope. */
function subagentEffortOptions(
	scope: SubagentEffortScope,
	catalog: ReadonlyArray<Model> | undefined,
): { options: Array<{ value: string; label: string; description: string }>; notice: string | undefined } {
	if (scope.kind === "unresolved") {
		return {
			options: configuredThinkingLevelOptions({
				inheritLabel: "Inherit",
				inheritDescription: "Follow the session's effort",
			}).map(option => ({ ...option })),
			notice: `No model in this session matches \`${scope.pattern}\`, so its effort levels are unknown. Inherit is the only choice that means anything until the chain resolves.`,
		};
	}
	const options = configuredThinkingLevelOptions({
		model: scope.kind === "model" ? scope.model : undefined,
		scope: scope.kind === "blanket" ? catalog : undefined,
		inheritLabel: "Inherit",
		inheritDescription: "Follow the session's effort",
	}).map(option => ({ ...option }));
	if (options.length > 1) return { options, notice: undefined };
	return {
		options,
		notice:
			scope.kind === "model"
				? noSelectableEffortNotice()
				: "No model in this session declares a selectable effort, so only Inherit applies.",
	};
}

/**
 * Whether a lane at `depth` may run, with the default applied.
 *
 * `depth` is the lane's index in the chain, and lane index `i` is the process
 * at task depth `i + 1`, so a lane runs exactly when the level above it may
 * spawn — {@link canSpawnAtDepth} against the cap that governs this agent.
 * Unset is NOT off: it is the blanket ceiling still answering, which is why a
 * stock roster shows the nested level off and a config that raised the ceiling
 * shows it on without anything being written per agent.
 *
 * Stated once here because the page, the summary row and the resolver all need
 * the same answer, and a hardcoded "off below the first level" gave the page a
 * different one than the spawn gate.
 */
function laneSpawnEnabled(lane: SubagentLaneSettings, depth: number, resolvedMax: number): boolean {
	return lane.enabled ?? canSpawnAtDepth(resolvedMax, depth);
}

/** The settings path of one lane, which is what a page names when it clears itself. */
function lanePath(name: string, depth: number): string {
	return `subagent.agents.${name}${".subagents".repeat(depth)}`;
}

/**
 * One lane with its empty fields dropped, or undefined when nothing is left.
 *
 * A lane that stores only `{}` — or only `{ subagents: {} }` — is a row that
 * reads as configured to everything that checks for one, while deciding nothing.
 * Pruning bottom-up is what lets a page be opened, looked at, and left without
 * writing anything.
 */
function pruneLane(lane: SubagentLaneSettings): SubagentLaneSettings | undefined {
	const cleaned: SubagentLaneSettings = {};
	if (lane.enabled !== undefined) cleaned.enabled = lane.enabled;
	if (lane.model !== undefined && (Array.isArray(lane.model) ? lane.model.length > 0 : lane.model.trim().length > 0)) {
		cleaned.model = lane.model;
	}
	if (lane.thinkingLevel !== undefined && lane.thinkingLevel.trim().length > 0) {
		cleaned.thinkingLevel = lane.thinkingLevel;
	}
	const child = lane.subagents === undefined ? undefined : pruneLane(lane.subagents);
	if (child !== undefined) cleaned.subagents = child;
	// The pre-tree number survives only while there is no chain. It still decides
	// in that state, so dropping it on an unrelated toggle would silently change
	// the ceiling; once a chain exists it decides nothing, and leaving it behind
	// is a dead value in the operator's file that once did.
	if (lane.maxNestedSpawnDepth !== undefined && child === undefined) {
		cleaned.maxNestedSpawnDepth = lane.maxNestedSpawnDepth;
	}
	return Object.keys(cleaned).length === 0 ? undefined : cleaned;
}

/**
 * The `subagent.agents` table: the discovered agents, each with what it runs and
 * what it may spawn.
 *
 * Every answer comes from `task/subagent-settings.ts` — the enable default, the
 * state wording, the model precedence and the layer that decided it — so this and
 * `/agents` cannot describe the same row differently. It edits settings rows only;
 * writing an agent FILE stays in `/agents`, which is why the footer points there.
 *
 * A lane is RECURSIVE and every page has the same shape: Enabled, Model, Effort,
 * and a door to what this lane may spawn. Open `deep`, and you are setting what
 * `deep` runs; open its `Subagents` row and you are setting what `deep` spawns,
 * with `inherit` meaning the page you came from. There is no ceiling: the chain
 * goes as deep as levels are turned on, and `Subagents → Enabled` IS the depth
 * limit, which is why no numeric row sits beside it.
 *
 * The hazard this shape has to keep answering: a per-agent model once outranked
 * the blanket setting from a screen that did not show it, and two screens gave
 * different answers for one agent. The rule that fixes it is not "no per-agent
 * layer" but "the page that SHOWS a value CHANGES that value" — every row here
 * edits the lane it is drawn on, and the badge names the exact path that decided.
 *
 * The list is discovered rather than read off the stored table: a row exists only
 * once something is overridden, so a table-driven list would be empty on a stock
 * install and would hide exactly the specialists the operator came to turn on.
 */
class SubagentAgentsSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#agents: AgentDefinition[] = [];
	#loadError: string | undefined;
	#loaded = false;
	/** Where Esc goes while a message page (no list) is on screen. */
	#escapeTo: (() => void) | undefined;

	constructor(
		private readonly cwd: string,
		/** The session's live model, so an inheriting row shows what it will actually run. */
		private readonly activeModelPattern: string | undefined,
		/** The session's model, used to narrow the effort ladder when no chain is set. */
		private readonly sessionModel: Model | undefined,
		/**
		 * Every model this session knows. Narrowing an effort ladder needs only
		 * this; the chain picker below additionally needs a registry, and a host
		 * with models but no registry must still show the right levels.
		 */
		private readonly models: ReadonlyArray<Model> | undefined,
		/** Catalog plus registry for the model chain picker; absent in hosts with no model list. */
		private readonly picker: { registry: ModelRegistry; models: ReadonlyArray<Model> } | undefined,
		private readonly onChange: (path: SubagentRosterPath) => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showAgentList();
		void this.#load();
	}

	async #load(): Promise<void> {
		try {
			const { agents } = await discoverAgents(this.cwd);
			this.#agents = [...agents].sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			// Loud: a discovery failure means the list is incomplete, and quietly
			// showing a short list reads as "these are all the agents there are".
			this.#loadError = errorMessage(error);
		}
		this.#loaded = true;
		this.#showAgentList();
		this.requestRender?.();
	}

	/** The stored table, always an object so callers can spread it. */
	#table(): Record<string, SubagentAgentSettings> {
		const stored = settings.get("subagent.agents");
		return stored && typeof stored === "object" ? ({ ...stored } as Record<string, SubagentAgentSettings>) : {};
	}

	#row(name: string): SubagentAgentSettings {
		return { ...subagentSettingsFor(settings, name) };
	}

	/**
	 * The lane a page is showing: `[]` is the agent's own page, `["subagents"]`
	 * the page for what it may spawn, and one more step per level below that.
	 *
	 * A level the operator has not opened yet does not exist in the file, so this
	 * answers with an empty lane rather than undefined: the page renders the
	 * defaults, and nothing is written until something is chosen.
	 */
	#lane(name: string, depth: number): SubagentLaneSettings {
		let lane: SubagentLaneSettings = this.#row(name);
		for (let step = 0; step < depth; step++) lane = lane.subagents ?? {};
		return { ...lane };
	}

	/**
	 * Write one lane back into its agent's row, rebuilding the chain above it.
	 *
	 * Empty fields and empty lanes are dropped on the way up, and a row left with
	 * nothing is deleted: an empty row and no row must not be distinguishable,
	 * because a bare `{}` in the file reads as "configured" to anything checking
	 * for a row.
	 */
	#writeLane(name: string, depth: number, next: SubagentLaneSettings): void {
		const chain: SubagentLaneSettings[] = [];
		let lane: SubagentLaneSettings = this.#row(name);
		for (let step = 0; step < depth; step++) {
			chain.push(lane);
			lane = lane.subagents ?? {};
		}
		let rebuilt = pruneLane(next);
		for (let step = chain.length - 1; step >= 0; step--) {
			rebuilt = pruneLane({ ...chain[step], subagents: rebuilt });
		}

		const table = this.#table();
		if (rebuilt === undefined) delete table[name];
		else table[name] = rebuilt;
		settings.set("subagent.agents", table);
		this.onChange("subagent.agents");
	}

	/** One agent's model column: the resolved pattern plus the layer that chose it. */
	#modelSummary(agent: AgentDefinition, depth = 0): string {
		// `taskDepth` is the depth a SPAWN runs at, and a lane page describes exactly
		// one: the agent's own page is a direct child (depth 1), each level down is
		// one deeper. Passing it is what makes the badge name the lane that decided
		// rather than the table.
		const resolved = resolveSubagentModel({
			settings,
			agentName: agent.name,
			agentModel: agent.model,
			activeModelPattern: this.activeModelPattern,
			taskDepth: depth + 1,
		});
		if (resolved.unresolved) return theme.fg("error", `${resolved.unresolved.value} matches no model`);
		const pattern = resolved.patterns[0];
		if (!pattern) return theme.fg("dim", "no model resolved");
		// The column used to print `patterns[0]` and drop the rest, so an agent
		// with three configured models looked identical to one with a single
		// model and there was no way to tell a chain had been configured at all.
		const fallbacks = resolved.patterns.length - 1;
		const summary =
			fallbacks > 0
				? `${formatSelectorSummary(pattern)} ${theme.fg("dim", `+${fallbacks} fallback${fallbacks === 1 ? "" : "s"}`)}`
				: formatSelectorSummary(pattern);
		return resolved.source === "inherit"
			? theme.fg("dim", `inherit · ${summary}`)
			: `${summary} ${theme.fg("dim", `· ${subagentModelSourceLabel(resolved.source, agent.name, resolved.depth)}`)}`;
	}

	/**
	 * One lane's Model row: what it stores, or the level it inherits from.
	 *
	 * The stored value rather than the resolved one, because this row EDITS the
	 * stored value — a row showing a resolved answer it does not own is how a
	 * screen comes to look configured when it has not been.
	 */
	#laneModelSummary(lane: SubagentLaneSettings, depth: number): string {
		const chain = lane.model;
		if (chain === undefined || (Array.isArray(chain) ? chain.length === 0 : chain.trim().length === 0)) {
			return theme.fg("dim", depth === 0 ? "inherit · the session's model" : "inherit · the level above");
		}
		const entries = Array.isArray(chain) ? chain : [chain];
		const head = entries[0] ?? "";
		const fallbacks = entries.length - 1;
		return fallbacks > 0
			? `${formatSelectorSummary(head)} ${theme.fg("dim", `+${fallbacks} fallback${fallbacks === 1 ? "" : "s"}`)}`
			: formatSelectorSummary(head);
	}

	/** One lane's Effort row, on the same stored-not-resolved rule as the model. */
	#laneEffortSummary(lane: SubagentLaneSettings, depth: number): string {
		const level = lane.thinkingLevel?.trim() ?? "";
		return level.length > 0
			? level
			: theme.fg("dim", depth === 0 ? "inherit · the session's effort" : "inherit · the level above");
	}

	/**
	 * What this lane will actually run, as one read-only line: the resolved model
	 * with the layer that chose it, plus the effort resolved on its own axis. The
	 * rows below EDIT this lane, so the line previews their effect rather than
	 * pointing at another screen.
	 */
	#runsSummary(agent: AgentDefinition, depth = 0): string {
		const model = this.#modelSummary(agent, depth);
		const head = resolveSubagentModel({
			settings,
			agentName: agent.name,
			agentModel: agent.model,
			activeModelPattern: this.activeModelPattern,
			taskDepth: depth + 1,
		}).patterns[0];
		// A `:level` suffix on the pattern already prints inside the model summary,
		// and it outranks every effort layer, so printing a layer's answer beside it
		// would show two efforts for one agent.
		if (head && extractExplicitThinkingSelector(head, settings) !== undefined) return model;
		const effort = resolveSubagentThinkingLevel({
			settings,
			agentName: agent.name,
			agentThinkingLevel: agent.thinkingLevel,
			taskDepth: depth + 1,
		});
		return `${model} ${theme.fg("dim", `· ${effort ?? "inherited"} effort`)}`;
	}

	#showAgentList(): void {
		this.clear();
		this.#escapeTo = undefined;
		this.addChild(new Text(theme.bold(theme.fg("accent", "Subagents")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Which subagent types this session offers, and what they all run. The first two rows are the model and the effort every subagent uses; the rest are the lanes.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.#selectList = undefined;

		if (this.#loadError) {
			this.addChild(new Text(theme.fg("error", `  Could not read the agent directories: ${this.#loadError}`), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			return;
		}
		if (!this.#loaded) {
			this.addChild(new Text(theme.fg("dim", "  Reading subagents…"), 0, 0));
			return;
		}

		// Whether this table has any effect is decided by `subagent.delegation` as
		// well, and that setting is a row the reader is not looking at right now. So
		// the panel says when nothing will be delegated, from the one resolver that
		// reads both — the same sentence `/agents` shows, for the same reason.
		const blocked = delegationBlockedNotice(
			resolveDelegation(
				settings,
				this.#agents
					.filter(agent => subagentEnableState(agent, this.#row(agent.name).enabled) === "on")
					.map(agent => agent.name),
			),
		);
		if (blocked) {
			this.addChild(new Text(theme.fg("warning", `  ${blocked}`), 0, 0));
			this.addChild(new Spacer(1));
		}

		// The two settings that decide what a lane RUNS come first, because that is
		// the question the roster raises and it used to be answered on another
		// screen. They are the blanket settings, not a per-agent copy.
		const items: SelectItem[] = [
			{
				value: AGENT_ROW_MODEL,
				label: "Model",
				description: `every subagent · ${this.#blanketModelSummary()}`,
			},
			{
				value: AGENT_ROW_EFFORT,
				label: "Effort",
				description: `every subagent · ${this.#blanketEffortSummary()}`,
			},
			...this.#agents.map(agent => ({
				value: agent.name,
				label: agent.name,
				description: `${SUBAGENT_ENABLE_STATE_LABEL[subagentEnableState(agent, this.#row(agent.name).enabled)]} · ${this.#modelSummary(agent)}`,
			})),
		];
		// A session that discovered no lanes still has a model and an effort every
		// spawn would use, so the note goes ABOVE the rows rather than replacing
		// them: an early return here left the reader on a screen with nothing on it.
		if (this.#agents.length === 0) {
			this.addChild(new Text(theme.fg("dim", "  No subagent types found."), 0, 0));
			this.addChild(new Spacer(1));
		}

		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === AGENT_ROW_MODEL) this.#showModelPicker(() => this.#showAgentList());
			else if (item.value === AGENT_ROW_EFFORT) this.#showEffortPicker(() => this.#showAgentList());
			else this.#showAgentEditor(item.value);
			this.requestRender?.();
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);

		// The highlighted agent's own description, under the list rather than beside
		// the name. This is the screen where you decide which lanes to offer, and it
		// used to show only on/off and a model, so the one thing you needed to make
		// that decision, what each lane is FOR, was the one thing missing. Inline it
		// arrives cut, and wrapping it into the row costs three rows per agent, so
		// six agents would no longer fit on screen at once.
		const detail = new Text(this.#detailText(items[0]?.value), 0, 0);
		this.#selectList.onSelectionChange = item => {
			if (detail.setText(this.#detailText(item.value))) this.requestRender?.();
		};
		this.addChild(new Spacer(1));
		this.addChild(detail);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("dim", "  Enter to configure · /agents to write agent files · Esc to go back"), 0, 0),
		);
	}

	#agent(name: string): AgentDefinition | undefined {
		return this.#agents.find(candidate => candidate.name === name);
	}

	/** The highlighted row's own line: what that lane is for, or what a setting does. */
	#detailText(name: string | undefined): string {
		if (name === AGENT_ROW_MODEL) {
			return theme.fg(
				"muted",
				"  The model chain every subagent runs. Unset means they follow this session's model.",
			);
		}
		if (name === AGENT_ROW_EFFORT) {
			return theme.fg(
				"muted",
				"  The thinking effort every subagent runs at. Inherit follows this session's effort.",
			);
		}
		const description = name ? this.#agent(name)?.description?.trim() : undefined;
		return description ? theme.fg("muted", `  ${description}`) : "";
	}

	/** The blanket model chain, as the roster's own row shows it. */
	#blanketModelSummary(): string {
		const chain = normalizeModelPatternList(settings.get("subagent.model"));
		const head = chain[0];
		if (!head) return theme.fg("dim", `inherit · ${this.activeModelPattern ?? "session model"}`);
		const fallbacks = chain.length - 1;
		return fallbacks > 0
			? `${formatSelectorSummary(head)} ${theme.fg("dim", `+${fallbacks} fallback${fallbacks === 1 ? "" : "s"}`)}`
			: formatSelectorSummary(head);
	}

	/** The blanket effort, or the word for having none. */
	#blanketEffortSummary(): string {
		const stored = settings.get("subagent.thinkingLevel");
		const level = typeof stored === "string" ? stored.trim() : "";
		return level.length > 0 ? level : theme.fg("dim", "inherit");
	}

	/**
	 * One lane's page. `depth` 0 is the agent itself; each step down is one
	 * `Subagents` row followed, and the page shape never changes.
	 */
	#showAgentEditor(name: string, depth = 0): void {
		const agent = this.#agent(name);
		if (!agent) {
			this.#showAgentList();
			return;
		}
		const lane = this.#lane(name, depth);
		const child = lane.subagents ?? {};
		// The cap this agent's whole tree runs under, asked once: every default on
		// this page is read off it, so the page cannot claim a level the spawn gate
		// would refuse.
		const resolvedMax = resolveSubagentMaxNestedSpawnDepth(settings, name);
		const spawnAllowed = laneSpawnEnabled(child, depth + 1, resolvedMax);

		this.clear();
		this.#escapeTo = undefined;
		// The trail, not just the name: three levels down, "Subagent: deep" alone
		// cannot say which of the three pages you are on.
		const trail = depth === 0 ? `Subagent: ${name}` : `${name}${" › subagents".repeat(depth)}`;
		this.addChild(new Text(theme.bold(theme.fg("accent", trail)), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					depth === 0
						? agent.description || `${agent.source} subagent`
						: `What ${depth === 1 ? name : "this lane"} may spawn. Unset follows the level above.`,
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		// What this lane runs, resolved, above the rows that change it — and the
		// rows below change THIS lane, so the reader is never sent elsewhere to
		// edit the value they are looking at.
		this.addChild(new Text(`  ${theme.fg("muted", "Runs")} ${this.#runsSummary(agent, depth)}`, 0, 0));
		this.addChild(new Spacer(1));
		const items: SelectItem[] = [
			{
				value: AGENT_ROW_OFFERED,
				label: "Enabled",
				// At depth 0 this is whether the model may choose the agent. Below it,
				// whether this lane may run at all — which IS the depth limit, so no
				// number sits beside it to disagree with.
				// "(default)" is a provenance hint and nothing more: it says the row has
				// not been chosen yet, never that the lane behaves differently.
				description:
					depth === 0
						? `${SUBAGENT_ENABLE_STATE_LABEL[subagentEnableState(agent, lane.enabled)]}${
								isSubagentEnableDefaulted(lane.enabled) ? theme.fg("dim", " (default)") : ""
							}`
						: `${laneSpawnEnabled(lane, depth, resolvedMax) ? "on" : "off"}${
								lane.enabled === undefined ? theme.fg("dim", " (default)") : ""
							}`,
			},
			{
				value: AGENT_ROW_MODEL,
				label: "Model",
				description: this.#laneModelSummary(lane, depth),
			},
			{
				value: AGENT_ROW_EFFORT,
				label: "Effort",
				description: this.#laneEffortSummary(lane, depth),
			},
			{
				value: AGENT_ROW_NESTED,
				label: "Subagents",
				description: spawnAllowed
					? this.#laneModelSummary(child, depth + 1)
					: theme.fg("dim", "off · this lane may not spawn"),
			},
		];
		if (Object.keys(lane).length > 0) {
			items.push({
				value: AGENT_ROW_RESET,
				label: "Reset to defaults",
				description: theme.fg("dim", `clears ${lanePath(name, depth)}`),
			});
		}

		this.#selectList = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		this.#selectList.onSelect = item => {
			switch (item.value) {
				case AGENT_ROW_OFFERED:
					this.#writeLane(
						name,
						depth,
						depth === 0
							? { ...lane, enabled: nextSubagentEnableValue(agent, lane.enabled) }
							: { ...lane, enabled: !laneSpawnEnabled(lane, depth, resolvedMax) },
					);
					this.#showAgentEditor(name, depth);
					break;
				case AGENT_ROW_MODEL:
					this.#showLaneModelPicker(name, depth);
					break;
				case AGENT_ROW_EFFORT:
					this.#showLaneEffortPicker(name, depth);
					break;
				case AGENT_ROW_NESTED:
					this.#showAgentEditor(name, depth + 1);
					break;
				case AGENT_ROW_RESET:
					this.#writeLane(name, depth, {});
					this.#showAgentEditor(name, depth);
					break;
			}
			this.requestRender?.();
		};
		this.#selectList.onCancel = () => {
			// Up one level, not out: three pages deep, Esc landing on the roster
			// would throw away the trail the operator walked.
			if (depth === 0) this.#showAgentList();
			else this.#showAgentEditor(name, depth - 1);
			this.requestRender?.();
		};
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to change · Esc to go back"), 0, 0));
	}

	/**
	 * One lane's model chain, edited through the SAME chain editor every other
	 * model surface uses ({@link ModelChainSubmenu}) — handed a writer instead of
	 * a settings key, because a lane lives inside the `subagent.agents` record
	 * and only that record's owner can prune the chain of lanes above it.
	 */
	#showLaneModelPicker(name: string, depth: number): void {
		this.clear();
		this.#selectList = undefined;
		const back = () => this.#showAgentEditor(name, depth);
		this.#escapeTo = back;
		if (!this.picker) {
			this.addChild(new Text(theme.fg("warning", "Model catalog unavailable in this context"), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			return;
		}
		const lane = this.#lane(name, depth);
		this.addChild(
			new ModelChainSubmenu(
				{
					write: chain => {
						const next = { ...this.#lane(name, depth) };
						if (chain === undefined) delete next.model;
						else next.model = chain;
						this.#writeLane(name, depth, next);
					},
				},
				this.picker.registry,
				this.picker.models,
				depth === 0 ? `Model · ${name}` : `Model · what ${name} spawns${" (nested)".repeat(depth - 1)}`,
				lane.model,
				() => {
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
				() => this.onChange("subagent.agents"),
				this.requestRender,
			),
		);
	}

	/**
	 * One lane's effort, narrowed to what the model THIS lane resolves to
	 * declares. Never the configuration vocabulary: a level no endpoint in scope
	 * accepts is stored, clamped away, and looks like the picker did nothing.
	 */
	#showLaneEffortPicker(name: string, depth: number): void {
		this.clear();
		this.#selectList = undefined;
		const back = () => this.#showAgentEditor(name, depth);
		this.#escapeTo = back;
		const lane = this.#lane(name, depth);
		const { options, notice } = subagentEffortOptions(this.#laneEffortScope(name, depth), this.models);
		const description =
			notice === undefined
				? depth === 0
					? `Effort ${name} runs at. Inherit follows the session's effort; a \`:level\` on the model chain still wins.`
					: "Effort this lane runs at. Inherit follows the level above."
				: `Effort this lane runs at. ${notice}`;
		this.addChild(
			new SelectSubmenu(
				depth === 0 ? `Effort · ${name}` : `Effort · what ${name} spawns`,
				description,
				options,
				lane.thinkingLevel?.trim() ?? "",
				value => {
					// Inherit is the ABSENCE of a value: storing the empty string would
					// leave the lane configured and reading as a choice nobody made.
					const next = { ...this.#lane(name, depth) };
					if (value === INHERIT_EFFORT_OPTION_VALUE) delete next.thinkingLevel;
					else next.thinkingLevel = value;
					this.#writeLane(name, depth, next);
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
				() => {
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
			),
		);
	}

	/**
	 * What this lane's effort narrows against: the model the lane RESOLVES to,
	 * found by asking the same resolver a spawn asks, so the page and the spawn
	 * cannot disagree about which ladder is on screen.
	 */
	#laneEffortScope(name: string, depth: number): SubagentEffortScope {
		const head = resolveSubagentModel({
			settings,
			agentName: name,
			activeModelPattern: this.activeModelPattern,
			taskDepth: depth + 1,
		}).patterns[0];
		return effortScopeForPattern(this.models, head, this.sessionModel);
	}

	/**
	 * The blanket model chain, edited through the SAME picker the tab row opens
	 * ({@link ModelChainSubmenu} bound to `subagent.model`). A second chain editor
	 * here is how two screens would start disagreeing about one value.
	 */
	#showModelPicker(back: () => void): void {
		this.clear();
		this.#selectList = undefined;
		this.#escapeTo = back;
		if (!this.picker) {
			this.addChild(new Text(theme.fg("warning", "Model catalog unavailable in this context"), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			return;
		}
		const stored: unknown = settings.get("subagent.model");
		let current: string | string[] | undefined;
		if (typeof stored === "string") current = stored;
		else if (Array.isArray(stored) && stored.every(entry => typeof entry === "string")) current = stored;
		this.addChild(
			new ModelChainSubmenu(
				"subagent.model",
				this.picker.registry,
				this.picker.models,
				"Subagent Model · every subagent",
				current,
				() => {
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
				() => this.onChange("subagent.model"),
				this.requestRender,
			),
		);
	}

	/**
	 * The blanket effort, narrowed by the same scope helper the tab row uses, so
	 * the two lists cannot offer different levels — and neither offers a level
	 * nothing in scope declares.
	 *
	 * The catalog comes from `models`, not from the chain picker's context: that
	 * context also needs a registry, and gating the ladder on it made the effort
	 * list fall back to a vocabulary in a session whose models were right there.
	 */
	#showEffortPicker(back: () => void): void {
		this.clear();
		this.#selectList = undefined;
		this.#escapeTo = back;
		const { options, notice } = subagentEffortOptions(
			subagentEffortScope(this.models, this.sessionModel),
			this.models,
		);
		const stored = settings.get("subagent.thinkingLevel");
		const current = typeof stored === "string" ? stored.trim() : "";
		const description =
			notice === undefined
				? "Effort for every subagent. Inherit follows the session's effort; a `:level` on the model chain still wins."
				: `Effort for every subagent. ${notice}`;
		this.addChild(
			new SelectSubmenu(
				"Subagent Effort · every subagent",
				description,
				options,
				current,
				value => {
					// Inherit is the ABSENCE of a value: storing the empty string would
					// leave the key configured and reading as a choice nobody made.
					if (value === INHERIT_EFFORT_OPTION_VALUE) settings.unset("subagent.thinkingLevel");
					else settings.set("subagent.thinkingLevel", value);
					this.onChange("subagent.thinkingLevel");
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
				() => {
					this.#escapeTo = undefined;
					back();
					this.requestRender?.();
				},
			),
		);
	}

	/** The list on screen, or the picker that owns the frame while one is open. */
	mouseTarget(): SelectList | ModelChainSubmenu | SelectSubmenu | undefined {
		if (this.#selectList) return this.#selectList;
		return this.children.find(
			(child): child is ModelChainSubmenu | SelectSubmenu =>
				child instanceof ModelChainSubmenu || child instanceof SelectSubmenu,
		);
	}

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		// A message page (no catalog, a discovery failure) has no child that reads
		// input, so Esc would strand the reader on it.
		if (this.#escapeTo && (matchesKey(data, "escape") || data === "\x1b")) {
			const back = this.#escapeTo;
			this.#escapeTo = undefined;
			back();
			this.requestRender?.();
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

/**
 * Submenu rows whose options are efforts, filled from the model in scope rather
 * than the schema.
 *
 * ONE owner, because two places read it: the row's option list and the sentence
 * that explains a one-row list. Those disagreeing is exactly how this screen came
 * to narrow correctly and then say nothing about why, so a row added here gets
 * both behaviours or neither.
 */
const EFFORT_SUBMENU_PATHS: Readonly<Record<string, true>> = { "subagent.thinkingLevel": true };

/** Synthetic list id for the "add a model" row: not a settings key, and never a
 *  model selector, so it cannot collide with a real row. */
const ADD_EFFORT_ROW = "\u0000add-effort-row";

/**
 * Synthetic list ids for the model-chain picker, on the same NUL-prefixed rule
 * as the row above: a model selector can never start with NUL, so an action row
 * can never be mistaken for a chain entry.
 */
const CHAIN_ENTRY_PREFIX = "\u0000chain-entry:";
const CHAIN_ADD_ROW = "\u0000chain-add-row";
const CHAIN_CLEAR_ROW = "\u0000chain-clear-row";

/**
 * The profile's Default Effort list: rows of model to effort, plus one "any
 * model" row that covers every model without its own.
 *
 * This is the ONE persisted effort surface. Effort used to be split across a
 * profile-wide `defaultThinkingLevel` enum and a `:level` suffix on each role's
 * selector, so two settings wrote one axis and neither said which won.
 * `config/effort-resolver.ts` owns the ordering; this owns the editing. Adding a
 * row reuses the same searchable model picker and the same effort list the role
 * slots use, so a third effort vocabulary cannot appear here.
 */
class DefaultEffortSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;

	constructor(
		private readonly models: ReadonlyArray<Model>,
		private readonly registry: ModelRegistry,
		private readonly onChange: () => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showRows();
	}

	/** The stored rows, with a legacy global default folded in as the `*` row. */
	#rows(): Record<string, string> {
		return withLegacyDefaultEffort(
			settings.isConfigured("defaultEffort") ? settings.get("defaultEffort") : undefined,
			settings.get("defaultThinkingLevel"),
		);
	}

	#showRows(): void {
		this.clear();
		this.#selectList = undefined;
		this.addChild(new Text(theme.bold(theme.fg("accent", "Default Effort")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Effort applied when a run does not ask for one. A model's own row wins over the any-model row. Per active profile.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const rows = this.#rows();
		// The any-model row sorts first: it is the one every model falls back to,
		// so reading the list top-down reads as "generally this, except these".
		const keys = Object.keys(rows).sort((a, b) =>
			a === ANY_MODEL_EFFORT_KEY ? -1 : b === ANY_MODEL_EFFORT_KEY ? 1 : a.localeCompare(b),
		);
		const items: SelectItem[] = keys.map(key => ({
			value: key,
			label: key === ANY_MODEL_EFFORT_KEY ? "any model" : key,
			description: rows[key] ?? "",
		}));
		items.push({ value: ADD_EFFORT_ROW, label: "Add a model…", description: "pick a model, then its effort" });
		items.push({
			value: ANY_MODEL_EFFORT_KEY,
			label: rows[ANY_MODEL_EFFORT_KEY] === undefined ? "Set the any-model effort…" : "Change the any-model effort…",
			description: "applies to every model without its own row",
		});

		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === ADD_EFFORT_ROW) {
				this.#showModelPicker();
			} else {
				this.#showEffortPicker(item.value);
			}
			this.requestRender?.();
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to edit · Del removes a row · Esc to go back"), 0, 0));
	}

	#showModelPicker(): void {
		this.clear();
		this.#selectList = undefined;
		const panel = new ModelSelectorPanel(
			settings,
			this.registry,
			this.models,
			{
				title: "Default effort for which model",
				description: "Pick the model, then its effort. Already-listed models are edited from the list itself.",
				allowClear: false,
			},
			{
				// The picker's `selector` argument is deliberately ignored: the bare
				// `provider/id` is the row key, an effort belongs in the row's VALUE, and a
				// selector arriving with `:level` attached must not become a second key
				// meaning the same model.
				onPick: model => {
					this.#showEffortPicker(`${model.provider}/${model.id}`, model);
					this.requestRender?.();
				},
				onCancel: () => {
					this.#showRows();
					this.requestRender?.();
				},
			},
		);
		panel.setHoverMotion({ requestRender: () => this.requestRender?.(), enabled: modalRevealEnabled() });
		this.addChild(panel);
	}

	#showEffortPicker(key: string, picked?: Model): void {
		const model = picked ?? this.models.find(m => `${m.provider}/${m.id}` === key);
		this.#selectList = renderEffortStep(
			this,
			key === ANY_MODEL_EFFORT_KEY ? "any model" : key,
			key === ANY_MODEL_EFFORT_KEY ? undefined : model,
			value => this.#persist(key, value),
			() => {
				this.#showRows();
				this.requestRender?.();
			},
			// The any-model row spans the catalog, so its rows are the union of what
			// the catalog declares — never the vocabulary constant.
			key === ANY_MODEL_EFFORT_KEY ? this.models : undefined,
		);
	}

	/**
	 * Write a row. `renderEffortStep` hands back a model selector carrying the
	 * chosen effort as a `:level` suffix (its other callers store exactly that
	 * string), so the level is split back out here: this list stores the effort in
	 * the row's value, and an empty choice means "no row", which removes it.
	 */
	#persist(key: string, selectorWithEffort: string): void {
		const level = extractExplicitThinkingSelector(selectorWithEffort, settings);
		const rows = { ...this.#rows() };
		if (level === undefined) delete rows[key];
		else rows[key] = level;
		settings.set("defaultEffort", rows);
		this.onChange();
		this.#showRows();
		this.requestRender?.();
	}

	#removeSelectedRow(): void {
		const selected = this.#selectList?.getSelectedItem?.();
		const key = selected?.value;
		if (!key || key === ADD_EFFORT_ROW) return;
		const rows = { ...this.#rows() };
		if (rows[key] === undefined) return;
		delete rows[key];
		settings.set("defaultEffort", rows);
		this.onChange();
		this.#showRows();
		this.requestRender?.();
	}

	/** The effort rows list; the model-picker state targets its panel. */
	mouseTarget(): SelectList | ModelSelectorPanel | undefined {
		return (
			this.#selectList ??
			this.children.find((child): child is ModelSelectorPanel => child instanceof ModelSelectorPanel)
		);
	}

	handleInput(data: string): void {
		if (this.#selectList && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
			this.#removeSelectedRow();
			return;
		}
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

/**
 * Single-slot picker for the profile's DEFAULT model, the model each new
 * session starts on. Opens straight to the model picker because there is only
 * one slot, then persists a bare selector to the `default` model-role slot via
 * {@link Settings.setPersistedModelRole}. Default Effort is the one persisted
 * effort surface for the main model; this picker must not create a competing
 * suffix. Del clears the saved pin without rewriting a session override.
 */
class DefaultModelSubmenu extends MouseRoutedSubmenu {
	constructor(
		private readonly models: ReadonlyArray<Model>,
		private readonly registry: ModelRegistry,
		private readonly onChange: () => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showModelPicker();
	}

	#showModelPicker(): void {
		this.clear();
		const current = settings.getPersistedModelRole(DEFAULT_MODEL_SLOT)?.trim();
		const panel = new ModelSelectorPanel(
			settings,
			this.registry,
			this.models,
			{
				title: "Default model",
				description: "The model each new session starts on. Clearing the pin auto-selects on launch.",
				currentSelector: barePickerSelector(current, this.models as Model<Api>[]),
				allowClear: true,
				clearLabel: "(auto-select on launch)",
			},
			{
				onPick: (_model, selector) => this.#persist(selector),
				onClear: () => {
					settings.setPersistedModelRole(DEFAULT_MODEL_SLOT, undefined);
					this.onChange();
					this.onCancel();
				},
				onCancel: () => this.onCancel(),
			},
		);
		panel.setHoverMotion({ requestRender: () => this.requestRender?.(), enabled: modalRevealEnabled() });
		this.addChild(panel);
	}

	#persist(selector: string): void {
		settings.setPersistedModelRole(DEFAULT_MODEL_SLOT, selector);
		this.onChange();
		this.onCancel();
	}

	/** The one picker panel is always the only child. */
	mouseTarget(): ModelSelectorPanel | undefined {
		return this.children.find((child): child is ModelSelectorPanel => child instanceof ModelSelectorPanel);
	}

	handleInput(data: string): void {
		this.children[0]?.handleInput?.(data);
	}
}

/**
 * Where a chain the picker edits actually lives, when it is not a settings key.
 *
 * `subagent.model` and `compaction.model` are keys, and `settings.set` addresses
 * them directly. A per-agent lane is a field inside the `subagent.agents`
 * record, whose owner rebuilds and prunes the whole chain of lanes above it on
 * every write, so the picker hands the value over instead of storing it: two
 * writers for one record is how an empty lane comes to persist as `{}` and read
 * as configuration nobody entered.
 */
export interface ModelChainSlot {
	write: (chain: string[] | undefined) => void;
}

/**
 * Ordered-chain picker for a model settings slot (`compaction.model`,
 * `subagent.model`).
 *
 * Both slots have always accepted a CHAIN rather than one model: the stored
 * value goes through {@link normalizeModelPatternList}, which splits on commas,
 * and each consumer tries the entries in order until one works (compaction skips
 * a candidate that is unauthenticated or whose window is too small; a subagent
 * retries on the next entry when its model errors). Only the picker was
 * single-slot, so the feature existed and was unreachable.
 *
 * The list is the chain, in order. Entry one is the choice; the rest are
 * fallbacks. Adding an entry runs the same two steps as before, pick a model
 * then pick a thinking effort, and the effort rides the stored selector as a
 * `:level` suffix (via {@link renderEffortStep}), which is the encoding the
 * compaction candidate resolver and the subagent spawner already parse back out.
 * Models with no supported efforts skip the second step and store the bare
 * selector.
 *
 * Persisted as a string array so the ordered choices survive YAML save/reload
 * without being reparsed from a display-oriented comma string.
 */
export class ModelChainSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#chain: string[];

	constructor(
		private readonly slot: SettingPath | ModelChainSlot,
		private readonly registry: ModelRegistry,
		private readonly models: ReadonlyArray<Model>,
		private readonly title: string,
		current: string | string[] | undefined,
		private readonly done: (value?: string) => void,
		private readonly onChange: (value: string[] | undefined) => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#chain = normalizeModelPatternList(current);
		// An empty chain has no row to edit, so open directly on the picker.
		if (this.#chain.length === 0) this.#showModelPicker(null);
		else this.#showChain();
	}

	#showChain(): void {
		this.clear();
		this.#selectList = undefined;
		this.addChild(new Text(theme.bold(theme.fg("accent", this.title)), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("muted", "Tried in order. The rest are used when the one above cannot run."), 0, 0),
		);
		this.addChild(new Spacer(1));

		const items: SelectItem[] = this.#chain.map((selector, index) => ({
			value: `${CHAIN_ENTRY_PREFIX}${index}`,
			label: `${index + 1}. ${formatSelectorSummary(selector)}`,
			description: index === 0 ? "first choice" : "fallback",
		}));
		items.push({ value: CHAIN_ADD_ROW, label: "Add fallback…", description: "pick a model, then its effort" });
		items.push({ value: CHAIN_CLEAR_ROW, label: "Clear (inherit)", description: "follow the main model" });

		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === CHAIN_ADD_ROW) this.#showModelPicker(null);
			else if (item.value === CHAIN_CLEAR_ROW) this.#clear();
			else this.#showModelPicker(Number(item.value.slice(CHAIN_ENTRY_PREFIX.length)));
			this.requestRender?.();
		};
		this.#selectList.onCancel = () => this.done(this.#chain.join(","));
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter edits · Del removes · Esc to go back"), 0, 0));
	}

	/** Remove the highlighted model without affecting the rest of the chain. */

	#removeSelectedRow(): void {
		const value = this.#selectList?.getSelectedItem?.()?.value;
		if (!value?.startsWith(CHAIN_ENTRY_PREFIX)) return;
		const index = Number(value.slice(CHAIN_ENTRY_PREFIX.length));
		if (!Number.isInteger(index) || index < 0 || index >= this.#chain.length) return;
		this.#chain.splice(index, 1);
		this.#persistChain();
	}

	#showModelPicker(index: number | null): void {
		this.clear();
		this.#selectList = undefined;
		const current = index === null ? undefined : this.#chain[index];
		const position =
			index === 0 ? "first choice" : index === null ? `fallback ${this.#chain.length + 1}` : `fallback ${index + 1}`;
		const panel = new ModelSelectorPanel(
			settings,
			this.registry,
			this.models,
			{
				title: this.#chain.length === 0 ? this.title : `${this.title} · ${position}`,
				description:
					index === null ? "Pick a model to append to the chain." : "Pick a replacement for this position.",
				currentSelector: barePickerSelector(current, this.models as Model<Api>[]) || undefined,
				allowClear: true,
				clearLabel:
					index !== null
						? "(remove this position)"
						: this.#chain.length === 0
							? "(inherit main model)"
							: "(cancel adding fallback)",
			},
			{
				onPick: (model, selector) => {
					if (!hasConfigurableThinkingEffort(model)) {
						this.#store(selector, index);
						return;
					}
					this.#showEffortPicker(selector, model, index);
					this.requestRender?.();
				},
				onClear: () => this.#clearPicker(index),
				onCancel: () => {
					if (this.#chain.length === 0) this.done();
					else this.#showChain();
					this.requestRender?.();
				},
			},
		);
		panel.setHoverMotion({ requestRender: () => this.requestRender?.(), enabled: modalRevealEnabled() });
		this.addChild(panel);
	}

	#showEffortPicker(selector: string, model: Model, index: number | null): void {
		this.#selectList = renderEffortStep(
			this,
			selector,
			model,
			value => this.#store(value, index),
			() => {
				this.#showModelPicker(index);
				this.requestRender?.();
			},
		);
	}

	/** Append a new model or replace one position, never duplicating a logical model. */
	#store(value: string, index: number | null): void {
		const next = replaceModelChainEntry(this.#chain, index, value, this.models as Model<Api>[]);
		if (!next) {
			this.#showChain();
			this.requestRender?.();
			return;
		}
		this.#chain = next;
		this.#persistChain();
	}

	#clearPicker(index: number | null): void {
		if (index !== null && Number.isInteger(index) && index >= 0 && index < this.#chain.length) {
			this.#chain.splice(index, 1);
			this.#persistChain();
		} else if (this.#chain.length === 0) {
			this.#clear();
		} else {
			this.#showChain();
			this.requestRender?.();
		}
	}

	#clear(): void {
		this.#chain = [];
		this.#persist(undefined);
		this.onChange(undefined);
		this.done("inherit");
	}

	#persistChain(): void {
		const value = [...this.#chain];
		this.#persist(value.length === 0 ? undefined : value);
		this.onChange(value.length === 0 ? undefined : value);
		this.#showChain();
		this.requestRender?.();
	}

	/** Store the chain wherever this slot lives: a settings key, or its owner's writer. */
	#persist(chain: string[] | undefined): void {
		if (typeof this.slot !== "string") {
			this.slot.write(chain);
			return;
		}
		if (chain === undefined) settings.unset(this.slot);
		else settings.set(this.slot, chain as never);
	}

	/** The chain list or effort list; the model-picker state targets its panel. */
	mouseTarget(): SelectList | ModelSelectorPanel | undefined {
		return (
			this.#selectList ??
			this.children.find((child): child is ModelSelectorPanel => child instanceof ModelSelectorPanel)
		);
	}

	handleInput(data: string): void {
		if (this.#selectList && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
			this.#removeSelectedRow();
			return;
		}
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

/** Synthetic list id for the depth map's append row, on the same NUL-prefixed rule as the chain picker's. */
const DEPTH_ADD_ROW = "\u0000depth-add-row";

/**
 * The `subagent.modelByDepth` map: one row per configured spawn depth, plus an
 * "Add depth…" row for the next unused one.
 *
 * Every row opens the SAME ordered-chain picker {@link ModelChainSubmenu} that
 * `subagent.model` uses, bound to that depth's dotted row path — a parallel
 * picker here is how the two chain editors would drift apart. The map itself
 * is read and cleared through `task/subagent-settings.ts`, the one owner of
 * the `subagent.*` area; this screen never restates the key.
 *
 * A row is only an entry in a map, so deleting one is Del on the list, and
 * clearing the last row removes the map itself (the unset state), done by
 * {@link clearSubagentModelByDepthRow} rather than here.
 */
class SubagentModelByDepthSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;

	constructor(
		private readonly registry: ModelRegistry,
		private readonly models: ReadonlyArray<Model>,
		private readonly onChange: () => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showRows();
	}

	#showRows(): void {
		this.clear();
		this.#selectList = undefined;
		this.addChild(new Text(theme.bold(theme.fg("accent", "Models by Depth")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"A row outranks Subagent Model for a spawn at exactly that depth: 1 is a direct child, 2 a grandchild. Depths without a row follow Subagent Model.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const rows = subagentModelByDepthRows(settings);
		const items: SelectItem[] = rows.map(row => {
			const chain = normalizeModelPatternList(row.value);
			const primary = chain[0] === undefined ? "" : formatSelectorSummary(chain[0]);
			const fallbacks = chain.length - 1;
			return {
				value: String(row.depth),
				label: `Depth ${row.depth}`,
				description: fallbacks > 0 ? `${primary}, +${fallbacks}` : primary,
			};
		});
		items.push({
			value: DEPTH_ADD_ROW,
			label: "Add depth…",
			description: `bind a chain to depth ${nextSubagentModelByDepth(settings)}`,
		});

		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			this.#openDepth(item.value === DEPTH_ADD_ROW ? nextSubagentModelByDepth(settings) : Number(item.value));
			this.requestRender?.();
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter edits · Del clears a depth · Esc to go back"), 0, 0));
	}

	#openDepth(depth: number): void {
		this.clear();
		this.#selectList = undefined;
		const current = subagentModelByDepthRows(settings).find(row => row.depth === depth)?.value;
		this.addChild(
			new ModelChainSubmenu(
				subagentModelByDepthRowPath(depth),
				this.registry,
				this.models,
				`Depth ${depth}`,
				current,
				() => {
					// The chain picker's own Clear row unsets the dotted row but
					// leaves an empty map behind; dropping it keeps "no rows" and
					// "unset" the same stored shape.
					if (subagentModelByDepthRows(settings).length === 0) settings.unset(SUBAGENT_MODEL_BY_DEPTH_PATH);
					this.onChange();
					this.#showRows();
					this.requestRender?.();
				},
				() => this.onChange(),
				this.requestRender,
			),
		);
	}

	#removeSelectedRow(): void {
		const value = this.#selectList?.getSelectedItem?.()?.value;
		if (value === undefined || value === DEPTH_ADD_ROW) return;
		clearSubagentModelByDepthRow(settings, Number(value));
		this.onChange();
		this.#showRows();
		this.requestRender?.();
	}

	/** The depth rows list; an open depth targets its chain picker (which routes its own mouse). */
	mouseTarget(): SelectList | ModelChainSubmenu | undefined {
		return (
			this.#selectList ??
			this.children.find((child): child is ModelChainSubmenu => child instanceof ModelChainSubmenu)
		);
	}

	handleInput(data: string): void {
		if (this.#selectList && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
			this.#removeSelectedRow();
			return;
		}
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

/** Synthetic item id prefix for the per-tab "Advanced" fold toggle row. */
const ADVANCED_TOGGLE_ID_PREFIX = "__advanced:";

function advancedToggleId(tab: SettingTab): string {
	return `${ADVANCED_TOGGLE_ID_PREFIX}${tab}`;
}

function isAdvancedToggleId(id: string): boolean {
	return id.startsWith(ADVANCED_TOGGLE_ID_PREFIX);
}

/** Columns between the sidebar and the settings pane: `│` hairline + two spaces. */
/**
 * Footer tip candidates. One array so the chrome plan is computed from the SAME
 * tip the card renders: the tip and its gap are droppable rows, so a plan built
 * from a different list would disagree with the card about how tall it is.
 */
const SETTINGS_TIPS: readonly string[] = [
	'Tip · Ask the agent: "change theme to titanium" or "what does compact do?"',
	"Tip · Ask the agent to change a setting",
];

const SIDEBAR_GAP_COLS = 3;
const MIN_SETTINGS_CONTENT_WIDTH = 32;

const SETTING_SOURCE_LABELS: Record<SettingSource, string> = {
	default: "default",
	profile: "profile",
	"config-file": "--config file",
	runtime: "runtime override",
	global: "global config",
};

/** Footer chips while keyboard focus rests on the category sidebar. */
const SETTINGS_SIDEBAR_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down category" },
	{ label: "right/enter settings" },
	{ label: "/ search" },
	{ label: "esc close", clickable: true, id: "close" },
];

const SETTINGS_READ_ONLY_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "read-only" },
	{ label: "/ search" },
	{ label: "esc close", clickable: true, id: "close" },
];

function getSettingsTabs(): Tab[] {
	// Icon-light presets define tab glyphs as "" — then the category name
	// stands alone. A blank glyph must not leave a stray leading space, and
	// `short` falls back to the name's initial so narrow tab strips stay legible.
	const entry = (id: string, icon: string, label: string): Tab => ({
		id,
		label: icon ? `${icon} ${label}` : label,
		short: icon || label.charAt(0),
	});
	return [
		...SETTING_TABS.map(id => {
			const meta = TAB_METADATA[id];
			return entry(id, theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]), meta.label);
		}),
		entry("plugins", theme.icon.package, "Plugins"),
	];
}

/**
 * Dynamic context for settings that need runtime data.
 * Some settings (like thinking level) are managed by the session, not Settings.
 */
export interface SettingsRuntimeContext {
	/** Available thinking levels (from session) */
	availableThinkingLevels: Effort[];
	/** Current thinking level (from session) */
	thinkingLevel: ThinkingLevel | undefined;
	/** Available themes */
	availableThemes: string[];
	/** Resolved personality catalog (built-ins + Tier-B data-file overrides), excluding `none`. */
	availablePersonalities: string[];
	/** Provider/source ids shown in /model. */
	providers: string[];
	/** Working directory for plugins tab */
	cwd: string;
	/** Active model (api + id) for settings previews that resolve model context. */
	model?: Model;
	/** Shared TUI image budget (graphics ids + transmit-once) for image previews. */
	imageBudget?: ImageBudget;
	/** Schedules a re-render after async preview work completes. */
	requestRender?: () => void;
	/** Model registry for auth badges + catalog (required for model pickers). */
	modelRegistry?: ModelRegistry;
	/** Models offered in settings model pickers (usually getAvailable()). */
	availableModels?: ReadonlyArray<Model>;
}

/** Status line settings subset for preview */
export interface StatusLinePreviewSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	sessionAccent?: boolean;
	compactThinkingLevel?: boolean;
}

/** Id of the actionable rollback row. Exported so tests address it by name. */
export const ROLLBACK_ROW_ID = "__action:rollback";

export interface SettingsCallbacks {
	/** Called when any setting value changes */
	onChange: (path: SettingPath, newValue: unknown) => void;
	/** Called for theme preview while browsing */
	onThemePreview?: (theme: string) => void | Promise<void>;
	/** Called for status line preview while configuring */
	onStatusLinePreview?: (settings: StatusLinePreviewSettings) => void;
	/** Get current rendered status line for inline preview */
	getStatusLinePreview?: () => string;
	/** Called when plugins change */
	onPluginsChanged?: () => void | Promise<void>;
	/** Called when settings panel is closed */
	onCancel: () => void;
	/**
	 * Opens a URL in the operator's browser.
	 *
	 * Supplied by the host because a component has no business spawning a
	 * process. Absent means the rollback row's changelog key does nothing rather
	 * than crashing, which is the right degrade for a convenience affordance.
	 */
	onOpenUrl?: (url: string) => void;
	/**
	 * Moves the install to another published version.
	 *
	 * The ROW IS ONLY OFFERED WHEN THIS IS SUPPLIED. A "Roll back version" row
	 * that opened a picker and then could not install anything would be worse
	 * than no row: it would look like the feature is there and broken.
	 */
	onRollback?: (version: string) => Promise<void>;
	/** Reports a failure that happens after the panel closes. */
	onError?: (message: string) => void;
}

/**
 * Main tabbed settings selector component.
 * Uses declarative settings definitions from settings-defs.ts.
 */
export class SettingsSelectorComponent implements Component {
	#tabBar: TabBar;
	#currentList: SettingsList | null = null;
	#searchList: SettingsList | null = null;
	#pluginComponent: PluginSettingsComponent | null = null;
	#currentTabId: SettingTab | "plugins" = "appearance";
	#preSearchTabId: SettingTab | "plugins" = "appearance";
	#searchQuery = "";
	/** Single-line editor backing the search banner (cursor, word ops, paste). */
	#searchInput = new Input();
	#searchMatchCount = 0;
	/** First matching item id per tab id, for Tab-key jumps while searching. */
	#searchFirstMatch = new Map<string, string>();
	#textInputActive = false;
	/** Per-tab collapsed state for the "Advanced" fold (session-only, defaults collapsed). */
	#showAdvanced = new Map<SettingTab, boolean>();
	/** Last selected setting per category; rendering derives the matching scroll window. */
	#selectedSettingByTab = new Map<SettingTab, string>();
	// Frame geometry from the last render, for mouse hit-testing (the
	// fullscreen overlay paints from screen row 0, so mouse rows map 1:1).
	#tabRowStart = 0;
	#tabRowCount = 0;
	#contentRowStart = 0;
	#contentRowCount = 0;
	/** Left pad when the modal is width-constrained and centered. */
	#frameLeft = 0;
	/** Width of the category sidebar column at the last render. */
	#sidebarCols = 0;
	#sidebarWidthCache: number | undefined;
	/** Last ModalShell geometry for mouse hit-testing. */
	#shellGeometry: ModalShellGeometry | null = null;
	/** True when the terminal cannot show an actionable settings pane safely. */
	#viewportTooSmall = false;
	#hoveredShortcutId: string | null = null;
	/** Setting ids whose descriptions are expanded (Right/l). */
	#expandedIds = new Set<string>();
	/**
	 * Keyboard focus rests on the category sidebar (Left from the pane).
	 * While focused, Up/Down change category without wrapping and Right/Enter
	 * return to the settings rows — matching the visual left/right layout.
	 */
	#sidebarFocused = false;
	#reveal = new ModalRevealDriver();
	/**
	 * Fade out on the shared clock before the host drops this card. The overlay stack keeps painting
	 * it and stops routing input to it the moment this is called.
	 */
	beginOverlayExit(requestRender: () => void, done: () => void): boolean {
		return beginModalExit(this.#reveal, requestRender, done);
	}

	/** @deprecated Prefer ModalShell sizing; kept for tests that assert width. */
	static readonly MODAL_MAX_WIDTH = MODAL_SIZING_SETTINGS.maxWidth;

	constructor(
		private readonly context: SettingsRuntimeContext,
		private readonly callbacks: SettingsCallbacks,
		/** Setting path to pre-select on the default (appearance) tab, e.g. `/statusline` jumping to `statusLine.preset`. */
		initialItemId?: string,
		/** Play the open unfold (TOUCH-5). Show site decides via modalRevealEnabled(). */
		reveal?: boolean,
	) {
		if (reveal) {
			this.#reveal.start(() => this.context.requestRender?.());
		}
		// No label prefix (the frame title already says Settings) and no
		// "(tab to cycle)" hint (folded into the footer hint line).
		this.#tabBar = new TabBar("", getSettingsTabs(), getTabBarTheme());
		this.#tabBar.showHint = false;
		// The category sidebar is a pointer surface like the pane beside it, and
		// the two are two columns apart in the same card: a band that fades in one
		// and switches in the other reads as a rendering fault.
		this.#tabBar.setHoverMotion({
			requestRender: () => this.context.requestRender?.(),
			enabled: modalRevealEnabled(),
		});
		this.#tabBar.onTabChange = () => {
			const tabId = this.#tabBar.getActiveTab().id as SettingTab | "plugins";
			if (this.#searchList) {
				// While searching, tabs act as jump targets into the result list.
				const firstId = this.#searchFirstMatch.get(tabId);
				if (firstId) this.#searchList.selectItem(firstId);
				return;
			}
			this.#switchToTab(tabId);
		};

		// Initialize with first tab
		this.#switchToTab("appearance");
		if (initialItemId) this.#currentList?.selectItem(initialItemId);
	}

	/**
	 * Drop everything registered with the shared clock. The host calls this when
	 * the card is gone for good; a card nobody can see must not keep asking for
	 * frames.
	 */
	dispose(): void {
		this.#reveal.stop();
		this.#tabBar.disposeHoverMotion();
		this.#currentList?.disposeHoverMotion();
		this.#searchList?.disposeHoverMotion();
	}

	/** The currently selected setting's path, or undefined (e.g. on a heading or empty tab). Test/debug hook. */
	getSelectedSettingId(): string | undefined {
		return (this.#searchList ?? this.#currentList)?.getSelectedItem()?.id;
	}

	/** Select a setting by path in the active list. Test/debug + deep-link hook. */
	selectSetting(path: string): boolean {
		return (this.#searchList ?? this.#currentList)?.selectItem(path) ?? false;
	}

	/** Open a settings tab by id. Test/debug + deep-link hook. */
	openTab(tabId: SettingTab | "plugins"): void {
		this.#tabBar.setActiveById(tabId);
		// TabBar normally invokes onTabChange. Keep the hook usable with a tab
		// implementation that suppresses same-id notifications, without rebuilding twice.
		if (this.#currentTabId !== tabId) this.#switchToTab(tabId);
	}

	invalidate(): void {
		this.#tabBar.invalidate();
		this.#currentList?.invalidate();
		this.#searchList?.invalidate();
		this.#pluginComponent?.invalidate();
	}

	#rememberCurrentSelection(): void {
		if (this.#currentTabId === "plugins") return;
		const selected = this.#currentList?.getSelectedItem()?.id;
		if (selected) this.#selectedSettingByTab.set(this.#currentTabId, selected);
	}

	#restoreRememberedSelection(tabId: SettingTab, remembered: string | undefined): void {
		if (!remembered) return;
		if (this.#currentList?.selectItem(remembered)) return;

		const defs = getSettingsForTab(tabId);
		const rememberedIndex = defs.findIndex(def => def.path === remembered);
		if (rememberedIndex !== -1) {
			for (let offset = 1; offset < defs.length; offset++) {
				const before = defs[rememberedIndex - offset];
				if (before && this.#currentList?.selectItem(before.path)) {
					this.#selectedSettingByTab.set(tabId, before.path);
					return;
				}
				const after = defs[rememberedIndex + offset];
				if (after && this.#currentList?.selectItem(after.path)) {
					this.#selectedSettingByTab.set(tabId, after.path);
					return;
				}
			}
		}
		this.#selectedSettingByTab.delete(tabId);
	}

	/** Swap the active content (per-tab list, search list, or plugins). */
	#setContent(build: () => void): void {
		// Whichever list is being thrown away takes its pointer fades with it: they
		// are registered with the shared clock, and a list nobody can see must not
		// keep asking for frames.
		this.#currentList?.disposeHoverMotion();
		this.#searchList?.disposeHoverMotion();
		this.#currentList = null;
		this.#searchList = null;
		this.#pluginComponent = null;
		build();
	}

	#switchToTab(tabId: SettingTab | "plugins"): void {
		this.#rememberCurrentSelection();
		this.#currentTabId = tabId;
		this.#setContent(() => {
			if (tabId === "plugins") {
				this.#showPluginsTab();
			} else {
				this.#showSettingsTab(tabId);
				this.#restoreRememberedSelection(tabId, this.#selectedSettingByTab.get(tabId));
			}
		});
	}

	#settingsShortcuts(): readonly ModalShortcut[] {
		if (this.#searchList) return SETTINGS_FILTER_SHORTCUTS;
		if (this.#currentList?.hasOpenSubmenu()) return SETTINGS_SUBPANE_SHORTCUTS;
		if (this.#sidebarFocused) return SETTINGS_SIDEBAR_SHORTCUTS;
		// The plugins tab is a stack of its own views (list, plugin detail, config
		// sub-pane), so the view in front of the user names the keys.
		if (this.#pluginComponent) return this.#pluginComponent.shortcuts();
		if (this.#currentList?.getSelectedItem()?.readOnly) return SETTINGS_READ_ONLY_SHORTCUTS;
		return SETTINGS_BROWSE_SHORTCUTS;
	}

	/** Single-line search banner: accent icon, editable query with live cursor, right-aligned match count. */
	#renderSearchBanner(width: number): string {
		const icon = theme.symbol("icon.search");
		const countText = this.#searchMatchCount === 1 ? "1 match" : `${this.#searchMatchCount} matches`;
		const rightWidth = visibleWidth(countText) + 1;
		const prefix = ` ${theme.fg("accent", icon)} `;
		const inputWidth = Math.max(4, width - visibleWidth(prefix) - rightWidth - 1);
		const inputLine = this.#searchInput.render(inputWidth)[0] ?? "";
		const count = theme.fg(this.#searchMatchCount > 0 ? "dim" : "warning", countText);
		return truncateToWidth(`${prefix}${theme.bold(inputLine)} ${count} `, width);
	}

	#searchChromeLine(width: number): string {
		if (this.#searchList) return this.#renderSearchBanner(width);
		const icon = theme.symbol("icon.search");
		return truncateToWidth(` ${theme.fg("dim", icon)} ${theme.fg("dim", "/ search settings")}`, width);
	}

	/**
	 * Category sidebar width: widest base tab label plus the cursor column and
	 * headroom for search-mode " (99)" match counts, so the divider column
	 * never moves when entering/leaving search. Clamped to a third of the
	 * content width on narrow terminals.
	 */
	#sidebarWidth(contentWidth: number): number {
		if (this.#sidebarWidthCache === undefined) {
			let labelWidth = 0;
			for (const tab of getSettingsTabs()) {
				labelWidth = Math.max(labelWidth, visibleWidth(tab.label));
			}
			this.#sidebarWidthCache = labelWidth + 2 + 5;
		}
		return Math.min(this.#sidebarWidthCache, Math.max(10, Math.floor(contentWidth / 3)));
	}

	#renderTooSmall(width: number, termHeight: number): readonly string[] {
		this.#viewportTooSmall = true;
		this.#shellGeometry = null;
		this.#contentRowCount = 0;
		const lines = Array.from({ length: termHeight }, () => padding(width));
		const messages =
			width >= 40
				? ["Settings needs a larger terminal · resize or press Esc to close"]
				: ["Settings needs more room", "Resize · Esc closes"];
		const firstRow = Math.max(0, Math.floor((termHeight - messages.length) / 2));
		for (const [offset, message] of messages.entries()) {
			const text = truncateToWidth(message, width);
			const left = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
			lines[firstRow + offset] = `${padding(left)}${text}`;
		}
		return lines;
	}

	/**
	 * Floating ModalShell settings card: always-on search chrome, body list,
	 * tip, centered shortcut chips. Transcript visible around the card.
	 */
	render(width: number): readonly string[] {
		const termHeight = Math.max(1, process.stdout.rows || 40);
		const sizing = sizingForArea(MODAL_SIZING_SETTINGS, termHeight);
		const dims = computeModalDims(width, termHeight, sizing);
		if (!dims || dims.contentWidth < MIN_SETTINGS_CONTENT_WIDTH) return this.#renderTooSmall(width, termHeight);
		this.#viewportTooSmall = false;
		// Must match ModalShell's contentWidth — provisional maxWidth math
		// over-sized the search banner and fit() chopped off the match count.
		const contentWidth = dims.contentWidth;
		const settingsShortcuts = this.#settingsShortcuts();
		const maxBodyRows = planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth,
			shortcuts: settingsShortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			tipCandidates: SETTINGS_TIPS,
			hasSearch: true,
		}).maxBodyRows;
		if (maxBodyRows < 1) return this.#renderTooSmall(width, termHeight);

		// Vertical category sidebar on the left, settings pane on the right,
		// separated by a silver hairline: `sidebar │  pane`.
		const sidebarWidth = this.#sidebarWidth(contentWidth);
		const paneWidth = Math.max(1, contentWidth - sidebarWidth - SIDEBAR_GAP_COLS);
		// The cursor brightens while the sidebar itself holds keyboard focus.
		const sidebarCursor = this.#sidebarFocused ? `${theme.fg("accent", theme.nav.cursor)} ` : `${theme.nav.cursor} `;
		const sidebarLines = this.#tabBar.renderVertical(sidebarWidth, sidebarCursor);
		const searching = this.#searchList !== null;
		const showPreview = !searching && this.#currentTabId === "appearance" && paneWidth >= 40;
		// The preview is a live status-line render: clamp every line to the
		// pane so a wide preview can't punch through the modal's right border.
		const requestedPreviewLines = showPreview
			? [
					"",
					theme.fg("muted", "Preview:"),
					...this.#getStatusPreviewString()
						.split("\n")
						.map(line => truncateToWidth(line, paneWidth)),
				]
			: [];

		// Ask the shell how many body rows it will give, rather than estimating.
		// This read `dims.modalHeight - 10` under a comment admitting it "mirrors
		// renderModalShell's own nonBody() budget", and a mirror is exactly what
		// goes stale: this card carries search chrome AND a tip band, so its real
		// reservation moves with the tip, the tip gap, and any chip row that wraps.
		// Four sibling overlays shipped content off the end of a card this way.
		// The sidebar runs parallel to the pane, so it costs no vertical budget.
		const estimatedBody = maxBodyRows;
		// Prefer visible, actionable setting rows in short terminals. The
		// decorative status preview returns once the body has enough room.
		const previewLines = estimatedBody >= 8 ? requestedPreviewLines : [];
		const list = this.#searchList ?? this.#currentList;
		let listLines: readonly string[] = [];
		if (list) {
			list.setMaxVisible(Math.max(1, estimatedBody - previewLines.length));
			list.setOptions({
				descriptionMode: "expand",
				expandedIds: this.#expandedIds,
				layout: "flat",
			});
			listLines = list.render(paneWidth);
		} else if (this.#pluginComponent) {
			listLines = this.#pluginComponent.render(paneWidth);
		}

		const paneLines: string[] = [...listLines, ...previewLines];
		const bar = theme.fg("borderAccent", theme.boxSharp.vertical);
		const bodyRows = Math.max(sidebarLines.length, paneLines.length);
		const body: string[] = [];
		for (let r = 0; r < bodyRows; r++) {
			const side = sidebarLines[r] ?? padding(sidebarWidth);
			body.push(`${side}${bar}  ${paneLines[r] ?? ""}`);
		}

		// Breadcrumb: "Settings › Label" while a sub-pane (enum picker, text
		// input, provider limits, model roles, …) owns the panel — mirrors
		// Grok's PickingEnum/PickingGroup/EditingValue title. Clicking it
		// peels one level back to Browse (same as the "esc back" chip).
		const openSubmenuLabel = list?.hasOpenSubmenu() ? list.getOpenSubmenuLabel() : undefined;
		const breadcrumb = openSubmenuLabel ? ` ${theme.nav.cursor} ${openSubmenuLabel}` : undefined;

		const shell = renderModalShell({
			title: "Settings",
			breadcrumb,
			breadcrumbClickable: true,
			breadcrumbHovered: this.#hoveredShortcutId === BREADCRUMB_HOVER_ID,
			sizing,
			areaWidth: width,
			areaHeight: termHeight,
			body,
			searchLine: this.#searchChromeLine(contentWidth),
			tipCandidates: SETTINGS_TIPS,
			shortcuts: settingsShortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});

		this.#shellGeometry = shell.geometry;
		this.#frameLeft = shell.geometry?.leftPad ?? 0;
		// Sidebar and pane share the same body rows (side-by-side columns).
		this.#tabRowStart = shell.geometry?.bodyRowStart ?? 0;
		this.#tabRowCount = Math.min(sidebarLines.length, shell.geometry?.bodyRowCount ?? 0);
		this.#contentRowStart = this.#tabRowStart;
		this.#contentRowCount = shell.geometry?.bodyRowCount ?? 0;
		this.#sidebarCols = sidebarWidth;
		return applyModalReveal(shell, width, this.#reveal.value);
	}

	/**
	 * Route an SGR mouse report against the frame geometry of the last render.
	 * Wheel scrolls the focused list, motion drives the hover highlights (tabs
	 * and rows), and a left click activates: tabs switch (or jump, while
	 * searching), a row click selects, and a click on the already-selected row
	 * activates it (toggle / open submenu).
	 */
	#handleMouse(data: string): boolean {
		return routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
	}

	/** Cancel transient submenu state, such as an uncommitted theme preview. */
	#cancelOpenSubmenu(): void {
		const list = this.#searchList ?? this.#currentList;
		if (list?.hasOpenSubmenu()) list.handleInput("\x1b");
	}

	/** Close the settings surface only after transient previews are restored. */
	#close(): void {
		this.#cancelOpenSubmenu();
		this.callbacks.onCancel();
	}

	/**
	 * One level back: out of an open sub-pane, or one view up the plugins tab's
	 * own stack. Exactly what Esc does to whatever holds the keys, so the "esc
	 * back" chip and the breadcrumb cannot drift from the key they name.
	 */
	#stepBack(): void {
		if (this.#pluginComponent) {
			this.#pluginComponent.handleInput("\x1b");
			return;
		}
		(this.#searchList ?? this.#currentList)?.handleInput("\x1b");
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (
			consumeModalChipHover(chrome, this.#hoveredShortcutId, id => {
				this.#hoveredShortcutId = id;
				this.context.requestRender?.();
			})
		) {
			return true;
		}
		if (chrome.kind === "close" || chrome.kind === "outside") {
			this.#close();
			return true;
		}
		if (chrome.kind === "breadcrumb") {
			// Peel one sub-pane level back to Browse — same as the "esc back"
			// footer chip, just reachable from the title too.
			this.#stepBack();
			return true;
		}
		if (chrome.kind === "shortcut") {
			if (chrome.id === "close") {
				this.#close();
				return true;
			}
			if (chrome.id === "clear-filter") {
				this.#endSearch(true);
				return true;
			}
			if (chrome.id === "back") {
				this.#stepBack();
				return true;
			}
		}

		const list = this.#searchList ?? this.#currentList;
		// row() insets content by the border column plus a space; frame may be centered.
		const contentColInset = 2 + this.#frameLeft;
		const innerCol = event.col - contentColInset;
		const bodyLine = event.row - this.#contentRowStart;
		const overBody = bodyLine >= 0 && bodyLine < this.#contentRowCount;
		// Sidebar column on the left, settings pane right of the hairline gap.
		const overSidebar = overBody && innerCol >= 0 && innerCol < this.#sidebarCols && bodyLine < this.#tabRowCount;
		const paneCol = innerCol - (this.#sidebarCols + SIDEBAR_GAP_COLS);
		const overPane = overBody && paneCol >= 0;

		if (event.wheel !== null) {
			if (overPane) {
				this.#sidebarFocused = false;
				// An open submenu owns the pane pointer (text inputs ignore it).
				if (list) routeSettingsListPointer(list, event, bodyLine, paneCol);
				else this.#pluginComponent?.routeMouse(event, bodyLine, paneCol);
			}
			return true;
		}

		if (event.motion) {
			const hovered = overSidebar ? this.#tabBar.tabAt(bodyLine, innerCol) : undefined;
			this.#tabBar.setHoverTab(hovered && !hovered.muted ? hovered.id : null);
			if (!list) {
				if (overPane) this.#pluginComponent?.routeMouse(event, bodyLine, paneCol);
			} else if (list.hasOpenSubmenu()) {
				// Only rows the pointer is actually on — never light up submenu
				// rows while the pointer is over the sidebar.
				if (overPane) routeSettingsListPointer(list, event, bodyLine, paneCol);
			} else {
				list.setHoverItem(overPane ? (list.hoverTest(bodyLine, paneCol) ?? null) : null);
			}
			return true;
		}
		if (!event.leftClick) return true;

		// A sidebar click switches category even while a sub-pane is open (the
		// rebuilt tab list discards the submenu, same as Esc + Tab).
		if (overSidebar) {
			this.#cancelOpenSubmenu();
			const tab = this.#tabBar.tabAt(bodyLine, innerCol);
			if (tab) {
				this.#tabBar.selectTab(tab.id);
				// A click activates the category and works the pane directly.
				this.#sidebarFocused = false;
			}
			return true;
		}
		// The plugins tab is not a SettingsList: it owns a stack of views and
		// carries the pointer into whichever one is mounted.
		if (!list) {
			if (overPane) this.#pluginComponent?.routeMouse(event, bodyLine, paneCol);
			return true;
		}
		if (list.hasOpenSubmenu()) {
			routeSettingsListPointer(list, event, bodyLine, paneCol);
			return true;
		}
		if (overPane && routeSettingsListPointer(list, event, bodyLine, paneCol)) {
			this.#sidebarFocused = false;
		}
		return true;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Global search (type-to-search across every tab)
	// ═══════════════════════════════════════════════════════════════════════

	/** Swap the tab content for the global search result list. */
	#startSearch(initialQuery: string): void {
		this.#rememberCurrentSelection();
		// Search results live in the pane; sidebar focus would be stale there.
		this.#sidebarFocused = false;
		this.#preSearchTabId = this.#currentTabId;
		this.#searchInput = new Input();
		this.#searchInput.prompt = "";
		this.#searchInput.setValue(initialQuery);
		const list = new SettingsList(
			[],
			10,
			getSettingsListTheme(),
			(id, newValue) => this.#onSearchSettingChange(id as SettingPath, newValue),
			() => this.#close(),
			{
				layout: "flat",
				typeToSearch: false,
				emptyText: "No matching settings",
				hint: "",
			},
		);
		list.setHoverMotion({
			requestRender: () => this.context.requestRender?.(),
			enabled: modalRevealEnabled(),
		});
		// Keep the footer tab highlight on the tab owning the selected result.
		list.onSelectionChange = item => this.#syncTabBarToSelection(item);
		this.#setContent(() => {
			this.#searchList = list;
		});
		this.#setSearchQuery(initialQuery);
	}

	/**
	 * Recompute matches across every settings tab. Results render as one flat
	 * list with a heading row per tab; the footer tab bar reorders to show
	 * matching tabs (with counts) first and the rest muted at the end.
	 */
	#setSearchQuery(query: string): void {
		if (!this.#searchList) return;
		if (query.length === 0) {
			this.#endSearch(false);
			return;
		}
		this.#searchQuery = query;

		const counts = new Map<SettingTab, number>();
		const items: SettingItem[] = [];
		const tabResults: { tab: SettingTab; matched: SettingItem[]; bestScore: number; order: number }[] = [];
		this.#searchFirstMatch.clear();
		let total = 0;
		for (const tab of SETTING_TABS) {
			const candidates: SettingItem[] = [];
			for (const def of getSettingsForTab(tab)) {
				const item = this.#defToItem(def);
				if (item) candidates.push(item);
			}
			const ranked = rankSettingItems(candidates, query);
			const matched = ranked.map(result => result.item);
			counts.set(tab, matched.length);
			if (matched.length === 0) continue;
			total += matched.length;
			tabResults.push({
				tab,
				matched,
				bestScore: ranked[0]?.score ?? 0,
				order: SETTING_TABS.indexOf(tab),
			});
		}

		tabResults.sort((a, b) => a.bestScore - b.bestScore || a.order - b.order);
		for (const result of tabResults) {
			const meta = TAB_METADATA[result.tab];
			items.push({
				id: `__tab:${result.tab}`,
				label: `${theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0])} ${meta.label}`,
				currentValue: "",
				heading: true,
			});
			this.#searchFirstMatch.set(result.tab, result.matched[0]?.id ?? "");
			items.push(...result.matched);
		}

		this.#searchList.setItems(items);
		this.#searchMatchCount = total;
		this.#tabBar.setTabs(
			this.#buildSearchTabs(
				counts,
				tabResults.map(result => result.tab),
			),
		);
		this.#syncTabBarToSelection(this.#searchList.getSelectedItem());
	}

	/**
	 * Leave search mode. With `jumpToSelection`, land on the tab containing
	 * the selected result and keep it selected there — search doubles as
	 * navigation. Otherwise restore the pre-search tab.
	 */
	#endSearch(jumpToSelection: boolean): void {
		if (!this.#searchList) return;
		const selected = jumpToSelection ? this.#searchList.getSelectedItem() : undefined;
		const selectedDef = selected ? getSettingDef(selected.id as SettingPath) : undefined;
		const targetTab: SettingTab | "plugins" = selectedDef?.tab ?? this.#preSearchTabId;

		// Landing on an advanced item from search: auto-expand its tab's fold
		// so the selected row is actually visible once search closes.
		if (selectedDef?.advanced && targetTab !== "plugins") {
			this.#showAdvanced.set(targetTab, true);
		}

		this.#searchQuery = "";
		this.#searchFirstMatch.clear();
		this.#searchMatchCount = 0;
		this.#tabBar.setTabs(getSettingsTabs(), targetTab);
		this.#switchToTab(targetTab);
		if (selectedDef) {
			this.#currentList?.selectItem(selectedDef.path);
			this.#selectedSettingByTab.set(selectedDef.tab, selectedDef.path);
		}
	}

	/** Matching tabs first (counts attached), ordered by best result score; the rest stay muted at the end. */
	#buildSearchTabs(counts: Map<SettingTab, number>, matchedTabOrder: readonly SettingTab[]): Tab[] {
		const matched: Tab[] = [];
		const empty: Tab[] = [];
		const matchedIds = new Set<SettingTab>(matchedTabOrder);
		for (const id of matchedTabOrder) {
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]);
			const count = counts.get(id) ?? 0;
			if (count > 0) {
				matched.push({ id, label: `${icon} ${meta.label} (${count})`, short: `${icon} ${count}` });
			}
		}
		for (const id of SETTING_TABS) {
			if (matchedIds.has(id)) continue;
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]);
			empty.push({ id, label: `${icon} ${meta.label}`, short: icon, muted: true });
		}
		// Plugins hosts its own UI; it is not part of the schema-backed search.
		empty.push({
			id: "plugins",
			label: withIcon(theme.icon.package, "Plugins"),
			short: theme.icon.package,
			muted: true,
		});
		return [...matched, ...empty];
	}

	#syncTabBarToSelection(item: SettingItem | undefined): void {
		if (!this.#searchList || !item) return;
		const def = getSettingDef(item.id as SettingPath);
		if (def) this.#tabBar.setActiveById(def.tab);
	}

	/** Value-change dispatch for the search result list (any tab's setting). */
	#onSearchSettingChange(path: SettingPath, newValue: string): void {
		const def = getSettingDef(path);
		if (!def) return;
		if (def.type === "boolean") {
			const boolValue = newValue === "true";
			settings.set(path, boolValue as never);
			this.callbacks.onChange(path, boolValue);
		} else if (def.type === "enum") {
			settings.set(path, newValue as never);
			this.callbacks.onChange(path, newValue);
		}
		// Submenu/text types already persisted inside their own done callbacks.
		if (def.tab === "appearance") {
			this.#triggerStatusLinePreview();
		}
		// Values feed the searchable text and condition gates may have flipped:
		// recompute results in place (selection is preserved by item id).
		this.#setSearchQuery(this.#searchQuery);
	}

	/**
	 * Convert a setting definition to a SettingItem for the UI.
	 */
	/**
	 * Build a list item, then attach the fields search ranks on: the group and the
	 * schema's declared synonyms. Done once here rather than in each `case` below,
	 * so a new widget type cannot ship unsearchable by forgetting them.
	 */
	#defToItem(def: SettingDef): SettingItem | null {
		const item = this.#defToItemBase(def);
		if (!item) return null;
		const searchable = { ...item, group: def.group, keywords: def.keywords };
		if (def.type === "defaultModel") return searchable;

		const source = settings.getSource(def.path);
		if (source !== "config-file" && source !== "runtime") return searchable;
		const sourceLabel = SETTING_SOURCE_LABELS[source];
		// The composite is built from the LABELLED value, and the labeller is dropped with
		// it: once the value is wrapped in "<source> · ...", no option can match it, so a
		// mapper carried along here would silently fall back and print the stored number.
		const shownValue = searchable.labelForValue?.(searchable.currentValue) ?? searchable.currentValue;
		return {
			...searchable,
			readOnly: true,
			currentValue: `${sourceLabel} · ${shownValue}`,
			labelForValue: undefined,
			description: `${searchable.description ?? def.label}. Effective value comes from ${sourceLabel}; this profile control is read-only.`,
			values: undefined,
			submenu: undefined,
		};
	}

	#defToItemBase(def: SettingDef): SettingItem | null {
		// Check condition: applies to every variant — booleans, enums, submenus, text inputs.
		if (def.condition && !def.condition()) {
			return null;
		}

		const currentValue = this.#getCurrentValue(def);
		const changed = this.#isChanged(def, currentValue);

		switch (def.type) {
			case "boolean":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: currentValue ? "true" : "false",
					values: ["true", "false"],
					changed,
				};

			case "enum":
				// Bare enums (no option labels) open a chooser on activate — click
				// and then choose — rather than cycling in place. Left/Right stay free
				// for sidebar focus and description expand; the value only changes
				// through the chooser, which never conflicts with navigation.
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: String(currentValue ?? ""),
					submenu: (cv, done) => this.#createEnumSubmenu(def, cv, done),
					changed,
				};

			case "submenu":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: this.#getSubmenuCurrentValue(def.path, currentValue),
					// The stored value is often not the readable one: a duration setting keeps
					// milliseconds, and the option list is where the words for them live. The
					// list comes from {@link #submenuOptions} rather than `def.options`, so a
					// row whose choices only the runtime knows labels its value with the same
					// rows the picker shows instead of printing the raw stored string.
					labelForValue: value => this.#submenuOptions(def).find(option => option.value === value)?.label ?? value,
					submenu: (cv, done) => this.#createSubmenu(def, cv, done),
					changed,
				};

			case "compactionThreshold":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: formatThresholdShort(String(currentValue ?? AUTO_COMPACTION_THRESHOLD)),
					submenu: (_cv, done) => this.#createCompactionThresholdInput(def, done),
					changed,
				};

			case "text":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: this.#formatTextInputValue(def.path, currentValue),
					submenu: (cv, done) => this.#createTextInput(def, cv, done),
					changed,
				};

			case "providerLimits":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: this.#formatProviderLimitsValue(currentValue),
					submenu: (_cv, done) => this.#createProviderLimitsInput(done),
					changed,
				};

			case "modelSelector":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: this.#formatModelSelectorValue(currentValue),
					submenu: (_cv, done) => this.#createModelSelectorInput(def.path, done),
					changed,
				};

			case "defaultEffort":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: this.#formatDefaultEffortValue(),
					submenu: (_cv, done) => this.#createDefaultEffortInput(done),
					changed,
				};

			case "modelRoles":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: this.#formatModelRolesValue(),
					submenu: (_cv, done) => this.#createModelRolesInput(done),
					changed,
				};

			case "subagentAgents":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: this.#formatSubagentAgentsValue(),
					submenu: (_cv, done) => this.#createSubagentAgentsInput(done),
					changed,
				};

			case "subagentModelByDepth":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: this.#formatSubagentModelByDepthValue(),
					submenu: (_cv, done) => this.#createSubagentModelByDepthInput(done),
					changed,
				};

			case "rules":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: this.#formatRulesValue(),
					submenu: (_cv, done) => this.#createRulesInput(done),
					changed,
				};

			case "defaultModel": {
				const active = settings.getModelRole(DEFAULT_MODEL_SLOT);
				const source = settings.getModelRoleSource(DEFAULT_MODEL_SLOT);
				const overridden =
					(source === "config-file" || source === "runtime") &&
					typeof active === "string" &&
					active.trim() !== currentValue;
				if (overridden) this.#expandedIds.add(def.path);
				return {
					id: def.path,
					label: overridden ? `${def.label} · ${source}` : def.label,
					description: overridden
						? `${def.description} Active ${this.#formatModelSelectorValue(active)} comes from ${SETTING_SOURCE_LABELS[source]}; this row changes the saved profile default.`
						: def.description,
					currentValue: overridden
						? `${this.#formatCompactModelSelectorValue(currentValue)} → ${this.#formatCompactModelSelectorValue(active)}`
						: this.#formatModelSelectorValue(currentValue),
					submenu: (_cv, done) => this.#createDefaultModelInput(done),
					changed,
				};
			}
		}
	}

	/**
	 * Get the current value for a setting.
	 */
	#getCurrentValue(def: SettingDef): unknown {
		// The default-model entry is synthetic (no schema key): it deliberately
		// reads the profile layer so a one-shot session override never masquerades
		// as the model that will be restored on the next launch.
		if (def.type === "defaultModel") return settings.getPersistedModelRole(DEFAULT_MODEL_SLOT);
		return settings.get(def.path);
	}

	#isChanged(def: SettingDef, currentValue: unknown): boolean {
		// Synthetic path: "changed" means a default model has been pinned (the
		// unset default resolves live to the auto-selected model). getDefault would
		// throw on the non-schema path.
		if (def.type === "defaultModel") return typeof currentValue === "string" && currentValue.trim().length > 0;
		return !Object.is(currentValue, getDefault(def.path));
	}

	#getSubmenuCurrentValue(path: SettingPath, value: unknown): string {
		const rawValue = String(value ?? "");
		// An optional numeric setting displays its unset state as the shared `Default`
		// row, whichever way the stored value spells it. The set of such paths comes
		// from the schema (isUnsetNumberPath), not a list maintained here, which used
		// to name three compaction paths and miss the six sampling ones.
		// An absent key reads back as the schema default, which for these paths is
		// undefined; a legacy config may still hold the old `-1` sentinel, and an
		// unmigrated project overlay always can, so both spell the Default row.
		if (isUnsetNumberPath(path) && (value === undefined || rawValue === String(UNSET_NUMBER) || rawValue === "")) {
			return UNSET_NUMBER_OPTION_VALUE;
		}
		return rawValue;
	}

	/**
	 * Create a chooser submenu for a bare enum setting (one with no option
	 * labels). Options are the enum's allowed values, labelled by their own text.
	 * Selection reports through `done(value)` only — the list's onChange dispatch
	 * (`#onSettingChange` / `#onSearchSettingChange`) owns the single persist for
	 * enum values, so this submenu must not write the value a second time.
	 */
	#createEnumSubmenu(
		def: SettingDef & { type: "enum" },
		currentValue: string,
		done: (value?: string) => void,
	): Container {
		const options: SelectItem[] = def.values.map(value => ({ value, label: value }));
		return new SelectSubmenu(
			def.label,
			def.description,
			options,
			currentValue,
			value => done(value),
			() => done(),
		);
	}

	/**
	 * The rows a submenu setting offers, including the ones only the runtime knows.
	 *
	 * ONE owner, because the picker and the row's own value label each used to
	 * decide: a runtime-populated row (a theme, a personality) labelled its value
	 * from an empty schema list and printed the raw stored string, while the picker
	 * showed the real rows.
	 */
	#submenuOptions(def: SettingDef & { type: "submenu" }): OptionList {
		if (def.path === "theme.dark" || def.path === "theme.light") {
			return this.context.availableThemes.map(name => ({ value: name, label: name }));
		}
		if (def.path === "personality") {
			return [
				...this.context.availablePersonalities.map(name => ({
					value: name,
					label: name.charAt(0).toUpperCase() + name.slice(1),
					description: BUILTIN_PERSONALITY_DESCRIPTIONS[name],
				})),
				{ value: NONE_PERSONALITY, label: "None", description: "Omit the personality block entirely" },
			];
		}
		// Effort is narrowed to what the model these subagents run actually accepts,
		// from the same helper `/effort` and every model picker use. A fixed ladder
		// here offered `xhigh` on models with no effort field at all, and `off` on
		// models that route effort through sibling model ids — picks that stored a
		// value the resolver then had to clamp or ignore.
		if (Object.hasOwn(EFFORT_SUBMENU_PATHS, def.path)) {
			return subagentEffortOptions(
				subagentEffortScope(this.context.availableModels, this.context.model),
				this.context.availableModels,
			).options;
		}
		return def.options;
	}

	/**
	 * Create a submenu for a submenu-type setting.
	 */
	#createSubmenu(
		def: SettingDef & { type: "submenu" },
		currentValue: string,
		done: (value?: string) => void,
	): Container {
		const effort = Object.hasOwn(EFFORT_SUBMENU_PATHS, def.path)
			? subagentEffortOptions(
					subagentEffortScope(this.context.availableModels, this.context.model),
					this.context.availableModels,
				)
			: undefined;
		const options = effort?.options ?? this.#submenuOptions(def);
		// A row whose only choice is "inherit" has nothing to pick, and saying why
		// beats a one-row list. WHICH sentence is true depends on the scope: a model
		// that decides effort through its model id exposes no effort field, a
		// catalog can declare no effort at all, and a chain naming a model this
		// session cannot resolve knows nothing either way. The scope owner picks.
		const description = effort?.notice ? `${def.description} ${effort.notice}` : def.description;

		// Preview handlers
		let onPreview: ((value: string) => void | Promise<void>) | undefined;
		let onPreviewCancel: (() => void) | undefined;
		const footer: Component | undefined = undefined;

		const activeThemeBeforePreview = getCurrentThemeName() ?? currentValue;
		if (def.path === "theme.dark" || def.path === "theme.light") {
			onPreview = value => {
				return this.callbacks.onThemePreview?.(value);
			};
			onPreviewCancel = () => {
				this.callbacks.onThemePreview?.(activeThemeBeforePreview);
			};
		} else if (def.path === "statusLine.preset") {
			onPreview = value => {
				const presetDef = getPreset(
					value as "default" | "minimal" | "compact" | "full" | "nerd" | "ascii" | "custom",
				);
				this.callbacks.onStatusLinePreview?.({
					preset: value as StatusLinePreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
				});
			};
			onPreviewCancel = () => {
				const currentPreset = settings.get("statusLine.preset");
				const presetDef = getPreset(currentPreset);
				this.callbacks.onStatusLinePreview?.({
					preset: currentPreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
				});
			};
		}

		// Provide status line preview for theme selection
		const isThemeSetting = def.path === "theme.dark" || def.path === "theme.light";
		const getPreview = isThemeSetting ? this.callbacks.getStatusLinePreview : undefined;

		return new SelectSubmenu(
			def.label,
			description,
			options,
			currentValue,
			value => {
				this.#setSettingValue(def.path, value);
				this.callbacks.onChange(def.path, value);
				done(value);
			},
			() => {
				onPreviewCancel?.();
				done();
			},
			onPreview,
			getPreview,
			footer,
		);
	}

	/**
	 * Create a text input submenu for a plain string setting.
	 */
	#createTextInput(
		def: SettingDef & { type: "text" },
		_currentValue: string,
		done: (value?: string) => void,
	): Container {
		this.#textInputActive = true;
		const wrappedDone = (value?: string) => {
			this.#textInputActive = false;
			done(value);
		};
		return new TextInputSubmenu(
			def.label,
			def.description,
			this.#formatTextInputEditValue(def.path, settings.get(def.path)),
			value => {
				// Empty string clears the setting; undefined-typed string settings
				// store "" which the browser.ts expandPath ignores (no-op fallback).
				this.#setSettingValue(def.path, value);
				this.callbacks.onChange(def.path, settings.get(def.path));
				wrappedDone(this.#formatTextInputValue(def.path, settings.get(def.path)));
			},
			() => wrappedDone(),
		);
	}

	#createProviderLimitsInput(done: (value?: string) => void): Container {
		return new ProviderLimitsSubmenu(
			this.context.providers,
			value => {
				this.callbacks.onChange("providers.maxInFlightRequests", value);
				done(this.#formatProviderLimitsValue(value));
			},
			() => done(),
			this.context.requestRender,
		);
	}

	#requireModelPickerContext(): { registry: ModelRegistry; models: ReadonlyArray<Model> } | undefined {
		const registry = this.context.modelRegistry;
		const models = this.context.availableModels;
		if (!registry || !models) return undefined;
		return { registry, models };
	}

	#formatModelSelectorValue(value: unknown): string {
		const selectors =
			typeof value === "string" || Array.isArray(value) ? normalizeModelPatternList(value as string | string[]) : [];
		const primary = selectors[0];
		if (!primary) return "inherit";
		const fallbacks = selectors.length - 1;
		return fallbacks > 0
			? `${formatSelectorSummary(primary)} +${fallbacks} fallback${fallbacks === 1 ? "" : "s"}`
			: formatSelectorSummary(primary);
	}

	/** Compact one selector for a row that must show both saved and active models. */
	#formatCompactModelSelectorValue(value: unknown): string {
		const summary = this.#formatModelSelectorValue(value);
		const providerSlash = summary.indexOf("/");
		return providerSlash >= 0 ? summary.slice(providerSlash + 1) : summary;
	}

	#formatModelRolesValue(): string {
		const roles = settings.getModelRoles();
		let assigned = 0;
		for (const role of SELECTABLE_MODEL_ROLE_IDS) {
			if (roles[role]?.trim()) assigned++;
		}
		if (assigned === 0) return "all inherit";
		return `${assigned} assigned`;
	}

	#createModelSelectorInput(path: SettingPath, done: (value?: string) => void): Container {
		const ctx = this.#requireModelPickerContext();
		if (!ctx) {
			const fallback = new Container();
			fallback.addChild(new Text(theme.fg("warning", "Model catalog unavailable in this context"), 0, 0));
			fallback.addChild(new Spacer(1));
			fallback.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			(fallback as Container & { handleInput?: (data: string) => void }).handleInput = data => {
				if (matchesKey(data, "escape") || data === "\x1b") done();
			};
			return fallback;
		}
		// `SettingValue<SettingPath>` collapses to never for the full path union;
		// widen and narrow by runtime type instead.
		const current: unknown = settings.get(path);
		let rawCurrent: string | string[] | undefined;
		if (typeof current === "string") {
			rawCurrent = current;
		} else if (Array.isArray(current) && current.every(value => typeof value === "string")) {
			rawCurrent = current;
		}
		const label =
			path === "subagent.model" ? "Subagent Model" : path === "compaction.model" ? "Compaction Model" : String(path);
		return new ModelChainSubmenu(
			path,
			ctx.registry,
			ctx.models,
			label,
			rawCurrent,
			done,
			value => this.callbacks.onChange(path, value),
			this.context.requestRender,
		);
	}

	/** Row summary for the threshold: `Auto`, `85%`, `200k`, or the invalid raw text. */
	#formatCompactionThresholdValue(): string {
		return formatThresholdShort(String(settings.get("compaction.threshold") ?? AUTO_COMPACTION_THRESHOLD));
	}

	#createCompactionThresholdInput(
		def: SettingDef & { type: "compactionThreshold" },
		done: (value?: string) => void,
	): Container {
		return new CompactionThresholdSubmenu(
			def.options,
			() => {
				this.callbacks.onChange("compaction.threshold", settings.get("compaction.threshold"));
			},
			() => done(this.#formatCompactionThresholdValue()),
			this.context.requestRender,
		);
	}

	/** Row-count summary for the settings row, e.g. `any model · high, 2 models`. */
	#formatDefaultEffortValue(): string {
		const rows = withLegacyDefaultEffort(
			settings.isConfigured("defaultEffort") ? settings.get("defaultEffort") : undefined,
			settings.get("defaultThinkingLevel"),
		);
		const any = rows[ANY_MODEL_EFFORT_KEY];
		const perModel = Object.keys(rows).filter(key => key !== ANY_MODEL_EFFORT_KEY).length;
		const parts: string[] = [];
		parts.push(any ? `any model · ${any}` : "model defaults");
		if (perModel > 0) parts.push(`${perModel} model${perModel === 1 ? "" : "s"}`);
		return parts.join(", ");
	}

	#createDefaultEffortInput(done: (value?: string) => void): Container {
		const ctx = this.#requireModelPickerContext();
		if (!ctx) {
			const fallback = new Container();
			fallback.addChild(new Text(theme.fg("warning", "Model catalog unavailable in this context"), 0, 0));
			fallback.addChild(new Spacer(1));
			fallback.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			(fallback as Container & { handleInput?: (data: string) => void }).handleInput = data => {
				if (matchesKey(data, "escape") || data === "\x1b") done();
			};
			return fallback;
		}
		return new DefaultEffortSubmenu(
			ctx.models,
			ctx.registry,
			() => {
				this.callbacks.onChange("defaultEffort", settings.get("defaultEffort"));
			},
			() => done(this.#formatDefaultEffortValue()),
			this.context.requestRender,
		);
	}

	/**
	 * Row summary for the Agents table: how many agents carry a row, and how many
	 * of those are blocked. Counting rows rather than discovered agents keeps this
	 * synchronous — discovery is async, and a row that says "6 agents" before the
	 * directories are read would be a guess.
	 */
	#formatSubagentAgentsValue(): string {
		const stored = settings.get("subagent.agents");
		const table = stored && typeof stored === "object" ? (stored as Record<string, SubagentAgentSettings>) : {};
		const rows = Object.values(table);
		if (rows.length === 0) return "defaults";
		const blocked = rows.filter(row => row?.enabled === false).length;
		const parts = [`${rows.length} configured`];
		if (blocked > 0) parts.push(`${blocked} blocked`);
		return parts.join(", ");
	}

	/**
	 * The roster opens with or without a model catalog: which lanes are offered and
	 * how deeply they may spawn need none, and the model it SHOWS is a resolved
	 * settings value. The catalog is passed when the host has one so the Model row
	 * can open the same chain picker the tab row does; without it that row says so
	 * instead of refusing the whole screen, which is what it used to do.
	 */
	#createSubagentAgentsInput(done: (value?: string) => void): Container {
		const active = this.context.model ? `${this.context.model.provider}/${this.context.model.id}` : undefined;
		return new SubagentAgentsSubmenu(
			this.context.cwd,
			active,
			this.context.model,
			this.context.availableModels,
			this.#requireModelPickerContext(),
			path => {
				this.callbacks.onChange(path, settings.get(path));
			},
			() => done(this.#formatSubagentAgentsValue()),
			this.context.requestRender,
		);
	}

	/**
	 * Row summary for Models by Depth: each configured depth with its chain's
	 * first model, e.g. `1: k3 +1, 2: opus`.
	 */
	#formatSubagentModelByDepthValue(): string {
		const rows = subagentModelByDepthRows(settings);
		if (rows.length === 0) return "off";
		return rows.map(row => `${row.depth}: ${this.#formatCompactModelSelectorValue(row.value)}`).join(", ");
	}

	#createSubagentModelByDepthInput(done: (value?: string) => void): Container {
		const ctx = this.#requireModelPickerContext();
		if (!ctx) {
			const fallback = new Container();
			fallback.addChild(new Text(theme.fg("warning", "Model catalog unavailable in this context"), 0, 0));
			fallback.addChild(new Spacer(1));
			fallback.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			(fallback as Container & { handleInput?: (data: string) => void }).handleInput = data => {
				if (matchesKey(data, "escape") || data === "\x1b") done();
			};
			return fallback;
		}
		return new SubagentModelByDepthSubmenu(
			ctx.registry,
			ctx.models,
			() => {
				this.callbacks.onChange(SUBAGENT_MODEL_BY_DEPTH_PATH, settings.get(SUBAGENT_MODEL_BY_DEPTH_PATH));
			},
			() => done(this.#formatSubagentModelByDepthValue()),
			this.context.requestRender,
		);
	}

	/**
	 * Row summary: how many rules are turned off, since that is the whole of what this
	 * setting stores. It deliberately does NOT say how many rules exist — discovery is
	 * async, and a synchronous "29 rules" printed on the settings row would be a guess.
	 *
	 * Opted-in experiments are counted separately rather than folded into "off",
	 * because they are the one thing here the operator turned ON deliberately, and
	 * a summary reading "all on" while an experiment sits enabled underneath it
	 * would hide the only non-default state on the screen.
	 */
	#formatRulesValue(): string {
		const stored = settings.get("ttsr.disabledRules");
		const off = Array.isArray(stored) ? stored.filter(name => String(name).trim().length > 0).length : 0;
		const enabledRaw = settings.get("ttsr.experimentalRules");
		const experiments = Array.isArray(enabledRaw)
			? enabledRaw.filter(name => String(name).trim().length > 0).length
			: 0;
		const experimentSuffix = experiments === 0 ? "" : `, ${experiments} experimental on`;
		if (settings.get("ttsr.builtinRules") !== true) {
			return (off === 0 ? "built-ins off" : `built-ins off, ${off} more off`) + experimentSuffix;
		}
		if (off === 0) return experiments === 0 ? "all on" : `all on${experimentSuffix}`;
		return `${off} off${experimentSuffix}`;
	}

	#createRulesInput(done: (value?: string) => void): Container {
		return new RulesSubmenu(
			this.context.cwd,
			() => {
				this.callbacks.onChange("ttsr.disabledRules", settings.get("ttsr.disabledRules"));
			},
			() => done(this.#formatRulesValue()),
			this.context.requestRender,
		);
	}

	#createModelRolesInput(done: (value?: string) => void): Container {
		const ctx = this.#requireModelPickerContext();
		if (!ctx) {
			const fallback = new Container();
			fallback.addChild(new Text(theme.fg("warning", "Model catalog unavailable in this context"), 0, 0));
			(fallback as Container & { handleInput?: (data: string) => void }).handleInput = data => {
				if (matchesKey(data, "escape") || data === "\x1b") done();
			};
			return fallback;
		}
		return new ModelRolesSubmenu(
			ctx.models,
			ctx.registry,
			() => {
				this.callbacks.onChange("modelRoles", settings.getModelRoles());
			},
			() => done(this.#formatModelRolesValue()),
			this.context.requestRender,
		);
	}

	#createDefaultModelInput(done: (value?: string) => void): Container {
		const ctx = this.#requireModelPickerContext();
		if (!ctx) {
			const fallback = new Container();
			fallback.addChild(new Text(theme.fg("warning", "Model catalog unavailable in this context"), 0, 0));
			fallback.addChild(new Spacer(1));
			fallback.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			(fallback as Container & { handleInput?: (data: string) => void }).handleInput = data => {
				if (matchesKey(data, "escape") || data === "\x1b") done();
			};
			return fallback;
		}
		return new DefaultModelSubmenu(
			ctx.models,
			ctx.registry,
			() =>
				this.callbacks.onChange(
					DEFAULT_MODEL_SETTING_ID as SettingPath,
					settings.getModelRole(DEFAULT_MODEL_SLOT) ?? "",
				),
			() => done(this.#formatModelSelectorValue(settings.getModelRole(DEFAULT_MODEL_SLOT))),
			() => this.context.requestRender?.(),
		);
	}

	#formatProviderLimitsValue(value: unknown): string {
		const limits = normalizeProviderMaxInFlightRequests(value);
		const entries = Object.entries(limits).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) return "Unlimited";
		return entries.map(([provider, limit]) => `${provider}: ${limit}`).join(", ");
	}

	#formatTextInputValue(path: SettingPath, value: unknown): string {
		if (path === "providers.maxInFlightRequests") return this.#formatProviderLimitsValue(value);
		return this.#formatTextInputEditValue(path, value);
	}

	#formatTextInputEditValue(_path: SettingPath, value: unknown): string {
		if (value === undefined || value === null) return "";
		// A string array edits as a comma-separated list (friendly for model ids,
		// segment names, and the like); a non-string array (objects) round-trips as
		// JSON so it is not silently flattened. #setSettingValue parses both back.
		if (Array.isArray(value)) {
			return value.every(item => typeof item === "string") ? value.join(", ") : JSON.stringify(value);
		}
		if (typeof value === "object") return JSON.stringify(value);
		return String(value);
	}

	/**
	 * Set a setting value, handling type conversion.
	 */
	#setSettingValue(path: SettingPath, value: string): void {
		const currentValue = settings.get(path);
		const schemaType = getType(path);
		if (isUnsetNumberPath(path) && value === UNSET_NUMBER_OPTION_VALUE) {
			// "Default" REMOVES the key rather than storing a sentinel, so the value
			// the provider would accept is not stolen to mean "no value".
			settings.unset(path);
		} else if (schemaType === "record") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value || "{}");
			} catch {
				throw new Error(`Invalid record JSON for ${path}`);
			}
			if (!isRecord(parsed)) {
				throw new Error(`Invalid record JSON for ${path}`);
			}
			if (path === "providers.maxInFlightRequests") {
				parsed = validateProviderMaxInFlightRequests(parsed);
			}
			settings.set(path, parsed as never);
		} else if (schemaType === "array") {
			// A leading `[` is treated as explicit JSON (object arrays and edited
			// JSON round-trips); anything else is a comma-separated list, trimmed with
			// empties dropped, so an empty box clears the array to []. This mirrors
			// #formatTextInputEditValue, so display and save round-trip.
			const trimmed = value.trim();
			let arr: unknown[];
			if (trimmed === "") {
				arr = [];
			} else if (trimmed.startsWith("[")) {
				let json: unknown;
				try {
					json = JSON.parse(trimmed);
				} catch {
					throw new Error(`Invalid JSON array for ${path}`);
				}
				if (!Array.isArray(json)) throw new Error(`Expected a JSON array for ${path}`);
				arr = json;
			} else {
				arr = trimmed
					.split(",")
					.map(entry => entry.trim())
					.filter(entry => entry.length > 0);
			}
			settings.set(path, arr as never);
		} else if (schemaType === "number") {
			// Keyed off the SCHEMA, not off `typeof currentValue`: an unset number reads
			// back `undefined`, so the old check fell through to the final `else` and
			// stored the raw STRING into a number setting.
			// The RAW value, not a trimmed one: ` 5` is a typo, and a control that silently
			// repairs input is a control that silently accepts the next thing it should
			// have refused. `parseNumberSetting` owns every case, including the empty box.
			const next = parseNumberSetting(path, value);
			if (next === UNSET_NUMBER_INPUT) settings.unset(path);
			else settings.set(path, next as never);
		} else if (typeof currentValue === "boolean") {
			settings.set(path, (value === "true") as never);
		} else {
			settings.set(path, value as never);
		}
	}

	/**
	 * Show a settings tab using definitions.
	 */
	#showSettingsTab(tabId: SettingTab): void {
		const defs = getSettingsForTab(tabId);

		const items = this.#buildItemsForDefs(defs, tabId);

		this.#currentList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				if (isAdvancedToggleId(id)) {
					this.#toggleAdvanced(tabId);
					this.#refreshCurrentTabItems(defs);
					return;
				}

				const def = defs.find(d => d.path === id);
				if (!def) return;

				const path = def.path;

				if (def.type === "boolean") {
					const boolValue = newValue === "true";
					settings.set(path, boolValue as never);
					this.callbacks.onChange(path, boolValue);

					if (tabId === "appearance") {
						this.#triggerStatusLinePreview();
					}
				} else if (def.type === "enum") {
					settings.set(path, newValue as never);
					this.callbacks.onChange(path, newValue);
				}
				// Submenu/text types already persisted the value inside their own
				// done callbacks before SettingsList re-dispatches here. Re-run the
				// definition-to-item mapping so condition-gated settings (e.g. the
				// Hindsight cluster guarded by memory.backend) appear/disappear
				// immediately instead of waiting for the next tab switch.
				this.#refreshCurrentTabItems(defs);
			},
			() => this.#close(),
			// The selector owns type-to-search and the footer hint; pin the
			// split sidebar width so the divider never jumps between tabs.
			{ typeToSearch: false, hint: "", layout: "flat", descriptionMode: "expand", expandedIds: this.#expandedIds },
		);
		this.#currentList.setHoverMotion({
			requestRender: () => this.context.requestRender?.(),
			enabled: modalRevealEnabled(),
		});
	}

	/** Whether the tab's "Advanced" fold is currently expanded (default: collapsed). */
	#isAdvancedExpanded(tab: SettingTab): boolean {
		return this.#showAdvanced.get(tab) === true;
	}

	/** Flip the tab's "Advanced" fold state. */
	#toggleAdvanced(tab: SettingTab): void {
		this.#showAdvanced.set(tab, !this.#isAdvancedExpanded(tab));
	}

	/**
	 * Map a definition list to UI items, dropping any whose condition is false.
	 * Inserts a heading row whenever the (group-sorted) definition list crosses
	 * into a new group; groups whose items are all condition-hidden emit none.
	 *
	 * `advanced` defs are pulled out of the normal group flow and rendered
	 * after a single collapsible "▸ Advanced (N)" row appended at the end of
	 * the tab: hidden while collapsed unless their value differs from default
	 * (changed values always surface), shown in full once expanded. The count
	 * in the heading always reflects every advanced def, not just the hidden
	 * ones, so it doesn't shift as changed values get surfaced.
	 */
	#buildItemsForDefs(defs: SettingDef[], tabId: SettingTab): SettingItem[] {
		const items: SettingItem[] = [];
		const advancedItems: Array<{ group: string | undefined; item: SettingItem }> = [];
		let lastGroup: string | undefined;
		let advancedTotal = 0;
		for (const def of defs) {
			const item = this.#defToItem(def);
			if (!item) continue;
			if (def.advanced) {
				advancedTotal++;
				advancedItems.push({ group: def.group, item });
				continue;
			}
			if (def.group && def.group !== lastGroup) {
				items.push({ id: `__heading:${def.group}`, label: def.group, currentValue: "", heading: true });
				lastGroup = def.group;
			}
			items.push(item);
			// Rolling back is not a setting: it has no stored value and no default,
			// it is an action you take once. But it belongs next to the update
			// settings, because "updates happen automatically" and "I can undo one"
			// are the same question, and answering only the first is what made
			// updates feel like something done to you. So it is a row in the group
			// rather than a schema entry, sitting under the toggle it qualifies.
			const rollbackRow = this.#rollbackRow(def);
			if (rollbackRow) items.push(rollbackRow);
		}

		if (advancedTotal > 0) {
			const expanded = this.#isAdvancedExpanded(tabId);
			const arrow = expanded ? theme.nav.collapse : theme.nav.expand;
			items.push({
				id: advancedToggleId(tabId),
				label: `${arrow} Advanced (${advancedTotal})`,
				currentValue: "",
				// A single-value cycle keeps this row activatable (Enter/Space/click)
				// like any other setting row, without pi-tui's inert `heading` rows.
				values: ["toggle"],
			});
			let lastAdvancedGroup: string | undefined;
			for (const { group, item } of advancedItems) {
				if (!expanded && !item.changed) continue;
				if (group && group !== lastAdvancedGroup) {
					items.push({
						id: `__heading:advanced:${group}`,
						label: `Advanced · ${group}`,
						currentValue: "",
						heading: true,
					});
					lastAdvancedGroup = group;
				}
				items.push(item);
			}
		}

		return items;
	}

	/**
	 * The "Roll back version" row, when the host can actually perform one.
	 *
	 * Anchored after `startup.autoUpdate` rather than at a fixed index, so it
	 * stays under the toggle it qualifies however the group is later reordered.
	 */
	#rollbackRow(def: SettingDef): SettingItem | null {
		if (def.path !== "startup.autoUpdate") return null;
		const rollback = this.callbacks.onRollback;
		if (!rollback) return null;
		return {
			id: ROLLBACK_ROW_ID,
			label: "Roll back version",
			description: "Move this install to another published version. Takes effect on restart.",
			currentValue: VERSION,
			group: def.group,
			keywords: ["downgrade", "revert", "version", "previous", "older"],
			submenu: (_cv, done) =>
				new RollbackPanelComponent({
					currentVersion: VERSION,
					openUrl: url => this.callbacks.onOpenUrl?.(url),
					rollback,
					reportError: message => this.callbacks.onError?.(message),
					requestRender: () => this.context.requestRender?.(),
					done: () => done(),
				}),
		};
	}

	/** Re-evaluate condition gates against the current settings and refresh the active list. */
	#refreshCurrentTabItems(defs: SettingDef[]): void {
		const tabId = this.#currentTabId;
		if (tabId === "plugins" || !this.#currentList) return;
		this.#currentList.setItems(this.#buildItemsForDefs(defs, tabId));
	}

	/**
	 * Get the status line preview string.
	 */
	#getStatusPreviewString(): string {
		if (this.callbacks.getStatusLinePreview) {
			return this.callbacks.getStatusLinePreview();
		}
		return theme.fg("dim", "(preview not available)");
	}

	/**
	 * Trigger status line preview with current settings.
	 */
	#triggerStatusLinePreview(): void {
		const statusLineSettings: StatusLinePreviewSettings = {
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			sessionAccent: settings.get("statusLine.sessionAccent"),
		};
		this.callbacks.onStatusLinePreview?.(statusLineSettings);
	}

	#showPluginsTab(): void {
		this.#pluginComponent = new PluginSettingsComponent(this.context.cwd, {
			onClose: () => this.#close(),
			onPluginChanged: () => this.callbacks.onPluginsChanged?.(),
		});
	}

	/** Step the active category up/down, clamped at the ends (no wrap). */
	#stepCategory(delta: -1 | 1): void {
		const tabs = getSettingsTabs();
		const index = tabs.findIndex(tab => tab.id === this.#tabBar.getActiveTab().id);
		if (index === -1) return;
		const next = Math.min(tabs.length - 1, Math.max(0, index + delta));
		const target = tabs[next];
		if (next !== index && target) this.#tabBar.selectTab(target.id);
	}

	handleInput(data: string): void {
		// SGR mouse reports (the fullscreen overlay enables tracking).
		if (data.startsWith("\x1b[<")) {
			this.#handleMouse(data);
			return;
		}

		if (this.#viewportTooSmall) {
			if (matchesKey(data, "escape") || data === "\x1b") this.#close();
			return;
		}

		// Text-input submenus take every byte: arrow keys must reach the
		// cursor and Tab must not switch tabs.
		if (this.#textInputActive) {
			(this.#searchList ?? this.#currentList)?.handleInput(data);
			return;
		}

		const activeList = this.#searchList ?? this.#currentList;

		// An open submenu owns input entirely — Tab/arrows/typing belong to it.
		if (activeList?.hasOpenSubmenu()) {
			activeList.handleInput(data);
			return;
		}

		if (this.#searchList) {
			this.#handleSearchModeInput(data, this.#searchList);
			return;
		}

		// Sidebar focus mode: Up/Down step categories without wrapping;
		// Right/Enter (or Tab) hand focus back to the settings rows. Anything
		// else (search, hotkeys) falls through to the shared handling below.
		if (this.#sidebarFocused) {
			if (matchesKey(data, "up") || data === "k") {
				this.#stepCategory(-1);
				return;
			}
			if (matchesKey(data, "down") || data === "j") {
				this.#stepCategory(1);
				return;
			}
			if (
				matchesKey(data, "right") ||
				data === "l" ||
				getKeybindings().matches(data, "tui.select.confirm") ||
				data === "\n" ||
				matchesKey(data, "tab")
			) {
				this.#sidebarFocused = false;
				return;
			}
			// Already on the leftmost column — swallow so the tab bar never wraps.
			if (matchesKey(data, "left") || data === "h") return;
		}

		// Left/Right never change a setting's value: value edits go through
		// activation (Enter/Space/click), which toggles a boolean or opens a
		// chooser for an enum. That keeps Left free for sidebar focus and Right
		// for description expand, with no collision against sidebar navigation.

		// Right/l expands the selected setting description; Left/h collapses.
		if (matchesKey(data, "right") || data === "l") {
			const id = this.#currentList?.getSelectedItem()?.id;
			if (id) {
				this.#expandedIds.add(id);
				this.#currentList?.setOptions({ expandedIds: this.#expandedIds, descriptionMode: "expand" });
				return;
			}
		}
		if (matchesKey(data, "left") || data === "h") {
			const id = this.#currentList?.getSelectedItem()?.id;
			if (id && this.#expandedIds.has(id)) {
				this.#expandedIds.delete(id);
				this.#currentList?.setOptions({ expandedIds: this.#expandedIds, descriptionMode: "expand" });
				return;
			}
			// No expanded desc: Left focuses the category sidebar (it sits to
			// the visual left). It must never wrap-cycle tabs — Left on the
			// first category used to jump to the last one and lose the caret.
			this.#sidebarFocused = true;
			return;
		}

		// Tab toggles keyboard focus between section headings and setting rows
		// (fast section hopping); tabs without sections keep Tab switching tabs.
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			if (this.#currentList?.hasSectionFocusTargets()) {
				this.#currentList.toggleSectionFocus();
				return;
			}
			this.#tabBar.handleInput(data);
			return;
		}

		// Printable characters start a search across every settings tab. The
		// plugins tab keeps its own local filtering instead.
		if (this.#currentTabId !== "plugins") {
			const printable = extractPrintableText(data);
			if (printable !== undefined && printable.trim().length > 0) {
				this.#startSearch(printable);
				return;
			}
		}

		if (this.#currentList) {
			this.#currentList.handleInput(data);
		} else if (this.#pluginComponent) {
			this.#pluginComponent.handleInput(data);
		}
	}

	#handleSearchModeInput(data: string, list: SettingsList): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			// Exit search, landing on the tab of the selected result.
			this.#endSearch(true);
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			// Jump between tabs that have matches (muted tabs are skipped).
			this.#tabBar.handleInput(data);
			return;
		}
		// Selection, paging, and activation stay with the result list.
		if (
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.pageUp") ||
			kb.matches(data, "tui.select.pageDown") ||
			kb.matches(data, "tui.select.confirm") ||
			data === "\n"
		) {
			list.handleInput(data);
			return;
		}
		// Everything else edits the query like a regular single-line editor:
		// cursor movement, word ops, kill ring, undo, paste.
		this.#searchInput.handleInput(data);
		const value = this.#searchInput.getValue();
		if (value !== this.#searchQuery) this.#setSearchQuery(value);
	}
}
