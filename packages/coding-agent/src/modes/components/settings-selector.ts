import { AUTO_COMPACTION_THRESHOLD } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import {
	type Component,
	Container,
	extractPrintableText,
	getKeybindings,
	Input,
	matchesKey,
	padding,
	rankSettingItems,
	routeSgrMouseInput,
	type SelectItem,
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
import { isRecord, VERSION } from "@veyyon/utils";
import { ANY_MODEL_EFFORT_KEY, withLegacyDefaultEffort } from "../../config/effort-resolver";
import type { ModelRegistry } from "../../config/model-registry";
import { normalizeModelPatternList } from "../../config/model-resolver";
import { DEFAULT_MODEL_SLOT, SELECTABLE_MODEL_ROLE_IDS } from "../../config/model-roles";
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
import type { SettingTab, StatusLinePreset } from "../../config/settings-schema";
import { isUnsetNumberPath, SETTING_TABS, TAB_METADATA } from "../../config/settings-schema";
import { withIcon } from "../../modes/theme/icon-label";
import { getCurrentThemeName, getSettingsListTheme, theme } from "../../modes/theme/theme";
import { BUILTIN_PERSONALITY_DESCRIPTIONS, NONE_PERSONALITY } from "../../personality/resolver";
import { SUBAGENT_MODEL_BY_DEPTH_PATH, subagentModelByDepthRows } from "../../task/subagent-settings";
import { getTabBarTheme } from "../shared";
import { formatSelectorSummary } from "./effort-picker";
import {
	BREADCRUMB_HOVER_ID,
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_SETTINGS,
	type ModalShellGeometry,
	type ModalShortcut,
	planModalChrome,
	pointerMotionEnabled,
	renderModalShell,
	SETTINGS_BROWSE_SHORTCUTS,
	SETTINGS_FILTER_SHORTCUTS,
	SETTINGS_SUBPANE_SHORTCUTS,
	sizingForArea,
} from "./modal-shell";
import { PluginSettingsComponent } from "./plugin-settings";
import { RollbackPanelComponent } from "./rollback-panel";
import { routeSettingsListPointer } from "./select-list-mouse-routing";
import {
	DEFAULT_MODEL_SETTING_ID,
	formatLspSummary,
	getSettingDef,
	getSettingsForTab,
	isNestedLspKnob,
	LSP_SETTING_PATHS,
	type OptionList,
	type SettingDef,
	settingsSearchLandingPath,
} from "./settings-defs";
import {
	advancedToggleId,
	getSettingsTabs,
	isAdvancedToggleId,
	MIN_SETTINGS_CONTENT_WIDTH,
	parseNumberSetting,
	ROLLBACK_ROW_ID,
	SETTING_SOURCE_LABELS,
	SETTINGS_READ_ONLY_SHORTCUTS,
	SETTINGS_SIDEBAR_SHORTCUTS,
	SETTINGS_TIPS,
	type SettingsCallbacks,
	type SettingsRuntimeContext,
	SIDEBAR_GAP_COLS,
	type StatusLinePreviewSettings,
	UNSET_NUMBER_INPUT,
} from "./settings-selector-helpers";
import { SelectSubmenu, TextInputSubmenu } from "./settings-submenus";
import {
	CompactionThresholdSubmenu,
	DefaultEffortSubmenu,
	DefaultModelSubmenu,
	EFFORT_SUBMENU_PATHS,
	formatThresholdShort,
	LspSubmenu,
	ModelChainSubmenu,
	ModelRolesSubmenu,
	ProviderLimitsSubmenu,
	RulesSubmenu,
	SubagentAgentsSubmenu,
	SubagentModelByDepthSubmenu,
	type SubagentRosterPath,
	subagentEffortOptions,
	subagentEffortScope,
} from "./settings-submenus/index";
import { getPreset } from "./status-line/presets";

export {
	barePickerSelector,
	ModelChainSubmenu,
	parseNumberSetting,
	ROLLBACK_ROW_ID,
	replaceModelChainEntry,
	type SettingsCallbacks,
	type SettingsRuntimeContext,
	type StatusLinePreviewSettings,
	UNSET_NUMBER_INPUT,
} from "./settings-selector-helpers";

export class SettingsSelectorComponent implements Component {
	#tabBar: TabBar;
	#currentList: SettingsList | null = null;
	#searchList: SettingsList | null = null;
	#pluginComponent: PluginSettingsComponent | null = null;
	#currentTabId: SettingTab | "plugins" = "appearance";
	#preSearchTabId: SettingTab | "plugins" = "appearance";
	#searchQuery = "";
	#searchInput = new Input();
	#searchMatchCount = 0;
	#searchFirstMatch = new Map<string, string>();
	#textInputActive = false;
	#showAdvanced = new Map<SettingTab, boolean>();
	#selectedSettingByTab = new Map<SettingTab, string>();
	#lspPanelFocusPath: SettingPath | undefined;
	#tabRowStart = 0;
	#tabRowCount = 0;
	#contentRowStart = 0;
	#contentRowCount = 0;
	#frameLeft = 0;
	#sidebarCols = 0;
	#sidebarWidthCache: number | undefined;
	#shellGeometry: ModalShellGeometry | null = null;
	#viewportTooSmall = false;
	#hoveredShortcutId: string | null = null;
	#expandedIds = new Set<string>();
	#sidebarFocused = false;

	constructor(
		private readonly context: SettingsRuntimeContext,
		private readonly callbacks: SettingsCallbacks,
		initialItemId?: string,
	) {
		this.#tabBar = new TabBar("", getSettingsTabs(), getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.setHoverMotion({
			requestRender: () => this.context.requestRender?.(),
			enabled: pointerMotionEnabled(),
		});
		this.#tabBar.onTabChange = () => {
			const tabId = this.#tabBar.getActiveTab().id as SettingTab | "plugins";
			if (this.#searchList) {
				const firstId = this.#searchFirstMatch.get(tabId);
				if (firstId) this.#searchList.selectItem(firstId);
				return;
			}
			this.#switchToTab(tabId);
		};

		this.#switchToTab("appearance");
		if (initialItemId) this.#currentList?.selectItem(initialItemId);
	}

	dispose(): void {
		this.#tabBar.disposeHoverMotion();
		this.#currentList?.disposeHoverMotion();
		this.#searchList?.disposeHoverMotion();
	}

	getSelectedSettingId(): string | undefined {
		return (this.#searchList ?? this.#currentList)?.getSelectedItem()?.id;
	}

	selectSetting(path: string): boolean {
		return (this.#searchList ?? this.#currentList)?.selectItem(path) ?? false;
	}

	openTab(tabId: SettingTab | "plugins"): void {
		this.#tabBar.setActiveById(tabId);
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

	#setContent(build: () => void): void {
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
		if (this.#pluginComponent) return this.#pluginComponent.shortcuts();
		if (this.#currentList?.getSelectedItem()?.readOnly) return SETTINGS_READ_ONLY_SHORTCUTS;
		return SETTINGS_BROWSE_SHORTCUTS;
	}

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
		const lines = new Array(termHeight).fill(padding(width));
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

	render(width: number): readonly string[] {
		const termHeight = Math.max(1, process.stdout.rows || 40);
		const sizing = sizingForArea(MODAL_SIZING_SETTINGS, termHeight);
		const dims = computeModalDims(width, termHeight, sizing);
		if (!dims || dims.contentWidth < MIN_SETTINGS_CONTENT_WIDTH) return this.#renderTooSmall(width, termHeight);
		this.#viewportTooSmall = false;

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

		const sidebarWidth = this.#sidebarWidth(contentWidth);
		const paneWidth = Math.max(1, contentWidth - sidebarWidth - SIDEBAR_GAP_COLS);
		const sidebarCursor = this.#sidebarFocused ? `${theme.fg("accent", theme.nav.cursor)} ` : `${theme.nav.cursor} `;
		const sidebarLines = this.#tabBar.renderVertical(sidebarWidth, sidebarCursor);
		const searching = this.#searchList !== null;
		const showPreview = !searching && this.#currentTabId === "appearance" && paneWidth >= 40;
		const requestedPreviewLines: string[] = [];
		if (showPreview) {
			requestedPreviewLines.push("", theme.fg("muted", "Preview:"));
			const previewLines = this.#getStatusPreviewString().split("\n");
			for (let li = 0; li < previewLines.length; li++) {
				requestedPreviewLines.push(truncateToWidth(previewLines[li]!, paneWidth));
			}
		}

		const estimatedBody = maxBodyRows;
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

		const paneLines: string[] = listLines.concat(previewLines);
		const bar = theme.fg("borderAccent", theme.boxSharp.vertical);
		const bodyRows = Math.max(sidebarLines.length, paneLines.length);
		const body: string[] = [];
		for (let r = 0; r < bodyRows; r++) {
			const side = sidebarLines[r] ?? padding(sidebarWidth);
			body.push(`${side}${bar}  ${paneLines[r] ?? ""}`);
		}

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
		this.#tabRowStart = shell.geometry?.bodyRowStart ?? 0;
		this.#tabRowCount = Math.min(sidebarLines.length, shell.geometry?.bodyRowCount ?? 0);
		this.#contentRowStart = this.#tabRowStart;
		this.#contentRowCount = shell.geometry?.bodyRowCount ?? 0;
		this.#sidebarCols = sidebarWidth;
		return shell.lines;
	}

	#handleMouse(data: string): boolean {
		return routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
	}

	#cancelOpenSubmenu(): void {
		const list = this.#searchList ?? this.#currentList;
		if (list?.hasOpenSubmenu()) list.handleInput("\x1b");
	}

	#close(): void {
		this.#cancelOpenSubmenu();
		this.callbacks.onCancel();
	}

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
		const contentColInset = 2 + this.#frameLeft;
		const innerCol = event.col - contentColInset;
		const bodyLine = event.row - this.#contentRowStart;
		const overBody = bodyLine >= 0 && bodyLine < this.#contentRowCount;
		const overSidebar = overBody && innerCol >= 0 && innerCol < this.#sidebarCols && bodyLine < this.#tabRowCount;
		const paneCol = innerCol - (this.#sidebarCols + SIDEBAR_GAP_COLS);
		const overPane = overBody && paneCol >= 0;

		if (event.wheel !== null) {
			if (overPane) {
				this.#sidebarFocused = false;
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
				if (overPane) routeSettingsListPointer(list, event, bodyLine, paneCol);
			} else {
				list.setHoverItem(overPane ? (list.hoverTest(bodyLine, paneCol) ?? null) : null);
			}
			return true;
		}
		if (!event.leftClick) return true;

		if (overSidebar) {
			this.#cancelOpenSubmenu();
			const tab = this.#tabBar.tabAt(bodyLine, innerCol);
			if (tab) {
				this.#tabBar.selectTab(tab.id);
				this.#sidebarFocused = false;
			}
			return true;
		}
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

	#startSearch(initialQuery: string): void {
		this.#rememberCurrentSelection();
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
			enabled: pointerMotionEnabled(),
		});
		list.onSelectionChange = item => this.#syncTabBarToSelection(item);
		this.#setContent(() => {
			this.#searchList = list;
		});
		this.#setSearchQuery(initialQuery);
	}

	#setSearchQuery(query: string): void {
		if (!this.#searchList) return;
		// A query of nothing but spaces renders as an empty box and matches nothing, so the
		// screen says "cleared" and "0 matches" at once and only `esc` gets out. Emptiness is
		// what the box LOOKS like, not its length.
		if (query.trim().length === 0) {
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
			for (let mi = 0; mi < result.matched.length; mi++) items.push(result.matched[mi]!);
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

	#endSearch(jumpToSelection: boolean): void {
		if (!this.#searchList) return;
		const selected = jumpToSelection ? this.#searchList.getSelectedItem() : undefined;
		const selectedDef = selected ? getSettingDef(selected.id as SettingPath) : undefined;
		const targetTab: SettingTab | "plugins" = selectedDef?.tab ?? this.#preSearchTabId;

		if (selectedDef?.advanced && targetTab !== "plugins") {
			this.#showAdvanced.set(targetTab, true);
		}

		this.#searchQuery = "";
		this.#searchFirstMatch.clear();
		this.#searchMatchCount = 0;
		this.#tabBar.setTabs(getSettingsTabs(), targetTab);
		this.#switchToTab(targetTab);
		if (selectedDef) {
			const landOn = settingsSearchLandingPath(selectedDef.path);
			this.#currentList?.selectItem(landOn);
			this.#selectedSettingByTab.set(selectedDef.tab, landOn);
			if (isNestedLspKnob(selectedDef.path)) {
				this.#lspPanelFocusPath = selectedDef.path;
				this.#currentList?.activateSelected();
			}
		}
	}

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
		empty.push({
			id: "plugins",
			label: withIcon(theme.icon.package, "Plugins"),
			short: theme.icon.package,
			muted: true,
		});
		return matched.concat(empty);
	}

	#syncTabBarToSelection(item: SettingItem | undefined): void {
		if (!this.#searchList || !item) return;
		const def = getSettingDef(item.id as SettingPath);
		if (def) this.#tabBar.setActiveById(def.tab);
	}

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
		if (def.tab === "appearance") {
			this.#triggerStatusLinePreview();
		}
		this.#setSearchQuery(this.#searchQuery);
	}

	#defToItem(def: SettingDef): SettingItem | null {
		const item = this.#defToItemBase(def);
		if (!item) return null;
		const searchable = { ...item, group: def.group, keywords: def.keywords };
		if (def.type === "defaultModel") return searchable;

		const source = settings.getSource(def.path);
		if (source !== "config-file" && source !== "runtime") return searchable;
		const sourceLabel = SETTING_SOURCE_LABELS[source];
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
					submenu: (cv, done) => this.#createEnumSubmenu(def, cv, done),
					changed,
				};

			case "submenu":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: this.#getSubmenuCurrentValue(def.path, currentValue),
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

			case "lsp":
				return {
					id: def.path,
					label: def.label,
					description: def.description,
					currentValue: formatLspSummary(),
					submenu: (_cv, done) => this.#createLspInput(done),
					changed: LSP_SETTING_PATHS.some(path => !Object.is(settings.get(path), getDefault(path))),
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

	#getCurrentValue(def: SettingDef): unknown {
		if (def.type === "defaultModel") return settings.getPersistedModelRole(DEFAULT_MODEL_SLOT);
		return settings.get(def.path);
	}

	#isChanged(def: SettingDef, currentValue: unknown): boolean {
		if (def.type === "defaultModel") return typeof currentValue === "string" && currentValue.trim().length > 0;
		return !Object.is(currentValue, getDefault(def.path));
	}

	#getSubmenuCurrentValue(path: SettingPath, value: unknown): string {
		const rawValue = String(value ?? "");
		if (isUnsetNumberPath(path) && (value === undefined || rawValue === String(UNSET_NUMBER) || rawValue === "")) {
			return UNSET_NUMBER_OPTION_VALUE;
		}
		return rawValue;
	}

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
		if (Object.hasOwn(EFFORT_SUBMENU_PATHS, def.path)) {
			return subagentEffortOptions(
				subagentEffortScope(this.context.availableModels, this.context.model),
				this.context.availableModels,
			).options;
		}
		return def.options;
	}

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
		const description = effort?.notice ? `${def.description} ${effort.notice}` : def.description;

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
			(value: string[] | undefined) => this.callbacks.onChange(path, value),
			this.context.requestRender,
		);
	}

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

	#createSubagentAgentsInput(done: (value?: string) => void): Container {
		const active = this.context.model ? `${this.context.model.provider}/${this.context.model.id}` : undefined;
		return new SubagentAgentsSubmenu(
			this.context.cwd,
			active,
			this.context.model,
			this.context.availableModels,
			this.#requireModelPickerContext(),
			(path: SubagentRosterPath) => {
				this.callbacks.onChange(path, settings.get(path));
			},
			() => done(this.#formatSubagentAgentsValue()),
			this.context.requestRender,
		);
	}

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

	#createLspInput(done: (value?: string) => void): Container {
		const focus = this.#lspPanelFocusPath;
		this.#lspPanelFocusPath = undefined;
		return new LspSubmenu(
			(path: SettingPath, value: boolean) => this.callbacks.onChange(path, value),
			() => done(formatLspSummary()),
			this.context.requestRender,
			focus,
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
		if (Array.isArray(value)) {
			return value.every(item => typeof item === "string") ? value.join(", ") : JSON.stringify(value);
		}
		if (typeof value === "object") return JSON.stringify(value);
		return String(value);
	}

	#setSettingValue(path: SettingPath, value: string): void {
		const currentValue = settings.get(path);
		const schemaType = getType(path);
		if (isUnsetNumberPath(path) && value === UNSET_NUMBER_OPTION_VALUE) {
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
			const next = parseNumberSetting(path, value);
			if (next === UNSET_NUMBER_INPUT) settings.unset(path);
			else settings.set(path, next as never);
		} else if (typeof currentValue === "boolean") {
			settings.set(path, (value === "true") as never);
		} else {
			settings.set(path, value as never);
		}
	}

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
				this.#refreshCurrentTabItems(defs);
			},
			() => this.#close(),
			{ typeToSearch: false, hint: "", layout: "flat", descriptionMode: "expand", expandedIds: this.#expandedIds },
		);
		this.#currentList.setHoverMotion({
			requestRender: () => this.context.requestRender?.(),
			enabled: pointerMotionEnabled(),
		});
	}

	#isAdvancedExpanded(tab: SettingTab): boolean {
		return this.#showAdvanced.get(tab) === true;
	}

	#toggleAdvanced(tab: SettingTab): void {
		this.#showAdvanced.set(tab, !this.#isAdvancedExpanded(tab));
	}

	#buildItemsForDefs(defs: SettingDef[], tabId: SettingTab): SettingItem[] {
		const items: SettingItem[] = [];
		const advancedItems: Array<{ group: string | undefined; item: SettingItem }> = [];
		let lastGroup: string | undefined;
		let advancedTotal = 0;
		for (const def of defs) {
			if (isNestedLspKnob(def.path)) continue;
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

	#refreshCurrentTabItems(defs: SettingDef[]): void {
		const tabId = this.#currentTabId;
		if (tabId === "plugins" || !this.#currentList) return;
		this.#currentList.setItems(this.#buildItemsForDefs(defs, tabId));
	}

	#getStatusPreviewString(): string {
		if (this.callbacks.getStatusLinePreview) {
			return this.callbacks.getStatusLinePreview();
		}
		return theme.fg("dim", "(preview not available)");
	}

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

	#stepCategory(delta: -1 | 1): void {
		const tabs = getSettingsTabs();
		const index = tabs.findIndex(tab => tab.id === this.#tabBar.getActiveTab().id);
		if (index === -1) return;
		const next = Math.min(tabs.length - 1, Math.max(0, index + delta));
		const target = tabs[next];
		if (next !== index && target) this.#tabBar.selectTab(target.id);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			this.#handleMouse(data);
			return;
		}

		if (this.#viewportTooSmall) {
			if (matchesKey(data, "escape") || data === "\x1b") this.#close();
			return;
		}

		if (this.#textInputActive) {
			(this.#searchList ?? this.#currentList)?.handleInput(data);
			return;
		}

		const activeList = this.#searchList ?? this.#currentList;

		if (activeList?.hasOpenSubmenu()) {
			activeList.handleInput(data);
			return;
		}

		if (this.#searchList) {
			this.#handleSearchModeInput(data, this.#searchList);
			return;
		}

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
			if (matchesKey(data, "left") || data === "h") return;
		}

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
			this.#sidebarFocused = true;
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			if (this.#currentList?.hasSectionFocusTargets()) {
				this.#currentList.toggleSectionFocus();
				return;
			}
			this.#tabBar.handleInput(data);
			return;
		}

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
			this.#endSearch(true);
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#tabBar.handleInput(data);
			return;
		}
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
		this.#searchInput.handleInput(data);
		const value = this.#searchInput.getValue();
		if (value !== this.#searchQuery) this.#setSearchQuery(value);
	}
}
