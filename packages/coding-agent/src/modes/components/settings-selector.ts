import { AUTO_COMPACTION_THRESHOLD, parseCompactionThreshold, type ThinkingLevel } from "@veyyon/agent-core";
import { type Api, type Effort, type Model, THINKING_EFFORTS } from "@veyyon/ai";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
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
	routeSelectListMouse,
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
import { clamp, errorMessage, VERSION } from "@veyyon/utils";
import { ANY_MODEL_EFFORT_KEY, withLegacyDefaultEffort } from "../../config/effort-resolver";
import type { ModelRegistry } from "../../config/model-registry";
import { extractExplicitThinkingSelector, resolveModelRoleValue } from "../../config/model-resolver";
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
	settings,
	validateProviderMaxInFlightRequests,
} from "../../config/settings";
import type { SubagentAgentSettings } from "../../config/settings-domains/subagents";
import type {
	SettingTab,
	StatusLinePreset,
	StatusLineSegmentId,
	StatusLineSeparatorStyle,
	SubmenuOption,
} from "../../config/settings-schema";
import { isUnsetNumberPath, SETTING_TABS, TAB_METADATA } from "../../config/settings-schema";
import { getCurrentThemeName, getSelectListTheme, getSettingsListTheme, theme } from "../../modes/theme/theme";
import { BUILTIN_PERSONALITY_DESCRIPTIONS, NONE_PERSONALITY } from "../../personality/resolver";
import { discoverAgents } from "../../task/discovery";
import {
	nextSubagentEnableValue,
	resolveSubagentModel,
	resolveSubagentThinkingLevel,
	SUBAGENT_ENABLE_STATE_LABEL,
	subagentEnableState,
	subagentModelSourceLabel,
	subagentSettingsFor,
} from "../../task/subagent-settings";
import type { AgentDefinition } from "../../task/types";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	configuredThinkingLevelOptions,
	INHERIT_EFFORT_OPTION_VALUE,
} from "../../thinking";
import { getTabBarTheme } from "../shared";
import { formatSelectorSummary, renderEffortStep } from "./effort-picker";
import {
	applyModalReveal,
	BREADCRUMB_HOVER_ID,
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_SETTINGS,
	planModalChrome,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	renderModalShell,
	SETTINGS_BROWSE_SHORTCUTS,
	SETTINGS_FILTER_SHORTCUTS,
	SETTINGS_SUBPANE_SHORTCUTS,
	withCompact,
} from "./modal-shell";
import { ModelSelectorPanel } from "./model-selector";
import { handleInputOrEscape, PluginSettingsComponent } from "./plugin-settings";
import { RollbackPanelComponent } from "./rollback-panel";
import { DEFAULT_MODEL_SETTING_ID, getSettingDef, getSettingsForTab, type SettingDef } from "./settings-defs";
import { getPreset } from "./status-line/presets";

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

class SelectSubmenu extends Container {
	#selectList: SelectList;
	#previewText: Text | null = null;
	#previewUpdateRequestId: number = 0;
	#selectListLineOffset = 0;

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
	 * Concatenate children like Container.render, recording where the select
	 * list lands so routed mouse events can be hit-tested against it.
	 */
	override render(width: number): readonly string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(Math.max(1, width));
			if (child === this.#selectList) {
				this.#selectListLineOffset = lines.length;
			}
			lines.push(...childLines);
		}
		return lines;
	}

	/** Mouse routed from the host: wheel steps, hover lights, click confirms. */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		routeSelectListMouse(this.#selectList, event, line - this.#selectListLineOffset);
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
class CompactionThresholdSubmenu extends Container {
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

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

class ProviderLimitsSubmenu extends Container {
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
 * Role list → reusable {@link ModelSelectorPanel} for each role.
 * Assignments write through `settings.setModelRole` (profile-scoped).
 */
class ModelRolesSubmenu extends Container {
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
					const efforts = getSupportedEfforts(model);
					if (efforts.length === 0) {
						this.#persistRole(role, selector);
						return;
					}
					this.#showEffortPicker(role, selector, efforts);
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
		this.addChild(panel);
	}

	#showEffortPicker(role: string, selector: string, efforts: readonly Effort[]): void {
		this.#selectList = renderEffortStep(
			this,
			selector,
			efforts,
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
const AGENT_ROW_OFFERED = "\\u0000agent-offered";
const AGENT_ROW_MODEL = "\\u0000agent-model";
const AGENT_ROW_EFFORT = "\\u0000agent-effort";
const AGENT_ROW_RESET = "\\u0000agent-reset";

/**
 * The `subagent.agents` table: the discovered agents, each with its offered
 * state, its model and its effort.
 *
 * Every answer comes from `task/subagent-settings.ts` — the enable default, the
 * state wording, the model precedence and the layer that decided it — so this and
 * `/agents` cannot describe the same row differently. It edits settings rows only;
 * writing an agent FILE stays in `/agents`, which is why the footer points there.
 *
 * The list is discovered rather than read off the stored table: a row exists only
 * once something is overridden, so a table-driven list would be empty on a stock
 * install and would hide exactly the specialists the operator came to turn on.
 */
class SubagentAgentsSubmenu extends Container {
	#selectList: SelectList | undefined;
	#agents: AgentDefinition[] = [];
	#loadError: string | undefined;
	#loaded = false;

	constructor(
		private readonly cwd: string,
		private readonly models: ReadonlyArray<Model>,
		private readonly registry: ModelRegistry,
		/** The session's live model, so an inheriting row shows what it will actually run. */
		private readonly activeModelPattern: string | undefined,
		private readonly onChange: () => void,
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
	 * Write one agent's row, dropping empty fields and the row itself when nothing
	 * is left. An empty row and no row must not be distinguishable: a bare `{}` in
	 * the file reads as "configured" to anything checking for a row.
	 */
	#writeRow(name: string, next: SubagentAgentSettings): void {
		const table = this.#table();
		const cleaned: SubagentAgentSettings = {};
		if (next.enabled !== undefined) cleaned.enabled = next.enabled;
		if (next.model?.trim()) cleaned.model = next.model.trim();
		if (next.thinkingLevel?.trim()) cleaned.thinkingLevel = next.thinkingLevel.trim();
		if (Object.keys(cleaned).length === 0) delete table[name];
		else table[name] = cleaned;
		settings.set("subagent.agents", table);
		this.onChange();
	}

	/** One agent's model column: the resolved pattern plus the layer that chose it. */
	#modelSummary(agent: AgentDefinition): string {
		const resolved = resolveSubagentModel({
			settings,
			agentName: agent.name,
			agentModel: agent.model,
			activeModelPattern: this.activeModelPattern,
		});
		if (resolved.unresolved) return theme.fg("error", `${resolved.unresolved.value} matches no model`);
		const pattern = resolved.patterns[0];
		if (!pattern) return theme.fg("dim", "no model resolved");
		const summary = formatSelectorSummary(pattern);
		return resolved.source === "inherit"
			? theme.fg("dim", `inherit · ${summary}`)
			: `${summary} ${theme.fg("dim", `· ${subagentModelSourceLabel(resolved.source, agent.name)}`)}`;
	}

	#showAgentList(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Agents")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg("muted", "Which agent types this session offers, and what each one runs. A blank model inherits."),
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
			this.addChild(new Text(theme.fg("dim", "  Reading agents…"), 0, 0));
			return;
		}

		const items: SelectItem[] = this.#agents.map(agent => ({
			value: agent.name,
			label: agent.name,
			description: `${SUBAGENT_ENABLE_STATE_LABEL[subagentEnableState(agent, this.#row(agent.name).enabled)]} · ${this.#modelSummary(agent)}`,
		}));
		if (items.length === 0) {
			this.addChild(new Text(theme.fg("dim", "  No agents found."), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Esc to go back"), 0, 0));
			return;
		}

		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			this.#showAgentEditor(item.value);
			this.requestRender?.();
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("dim", "  Enter to configure · /agents to write agent files · Esc to go back"), 0, 0),
		);
	}

	#agent(name: string): AgentDefinition | undefined {
		return this.#agents.find(candidate => candidate.name === name);
	}

	#showAgentEditor(name: string): void {
		const agent = this.#agent(name);
		if (!agent) {
			this.#showAgentList();
			return;
		}
		const row = this.#row(name);
		const resolvedEffort = resolveSubagentThinkingLevel({ settings, agentName: name });

		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", `Agent: ${name}`)), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", agent.description || `${agent.source} agent`), 0, 0));
		this.addChild(new Spacer(1));

		const items: SelectItem[] = [
			{
				value: AGENT_ROW_OFFERED,
				label: "Offered",
				description: SUBAGENT_ENABLE_STATE_LABEL[subagentEnableState(agent, row.enabled)],
			},
			{ value: AGENT_ROW_MODEL, label: "Model", description: this.#modelSummary(agent) },
			{
				value: AGENT_ROW_EFFORT,
				label: "Effort",
				description: row.thinkingLevel?.trim()
					? row.thinkingLevel.trim()
					: theme.fg("dim", `inherit${resolvedEffort ? ` · ${resolvedEffort}` : ""}`),
			},
		];
		if (Object.keys(row).length > 0) {
			items.push({
				value: AGENT_ROW_RESET,
				label: "Reset to defaults",
				description: theme.fg("dim", `clears subagent.agents.${name}`),
			});
		}

		this.#selectList = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		this.#selectList.onSelect = item => {
			switch (item.value) {
				case AGENT_ROW_OFFERED:
					this.#writeRow(name, { ...row, enabled: nextSubagentEnableValue(row.enabled) });
					this.#showAgentEditor(name);
					break;
				case AGENT_ROW_MODEL:
					this.#showAgentModelPicker(name);
					break;
				case AGENT_ROW_EFFORT:
					this.#showAgentEffortPicker(name);
					break;
				case AGENT_ROW_RESET:
					this.#writeRow(name, {});
					this.#showAgentEditor(name);
					break;
			}
			this.requestRender?.();
		};
		this.#selectList.onCancel = () => {
			this.#showAgentList();
			this.requestRender?.();
		};
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to change · Esc to go back"), 0, 0));
	}

	#showAgentModelPicker(name: string): void {
		const agent = this.#agent(name);
		if (!agent) return;
		this.clear();
		this.#selectList = undefined;
		// What this agent would run with no row of its own, so clearing the override
		// says where the value comes from next instead of just "inherit".
		const withoutRow = resolveSubagentModel({
			settings,
			agentName: name,
			agentModel: agent.model,
			activeModelPattern: this.activeModelPattern,
			ignoreAgentRow: true,
		});
		const cleared = withoutRow.patterns[0] ? formatSelectorSummary(withoutRow.patterns[0]) : "the session model";
		this.addChild(
			new ModelSelectorPanel(
				settings,
				this.registry,
				this.models,
				{
					title: `${name} model`,
					description: `Model for the \`${name}\` subagent. Del or the (inherit) row clears it, leaving ${cleared} (${subagentModelSourceLabel(withoutRow.source, name)}).`,
					currentSelector: barePickerSelector(this.#row(name).model?.trim(), this.models as Model<Api>[]),
					allowClear: true,
				},
				{
					onPick: (model, selector) => {
						const efforts = getSupportedEfforts(model);
						if (efforts.length === 0) {
							this.#persistAgentModel(name, selector);
							return;
						}
						this.#selectList = renderEffortStep(
							this,
							selector,
							efforts,
							value => this.#persistAgentModel(name, value),
							() => {
								this.#showAgentModelPicker(name);
								this.requestRender?.();
							},
						);
						this.requestRender?.();
					},
					onClear: () => {
						this.#writeRow(name, { ...this.#row(name), model: undefined });
						this.#showAgentEditor(name);
						this.requestRender?.();
					},
					onCancel: () => {
						this.#showAgentEditor(name);
						this.requestRender?.();
					},
				},
			),
		);
	}

	#persistAgentModel(name: string, value: string): void {
		this.#writeRow(name, { ...this.#row(name), model: value });
		this.#showAgentEditor(name);
		this.requestRender?.();
	}

	/**
	 * Per-agent effort, with an inherit row: a per-agent effort the operator cannot
	 * clear from the UI is a value they can only undo by editing the file.
	 */
	#showAgentEffortPicker(name: string): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", `${name} effort`)), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg("muted", "Effort this subagent runs at. Inherit follows Subagent Effort, then the session."),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		// The same rows as the blanket Subagent Effort setting, from the one effort
		// vocabulary — a second list here is how two surfaces come to disagree about
		// which levels exist. Only the inherit row's wording differs, because here it
		// falls back to that blanket setting first.
		const items: SelectItem[] = configuredThinkingLevelOptions().map(option =>
			option.value === INHERIT_EFFORT_OPTION_VALUE
				? { value: option.value, label: "Inherit", description: "Follow Subagent Effort, then the session" }
				: { value: option.value, label: option.label, description: option.description },
		);
		this.#selectList = new SelectList(items, clamp(items.length, 1, 12), getSelectListTheme());
		this.#selectList.onSelect = item => {
			this.#writeRow(name, { ...this.#row(name), thinkingLevel: item.value || undefined });
			this.#showAgentEditor(name);
			this.requestRender?.();
		};
		this.#selectList.onCancel = () => {
			this.#showAgentEditor(name);
			this.requestRender?.();
		};
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to choose · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}

/** Synthetic list id for the "add a model" row: not a settings key, and never a
 *  model selector, so it cannot collide with a real row. */
const ADD_EFFORT_ROW = "\u0000add-effort-row";

/**
 * The profile's Default Effort list: rows of model to effort, plus one "any
 * model" row that covers every model without its own.
 *
 * This is the ONE persisted effort surface. Effort used to be split across a
 * profile-wide `defaultThinkingLevel` enum and a `:level` suffix on each role's
 * selector, so two settings wrote one axis and neither said which won (operator
 * report 2026-07-24, "effort level is very muddled"). `config/effort-resolver.ts`
 * owns the ordering; this owns the editing. Adding a row reuses the same
 * searchable model picker and the same effort list the role slots use, so a
 * third effort vocabulary cannot appear here.
 */
class DefaultEffortSubmenu extends Container {
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
		return withLegacyDefaultEffort(settings.get("defaultEffort"), settings.get("defaultThinkingLevel"));
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
		this.addChild(panel);
	}

	#showEffortPicker(key: string, picked?: Model): void {
		const model = picked ?? this.models.find(m => `${m.provider}/${m.id}` === key);
		// The any-model row is not a model, so its choices are every effort veyyon
		// knows; a model row offers what that model supports.
		const efforts = key === ANY_MODEL_EFFORT_KEY || !model ? [...THINKING_EFFORTS] : [...getSupportedEfforts(model)];
		this.#selectList = renderEffortStep(
			this,
			key === ANY_MODEL_EFFORT_KEY ? "any model" : key,
			efforts,
			value => this.#persist(key, value),
			() => {
				this.#showRows();
				this.requestRender?.();
			},
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
 * Single-slot picker for the profile's DEFAULT model — the model each new
 * session starts on. Opens straight to the model picker (there is only one slot,
 * no role list), then a thinking-effort step, and persists to the `default`
 * model-role slot via {@link Settings.setModelRole}. That is the exact slot the
 * interactive `/model` choice writes to (LEGACY_DEFAULT_MODEL_ROLE) and startup
 * restores from, so this reads and writes ONE source of truth, profile-scoped.
 * Del clears the pin, letting the default resolve to the auto-selected model.
 */
class DefaultModelSubmenu extends Container {
	#selectList: SelectList | undefined;

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
		this.#selectList = undefined;
		const current = settings.getModelRole(DEFAULT_MODEL_SLOT)?.trim();
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
				onPick: (model, selector) => {
					const efforts = getSupportedEfforts(model);
					if (efforts.length === 0) {
						this.#persist(selector);
						return;
					}
					this.#showEffortPicker(selector, efforts);
					this.requestRender?.();
				},
				onClear: () => {
					settings.setModelRole(DEFAULT_MODEL_SLOT, undefined);
					this.onChange();
					this.onCancel();
				},
				onCancel: () => this.onCancel(),
			},
		);
		this.addChild(panel);
	}

	#showEffortPicker(selector: string, efforts: readonly Effort[]): void {
		this.#selectList = renderEffortStep(
			this,
			selector,
			efforts,
			value => this.#persist(value),
			() => {
				this.#showModelPicker();
				this.requestRender?.();
			},
		);
	}

	#persist(value: string): void {
		settings.setModelRole(DEFAULT_MODEL_SLOT, value);
		this.onChange();
		this.onCancel();
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
 * Two-step picker for a single-model settings slot (`compaction.model`,
 * `subagent.model`): pick a model, then pick a thinking effort for it. The
 * effort rides the stored selector as a `:level` suffix (via
 * {@link renderEffortStep}), the same encoding the advisor model
 * assignment uses, so the one stored value both persists per profile and is
 * applied at run time: the compaction candidate resolver and the subagent
 * spawner each parse the suffix back into a thinking level. Models with no
 * supported efforts skip the second step and persist the bare selector.
 */
class ModelEffortSubmenu extends Container {
	#selectList: SelectList | undefined;

	constructor(
		private readonly path: SettingPath,
		private readonly registry: ModelRegistry,
		private readonly models: ReadonlyArray<Model>,
		private readonly title: string,
		private readonly currentSelector: string | undefined,
		private readonly done: (value?: string) => void,
		private readonly onChange: (value: string | undefined) => void,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#showModelPicker();
	}

	#showModelPicker(): void {
		this.clear();
		this.#selectList = undefined;
		const panel = new ModelSelectorPanel(
			settings,
			this.registry,
			this.models,
			{
				title: this.title,
				description: "Searchable catalog · auth / local / no auth shown on each row.",
				currentSelector: this.currentSelector || undefined,
				allowClear: true,
			},
			{
				onPick: (model, selector) => {
					const efforts = getSupportedEfforts(model);
					if (efforts.length === 0) {
						this.#persist(selector);
						return;
					}
					this.#showEffortPicker(selector, efforts);
					this.requestRender?.();
				},
				onClear: () => {
					settings.set(this.path, undefined as never);
					this.onChange(undefined);
					this.done("inherit");
				},
				onCancel: () => this.done(),
			},
		);
		this.addChild(panel);
	}

	#showEffortPicker(selector: string, efforts: readonly Effort[]): void {
		this.#selectList = renderEffortStep(
			this,
			selector,
			efforts,
			value => this.#persist(value),
			() => {
				this.#showModelPicker();
				this.requestRender?.();
			},
		);
	}

	#persist(value: string): void {
		settings.set(this.path, value as never);
		this.onChange(value);
		this.done(value);
	}

	handleInput(data: string): void {
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

/** Footer chips while keyboard focus rests on the category sidebar. */
const SETTINGS_SIDEBAR_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down category" },
	{ label: "right/enter settings" },
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
	separator?: StatusLineSeparatorStyle;
	sessionAccent?: boolean;
	transparent?: boolean;
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
		this.#switchToTab(tabId);
	}

	invalidate(): void {
		this.#tabBar.invalidate();
		this.#currentList?.invalidate();
		this.#searchList?.invalidate();
		this.#pluginComponent?.invalidate();
	}

	/** Swap the active content (per-tab list, search list, or plugins). */
	#setContent(build: () => void): void {
		this.#currentList = null;
		this.#searchList = null;
		this.#pluginComponent = null;
		build();
	}

	#switchToTab(tabId: SettingTab | "plugins"): void {
		this.#currentTabId = tabId;
		this.#setContent(() => {
			if (tabId === "plugins") {
				this.#showPluginsTab();
			} else {
				this.#showSettingsTab(tabId);
			}
		});
	}

	#settingsShortcuts() {
		if (this.#searchList) return SETTINGS_FILTER_SHORTCUTS;
		if ((this.#searchList ?? this.#currentList)?.hasOpenSubmenu()) return SETTINGS_SUBPANE_SHORTCUTS;
		if (this.#sidebarFocused) return SETTINGS_SIDEBAR_SHORTCUTS;
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

	/**
	 * Floating ModalShell settings card: always-on search chrome, body list,
	 * tip, centered shortcut chips. Transcript visible around the card.
	 */
	render(width: number): readonly string[] {
		const termHeight = Math.max(14, process.stdout.rows || 40);
		const compact = termHeight < 24;
		const sizing = withCompact(MODAL_SIZING_SETTINGS, compact);
		const dims = computeModalDims(width, termHeight, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: termHeight }, () => padding(width));
		}
		// Must match ModalShell's contentWidth — provisional maxWidth math
		// over-sized the search banner and fit() chopped off the match count.
		const contentWidth = dims.contentWidth;

		// Vertical category sidebar on the left, settings pane on the right,
		// separated by a silver hairline: `sidebar │  pane`.
		const sidebarWidth = this.#sidebarWidth(contentWidth);
		const paneWidth = Math.max(20, contentWidth - sidebarWidth - SIDEBAR_GAP_COLS);
		// The cursor brightens while the sidebar itself holds keyboard focus.
		const sidebarCursor = this.#sidebarFocused ? `${theme.fg("accent", theme.nav.cursor)} ` : `${theme.nav.cursor} `;
		const sidebarLines = this.#tabBar.renderVertical(sidebarWidth, sidebarCursor);
		const searching = this.#searchList !== null;
		const showPreview = !searching && this.#currentTabId === "appearance";
		// The preview is a live status-line render: clamp every line to the
		// pane so a wide preview can't punch through the modal's right border.
		const previewLines = showPreview
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
		const settingsShortcuts = this.#settingsShortcuts();
		const estimatedBody = Math.max(
			1,
			planModalChrome({
				sizing,
				modalHeight: dims.modalHeight,
				contentWidth,
				shortcuts: settingsShortcuts,
				hoveredShortcutId: this.#hoveredShortcutId,
				tipCandidates: SETTINGS_TIPS,
				hasSearch: true,
			}).maxBodyRows,
		);
		const list = this.#searchList ?? this.#currentList;
		let listLines: readonly string[] = [];
		if (list) {
			list.setMaxVisible(Math.max(8, estimatedBody - previewLines.length));
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

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (chrome.kind === "hover-shortcut") {
			if (this.#hoveredShortcutId !== chrome.id) {
				this.#hoveredShortcutId = chrome.id;
				this.context.requestRender?.();
			}
			return true;
		}
		if (chrome.kind === "close" || chrome.kind === "outside") {
			this.callbacks.onCancel();
			return true;
		}
		if (chrome.kind === "breadcrumb") {
			// Peel one sub-pane level back to Browse — same as the "esc back"
			// footer chip, just reachable from the title too.
			(this.#searchList ?? this.#currentList)?.handleInput("\x1b");
			return true;
		}
		if (chrome.kind === "shortcut") {
			if (chrome.id === "close") {
				this.callbacks.onCancel();
				return true;
			}
			if (chrome.id === "clear-filter") {
				this.#endSearch(true);
				return true;
			}
			if (chrome.id === "back") {
				(this.#searchList ?? this.#currentList)?.handleInput("\x1b");
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
				// An open submenu owns the pane pointer (text inputs ignore it).
				if (list?.hasOpenSubmenu()) list.routeSubmenuMouse(event, bodyLine, paneCol);
				else list?.handleWheelAt(event.wheel, bodyLine, paneCol);
			}
			return true;
		}

		if (event.motion) {
			const hovered = overSidebar ? this.#tabBar.tabAt(bodyLine, innerCol) : undefined;
			this.#tabBar.setHoverTab(hovered && !hovered.muted ? hovered.id : null);
			if (list?.hasOpenSubmenu()) {
				// Only rows the pointer is actually on — never light up submenu
				// rows while the pointer is over the sidebar.
				if (overPane) list.routeSubmenuMouse(event, bodyLine, paneCol);
			} else {
				list?.setHoverItem(overPane ? (list.hoverTest(bodyLine, paneCol) ?? null) : null);
			}
			return true;
		}
		if (!event.leftClick) return true;

		// A sidebar click switches category even while a sub-pane is open (the
		// rebuilt tab list discards the submenu, same as Esc + Tab).
		if (overSidebar) {
			const tab = this.#tabBar.tabAt(bodyLine, innerCol);
			if (tab) {
				this.#tabBar.selectTab(tab.id);
				// A click activates the category and works the pane directly.
				this.#sidebarFocused = false;
			}
			return true;
		}
		if (list?.hasOpenSubmenu()) {
			list.routeSubmenuMouse(event, bodyLine, paneCol);
			return true;
		}
		if (overPane && list) {
			const id = list.hitTest(bodyLine, paneCol);
			if (id !== undefined) {
				const wasSelected = list.getSelectedItem()?.id === id;
				const onValueColumn = list.isValueColumnHit(bodyLine, paneCol);
				list.selectItem(id);
				// A click on the always-aligned value column activates
				// immediately (toggle / open submenu) — mirrors Grok's
				// per-row value+chevron hit-rect. Re-clicking an
				// already-selected label does the same (legacy dual-click).
				if (wasSelected || onValueColumn) list.handleInput("\n");
			}
		}
		return true;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Global search (type-to-search across every tab)
	// ═══════════════════════════════════════════════════════════════════════

	/** Swap the tab content for the global search result list. */
	#startSearch(initialQuery: string): void {
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
			() => this.callbacks.onCancel(),
			{
				layout: "flat",
				typeToSearch: false,
				emptyText: "No matching settings",
				hint: "",
			},
		);
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
		empty.push({ id: "plugins", label: `${theme.icon.package} Plugins`, short: theme.icon.package, muted: true });
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
		return { ...item, group: def.group, keywords: def.keywords };
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

			case "defaultModel":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: this.#formatModelSelectorValue(currentValue),
					submenu: (_cv, done) => this.#createDefaultModelInput(done),
					changed,
				};
		}
	}

	/**
	 * Get the current value for a setting.
	 */
	#getCurrentValue(def: SettingDef): unknown {
		// The default-model entry is synthetic (no schema key): its value lives in
		// the `default` model-role slot, so read it from there, not settings.get.
		if (def.type === "defaultModel") return settings.getModelRole(DEFAULT_MODEL_SLOT);
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
	 * Create a submenu for a submenu-type setting.
	 */
	#createSubmenu(
		def: SettingDef & { type: "submenu" },
		currentValue: string,
		done: (value?: string) => void,
	): Container {
		let options = def.options;

		// Special case: inject runtime options for thinking level
		if (def.path === "defaultThinkingLevel") {
			// Prepend `auto`; the rest are the model's runtime-supported efforts.
			const levels: ConfiguredThinkingLevel[] = [AUTO_THINKING, ...this.context.availableThinkingLevels];
			options = levels.map(level => {
				const baseOpt = options.find(o => o.value === level);
				return baseOpt || { value: level, label: level };
			});
		} else if (def.path === "theme.dark" || def.path === "theme.light") {
			options = this.context.availableThemes.map(t => ({ value: t, label: t }));
		} else if (def.path === "personality") {
			options = [
				...this.context.availablePersonalities.map(name => ({
					value: name,
					label: name.charAt(0).toUpperCase() + name.slice(1),
					description: BUILTIN_PERSONALITY_DESCRIPTIONS[name],
				})),
				{ value: NONE_PERSONALITY, label: "None", description: "Omit the personality block entirely" },
			];
		}

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
					separator: presetDef.separator,
				});
			};
			onPreviewCancel = () => {
				const currentPreset = settings.get("statusLine.preset");
				const presetDef = getPreset(currentPreset);
				this.callbacks.onStatusLinePreview?.({
					preset: currentPreset,
					leftSegments: presetDef.leftSegments,
					rightSegments: presetDef.rightSegments,
					separator: presetDef.separator,
				});
			};
		} else if (def.path === "statusLine.separator") {
			onPreview = value => {
				this.callbacks.onStatusLinePreview?.({ separator: value as StatusLineSeparatorStyle });
			};
			onPreviewCancel = () => {
				const separator = settings.get("statusLine.separator");
				this.callbacks.onStatusLinePreview?.({ separator });
			};
		}

		// Provide status line preview for theme selection
		const isThemeSetting = def.path === "theme.dark" || def.path === "theme.light";
		const getPreview = isThemeSetting ? this.callbacks.getStatusLinePreview : undefined;

		return new SelectSubmenu(
			def.label,
			def.description,
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
		if (typeof value === "string" && value.trim()) return formatSelectorSummary(value);
		// Unset resolves live against the active main model at use time.
		return "inherit";
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
		const rawCurrent = typeof current === "string" ? current.trim() : undefined;
		const currentSelector = barePickerSelector(rawCurrent, ctx.models as Model<Api>[]);
		const label =
			path === "subagent.model" ? "Subagent Model" : path === "compaction.model" ? "Compaction Model" : String(path);
		return new ModelEffortSubmenu(
			path,
			ctx.registry,
			ctx.models,
			label,
			currentSelector || undefined,
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
		const rows = withLegacyDefaultEffort(settings.get("defaultEffort"), settings.get("defaultThinkingLevel"));
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
		const pinned = rows.filter(row => row?.model?.trim()).length;
		const parts = [`${rows.length} configured`];
		if (blocked > 0) parts.push(`${blocked} blocked`);
		if (pinned > 0) parts.push(`${pinned} pinned`);
		return parts.join(", ");
	}

	#createSubagentAgentsInput(done: (value?: string) => void): Container {
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
		const active = this.context.model ? `${this.context.model.provider}/${this.context.model.id}` : undefined;
		return new SubagentAgentsSubmenu(
			this.context.cwd,
			ctx.models,
			ctx.registry,
			active,
			() => {
				this.callbacks.onChange("subagent.agents", settings.get("subagent.agents"));
			},
			() => done(this.#formatSubagentAgentsValue()),
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
			this.context.requestRender,
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
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
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
		} else if (typeof currentValue === "number") {
			settings.set(path, Number(value) as never);
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
			() => this.callbacks.onCancel(),
			// The selector owns type-to-search and the footer hint; pin the
			// split sidebar width so the divider never jumps between tabs.
			{ typeToSearch: false, hint: "", layout: "flat", descriptionMode: "expand", expandedIds: this.#expandedIds },
		);
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
		const advancedItems: SettingItem[] = [];
		let lastGroup: string | undefined;
		let advancedTotal = 0;
		for (const def of defs) {
			const item = this.#defToItem(def);
			if (!item) continue;
			if (def.advanced) {
				advancedTotal++;
				advancedItems.push(item);
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
			for (const item of advancedItems) {
				if (expanded || item.changed) items.push(item);
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
			separator: settings.get("statusLine.separator"),
			sessionAccent: settings.get("statusLine.sessionAccent"),
			transparent: settings.get("statusLine.transparent"),
		};
		this.callbacks.onStatusLinePreview?.(statusLineSettings);
	}

	#showPluginsTab(): void {
		this.#pluginComponent = new PluginSettingsComponent(this.context.cwd, {
			onClose: () => this.callbacks.onCancel(),
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
