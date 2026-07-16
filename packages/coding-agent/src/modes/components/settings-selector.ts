import type { ThinkingLevel } from "@veyyon/pi-agent-core";
import type { Effort, Model } from "@veyyon/pi-ai";
import {
	type Component,
	Container,
	extractPrintableText,
	fuzzyRank,
	getKeybindings,
	getSettingItemFilterText,
	type ImageBudget,
	Input,
	matchesKey,
	padding,
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
} from "@veyyon/pi-tui";
import type { ShapeTarget } from "@veyyon/snapcompact";
import type { ModelRegistry } from "../../config/model-registry";
import { getRoleInfo, ROLE_INHERIT_LABEL, SELECTABLE_MODEL_ROLE_IDS } from "../../config/model-roles";
import {
	getDefault,
	getType,
	normalizeProviderMaxInFlightRequests,
	type SettingPath,
	settings,
	validateProviderMaxInFlightRequests,
} from "../../config/settings";
import type {
	SettingTab,
	StatusLinePreset,
	StatusLineSegmentId,
	StatusLineSeparatorStyle,
} from "../../config/settings-schema";
import { SETTING_TABS, TAB_METADATA } from "../../config/settings-schema";
import { getCurrentThemeName, getSelectListTheme, getSettingsListTheme, theme } from "../../modes/theme/theme";
import { BUILTIN_PERSONALITY_DESCRIPTIONS, NONE_PERSONALITY } from "../../personality/resolver";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../../thinking";
import { getTabBarTheme } from "../shared";
import {
	BREADCRUMB_HOVER_ID,
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_SETTINGS,
	type ModalShellGeometry,
	renderModalShell,
	SETTINGS_BROWSE_SHORTCUTS,
	SETTINGS_FILTER_SHORTCUTS,
	SETTINGS_SUBPANE_SHORTCUTS,
	withCompact,
} from "./modal-shell";
import { ModelSelectorPanel } from "./model-selector";
import { handleInputOrEscape, PluginSettingsComponent } from "./plugin-settings";
import { getSettingDef, getSettingsForTab, type SettingDef } from "./settings-defs";
import { SnapcompactShapePreview } from "./snapcompact-shape-preview";
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
				const message = error instanceof Error ? error.message : String(error);
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

		// Footer (e.g. the snapcompact shape preview) below the interactive rows,
		// so the list never shifts while browsing.
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
		this.#selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme());
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
				description: assigned && assigned.length > 0 ? assigned : (info.unsetLabel ?? ROLE_INHERIT_LABEL),
			};
		});
		this.#selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme());
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
				description: `Role \`${role}\` — used when that work type runs. Del clears (${info.unsetLabel ?? "inherit main model"}).`,
				currentSelector: current,
				allowClear: true,
			},
			{
				onPick: (_model, selector) => {
					settings.setModelRole(role, selector);
					this.onChange();
					this.#showRoleList();
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

// Numeric compaction settings whose -1 sentinel renders as (and is set via)
// the "default" submenu option: -1 = derive the value from the model/provider.
const COMPACTION_DEFAULT_SENTINEL_PATHS: ReadonlySet<string> = new Set([
	"compaction.thresholdPercent",
	"compaction.thresholdTokens",
	"compaction.modelContextWindow",
]);

function advancedToggleId(tab: SettingTab): string {
	return `${ADVANCED_TOGGLE_ID_PREFIX}${tab}`;
}

function isAdvancedToggleId(id: string): boolean {
	return id.startsWith(ADVANCED_TOGGLE_ID_PREFIX);
}

let cachedSidebarWidth: number | undefined;
/**
 * Split-sidebar width derived from every group name in the schema (not just
 * the visible tab), so the divider column never moves when switching tabs or
 * when condition-gated groups appear.
 */
function settingsSidebarWidth(): number {
	if (cachedSidebarWidth === undefined) {
		let nameWidth = 0;
		for (const tab of SETTING_TABS) {
			for (const def of getSettingsForTab(tab)) {
				if (def.group) nameWidth = Math.max(nameWidth, visibleWidth(def.group));
			}
		}
		cachedSidebarWidth = Math.min(22, nameWidth) + 4;
	}
	return cachedSidebarWidth;
}

/** Columns between the sidebar and the settings pane: `│` hairline + two spaces. */
const SIDEBAR_GAP_COLS = 3;

function getSettingsTabs(): Tab[] {
	return [
		...SETTING_TABS.map(id => {
			const meta = TAB_METADATA[id];
			const icon = theme.symbol(meta.icon as Parameters<typeof theme.symbol>[0]);
			return { id, label: `${icon} ${meta.label}`, short: icon };
		}),
		{ id: "plugins", label: `${theme.icon.package} Plugins`, short: theme.icon.package },
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
	/** Active model (api + id); resolves what the snapcompact `auto` shape maps to. */
	model?: ShapeTarget;
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
	#hasSectionJump = false;
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

	/** @deprecated Prefer ModalShell sizing; kept for tests that assert width. */
	static readonly MODAL_MAX_WIDTH = MODAL_SIZING_SETTINGS.maxWidth;

	constructor(
		private readonly context: SettingsRuntimeContext,
		private readonly callbacks: SettingsCallbacks,
		/** Setting path to pre-select on the default (appearance) tab, e.g. `/statusline` jumping to `statusLine.preset`. */
		initialItemId?: string,
	) {
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
		const sidebarLines = this.#tabBar.renderVertical(sidebarWidth, `${theme.nav.cursor} `);
		const searching = this.#searchList !== null;
		const showPreview = !searching && this.#currentTabId === "appearance";
		const previewLines = showPreview ? ["", theme.fg("muted", "Preview:"), this.#getStatusPreviewString()] : [];

		// Non-body chrome (borders, search row, footer band) costs ~10 rows —
		// mirrors renderModalShell's own nonBody() budget below. The sidebar
		// runs parallel to the pane, so it costs no vertical budget.
		const estimatedBody = Math.max(10, dims.modalHeight - 10);
		const list = this.#searchList ?? this.#currentList;
		let listLines: readonly string[] = [];
		if (list) {
			list.setMaxVisible(Math.max(8, estimatedBody - (showPreview ? 3 : 0)));
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
			tipCandidates: [
				'Tip · Ask the agent: "change theme to titanium" or "what does compact do?"',
				"Tip · Ask the agent to change a setting",
			],
			shortcuts: this.#settingsShortcuts(),
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
		return shell.lines;
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
			if (tab) this.#tabBar.selectTab(tab.id);
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
			const ranked = fuzzyRank(candidates, query, getSettingItemFilterText);
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
	#defToItem(def: SettingDef): SettingItem | null {
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
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: String(currentValue ?? ""),
					values: [...def.values],
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

			case "modelRoles":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: this.#formatModelRolesValue(),
					submenu: (_cv, done) => this.#createModelRolesInput(done),
					changed,
				};
		}
	}

	/**
	 * Get the current value for a setting.
	 */
	#getCurrentValue(def: SettingDef): unknown {
		return settings.get(def.path);
	}

	#isChanged(def: SettingDef, currentValue: unknown): boolean {
		return !Object.is(currentValue, getDefault(def.path));
	}

	#getSubmenuCurrentValue(path: SettingPath, value: unknown): string {
		const rawValue = String(value ?? "");
		if (COMPACTION_DEFAULT_SENTINEL_PATHS.has(path) && (rawValue === "-1" || rawValue === "")) {
			return "default";
		}
		return rawValue;
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
		let footer: Component | undefined;

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
		} else if (def.path === "snapcompact.shape") {
			const shapePreview = new SnapcompactShapePreview(currentValue, {
				model: this.context.model,
				imageBudget: this.context.imageBudget,
				requestRender: this.context.requestRender,
			});
			onPreview = value => shapePreview.setValue(value);
			footer = shapePreview;
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
		if (typeof value === "string" && value.trim()) return value.trim();
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
		const currentSelector = typeof current === "string" ? current.trim() : undefined;
		const label =
			path === "subagent.model" ? "Subagent Model" : path === "compaction.model" ? "Compaction Model" : String(path);
		return new ModelSelectorPanel(
			settings,
			ctx.registry,
			ctx.models,
			{
				title: label,
				description: "Searchable catalog · auth / local / no auth shown on each row.",
				currentSelector: currentSelector || undefined,
				allowClear: true,
			},
			{
				onPick: (_model, selector) => {
					settings.set(path, selector as never);
					this.callbacks.onChange(path, selector);
					done(selector);
				},
				onClear: () => {
					settings.set(path, undefined as never);
					this.callbacks.onChange(path, undefined);
					done("inherit");
				},
				onCancel: () => done(),
			},
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
		if (typeof value === "object") return JSON.stringify(value);
		return String(value);
	}

	/**
	 * Set a setting value, handling type conversion.
	 */
	#setSettingValue(path: SettingPath, value: string): void {
		const currentValue = settings.get(path);
		const schemaType = getType(path);
		if (COMPACTION_DEFAULT_SENTINEL_PATHS.has(path) && value === "default") {
			settings.set(path, -1 as never);
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
		// Mirror SettingsList's section detection (leading ungrouped items form
		// an implicit section) so the footer hint only advertises PgUp/PgDn
		// when the jump actually changes sections.
		const sectionCount = items.filter(item => item.heading).length + (items.length > 0 && !items[0].heading ? 1 : 0);
		this.#hasSectionJump = sectionCount >= 2;

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
		}

		if (advancedTotal > 0) {
			const expanded = this.#isAdvancedExpanded(tabId);
			const arrow = expanded ? "▾" : "▸";
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
			// No expanded desc: Left still switches tabs (legacy).
			this.#tabBar.handleInput(data);
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
