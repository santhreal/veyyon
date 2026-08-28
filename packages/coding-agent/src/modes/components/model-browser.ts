import { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { getModelPricing, modelsAreEqual } from "@veyyon/catalog/models";
import {
	type Component,
	Ellipsis,
	fuzzyRank,
	HoverFade,
	type HoverFadeOptions,
	Input,
	matchesKey,
	padding,
	ScrollView,
	type SgrMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import { clampLow, formatNumber } from "@veyyon/utils";
import { resolveEffort, withLegacyDefaultEffort } from "../../config/effort-resolver";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import { DEFAULT_MODEL_SLOT, getKnownRoleIds, getRoleInfo, MODEL_ROLE_IDS } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import type { ModelPerfStats } from "../../session/agent-storage";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../../thinking";
import { type ThemeColor, theme } from "../theme/theme";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { hoverBandAt, SCROLL_LIST_THEME } from "./selector-helpers";

export interface ModelBrowserItem {
	provider: string;
	id: string;
	model: Model;
	selector: string;
	labelColor?: ThemeColor;
	badge?: string;
	badgeColor?: ThemeColor;
	virtualLabel?: string;
	virtualDetail?: string;
}

export interface RoleAssignment {
	model: Model;
	thinkingLevel: ConfiguredThinkingLevel;
}

export type RoleAssignments = Record<string, RoleAssignment | undefined>;

export function resolveRoleAssignments(settings: Settings, allModels: ReadonlyArray<Model>): RoleAssignments {
	const resolvedThinkingLevel = (
		role: string,
		model: Model,
		resolved: { explicitThinkingLevel: boolean; thinkingLevel?: ConfiguredThinkingLevel },
	): ConfiguredThinkingLevel => {
		if (resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined) {
			return resolved.thinkingLevel;
		}
		if (role === "default") {
			return (
				resolveEffort({
					modelSelector: `${model.provider}/${model.id}`,
					defaultEffort: withLegacyDefaultEffort(
						settings.isConfigured("defaultEffort") ? settings.get("defaultEffort") : undefined,
						settings.get("defaultThinkingLevel"),
					),
				}).level ?? ThinkingLevel.Inherit
			);
		}
		return ThinkingLevel.Inherit;
	};

	const roles: RoleAssignments = {};
	const matchPreferences = getModelMatchPreferences(settings);
	const catalog = allModels.slice();

	for (const role of [DEFAULT_MODEL_SLOT, ...getKnownRoleIds(settings)]) {
		const roleValue = settings.getModelRole(role);
		if (!roleValue) continue;
		const resolved = resolveModelRoleValue(roleValue, catalog, { settings, matchPreferences });
		if (resolved.model) {
			roles[role] = {
				model: resolved.model,
				thinkingLevel: resolvedThinkingLevel(role, resolved.model, resolved),
			};
		}
	}

	return roles;
}

export function buildBrowserItems(models: ReadonlyArray<Model>): ModelBrowserItem[] {
	const result = new Array<ModelBrowserItem>(models.length);
	for (let mi = 0; mi < models.length; mi++) {
		const model = models[mi]!;
		result[mi] = {
			provider: model.provider,
			id: model.id,
			model,
			selector: `${model.provider}/${model.id}`,
		};
	}
	return result;
}

export const INHERIT_ROW_SELECTOR = "__inherit__";

function virtualRowModel(): Model {
	return buildModel({
		id: "virtual",
		name: "virtual",
		api: "ollama-chat",
		provider: "",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
	});
}

export function buildInheritRow(label: string, detail: string): ModelBrowserItem {
	return {
		provider: "",
		id: INHERIT_ROW_SELECTOR,
		selector: INHERIT_ROW_SELECTOR,
		virtualLabel: label,
		virtualDetail: detail,
		model: virtualRowModel(),
	};
}

function extractVersionNumber(id: string): number {
	const dotMatch = id.match(/(?:^|[-_])(\d+\.\d+)/);
	if (dotMatch) return Number.parseFloat(dotMatch[1]);
	const dashMatch = id.match(/(?:^|[-_])(\d{1,2})-(\d{1,2})(?=-|$)/);
	if (dashMatch) return Number.parseFloat(`${dashMatch[1]}.${dashMatch[2]}`);
	const singleMatch = id.match(/(?:^|[-_])(\d+)/);
	if (singleMatch) return Number.parseFloat(singleMatch[1]);
	return 0;
}

function computeModelRank(model: Model, roles: RoleAssignments): number {
	let i = 0;
	while (i < MODEL_ROLE_IDS.length) {
		const assigned = roles[MODEL_ROLE_IDS[i]];
		if (assigned && modelsAreEqual(assigned.model, model)) {
			break;
		}
		i++;
	}
	return i;
}

export interface SortModelItemsOptions {
	roles?: RoleAssignments;
	mruOrder?: ReadonlyArray<string>;
	skipRoleRank?: boolean;
}

export function sortModelItems(items: ModelBrowserItem[], options: SortModelItemsOptions = {}): void {
	const { roles = {}, mruOrder = [], skipRoleRank = false } = options;
	const mruIndex = new Map(mruOrder.map((key, i) => [key, i]));

	const dateRe = /-(\d{8})$/;
	const latestRe = /-latest$/;

	items.sort((a, b) => {
		if (!skipRoleRank) {
			const aRank = computeModelRank(a.model, roles);
			const bRank = computeModelRank(b.model, roles);
			if (aRank !== bRank) return aRank - bRank;
		}

		const aMru = mruIndex.get(a.selector) ?? Number.MAX_SAFE_INTEGER;
		const bMru = mruIndex.get(b.selector) ?? Number.MAX_SAFE_INTEGER;
		if (aMru !== bMru) return aMru - bMru;

		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;

		const aPri = a.model.priority ?? Number.MAX_SAFE_INTEGER;
		const bPri = b.model.priority ?? Number.MAX_SAFE_INTEGER;
		if (aPri !== bPri) return aPri - bPri;

		const aVer = extractVersionNumber(a.id);
		const bVer = extractVersionNumber(b.id);
		if (aVer !== bVer) return bVer - aVer;

		const aIsLatest = latestRe.test(a.id);
		const bIsLatest = latestRe.test(b.id);
		const aDate = a.id.match(dateRe)?.[1] ?? "";
		const bDate = b.id.match(dateRe)?.[1] ?? "";

		const aHasRecency = aIsLatest || aDate !== "";
		const bHasRecency = bIsLatest || bDate !== "";
		if (aHasRecency !== bHasRecency) return aHasRecency ? -1 : 1;

		if (!aHasRecency) return a.id.localeCompare(b.id);

		if (aIsLatest !== bIsLatest) return aIsLatest ? -1 : 1;

		if (aDate && bDate) return bDate.localeCompare(aDate);

		return aIsLatest ? -1 : bIsLatest ? 1 : a.id.localeCompare(b.id);
	});
}

export function thinkingLevelGlyph(level: ConfiguredThinkingLevel): string {
	const glyphOf = (symbol: string) => symbol.split(" ")[0] ?? symbol;
	switch (level) {
		case AUTO_THINKING:
			return glyphOf(theme.thinking.autoPending);
		case ThinkingLevel.Off:
			return theme.status.disabled;
		case ThinkingLevel.Minimal:
			return glyphOf(theme.thinking.minimal);
		case ThinkingLevel.Low:
			return glyphOf(theme.thinking.low);
		case ThinkingLevel.Medium:
			return glyphOf(theme.thinking.medium);
		case ThinkingLevel.High:
			return glyphOf(theme.thinking.high);
		case ThinkingLevel.XHigh:
			return glyphOf(theme.thinking.xhigh);
		case ThinkingLevel.Max:
			return glyphOf(theme.thinking.max);
		case ThinkingLevel.Inherit:
			return "";
	}
}

export function formatRoleChip(role: string, assignment: RoleAssignment, settings: Settings): string {
	const info = getRoleInfo(role, settings);
	const label = (info.tag ?? info.name ?? role).toLowerCase();
	const glyph = thinkingLevelGlyph(assignment.thinkingLevel);
	const suffix = glyph ? ` ${theme.fg("dim", glyph)}` : "";
	return theme.fg(info.color ?? "muted", `${theme.status.enabled}${label}`) + suffix;
}

function formatCostPair(model: Model): string {
	const pricing = getModelPricing(model);
	if (pricing === "free") return "free";
	if (pricing === "unpriced") return "—";
	const cost = model.cost;
	const fmt = (n: number): string => {
		if (n <= 0) return "0";
		const s = n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
		return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
	};
	return `$${fmt(cost.input)}/${fmt(cost.output)}`;
}

function formatContext(model: Model): string {
	const ctx = model.contextWindow ?? 0;
	if (ctx <= 0) return "";
	return `${formatNumber(ctx).toLowerCase()} ${theme.icon.context.replace(/:$/, "")}`;
}

function formatTps(tps: number): string {
	const value = tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1);
	return `${value}t/s`;
}

function formatTtft(ms: number): string {
	const seconds = ms / 1000;
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}

function padLeftVisible(text: string, width: number): string {
	const missing = width - visibleWidth(text);
	return missing > 0 ? padding(missing) + text : text;
}

export interface ModelBrowserOptions {
	showProvider?: boolean;
	currentContextTokens?: number;
	disableOverContext?: boolean;
	emptyText?: () => string | undefined;
}

const LIST_ROW_START = 2;
const DETAIL_ROWS = 3;
const PERF_TPS_MIN_WIDTH = 76;
const PERF_FULL_MIN_WIDTH = 96;
type PerfMode = "off" | "tps" | "full";

export class ModelBrowser implements Component {
	#settings: Settings;
	#searchInput = new Input();
	#baseItems: ModelBrowserItem[] = [];
	#visibleItems: ModelBrowserItem[] = [];
	#roles: RoleAssignments = {};
	#mruOrder: ReadonlyArray<string> = [];
	#perf: ReadonlyMap<string, ModelPerfStats> = new Map();
	#columnWidths: { perfMode: PerfMode; ctx: number; cost: number; perf: number } | undefined;
	#selectedIndex = 0;
	#hoveredIndex: number | null = null;
	#hoverFade: HoverFade | undefined;
	#maxVisible = 10;
	#showProvider: boolean;
	#currentContextTokens: number;
	#disableOverContext: boolean;
	#emptyText?: () => string | undefined;
	#preserveQueryOrder = false;
	#windowStart = 0;
	#windowCount = 0;
	#focused = true;
	#currentSelector: string | undefined;

	onActivate?: (item: ModelBrowserItem) => void;
	onSelectionChange?: (item: ModelBrowserItem | undefined) => void;
	onQueryChange?: (query: string) => void;
	onCancel?: () => void;

	constructor(settings: Settings, options: ModelBrowserOptions = {}) {
		this.#settings = settings;
		this.#showProvider = options.showProvider ?? true;
		const tokens = options.currentContextTokens ?? 0;
		this.#currentContextTokens = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
		this.#disableOverContext = options.disableOverContext ?? false;
		this.#emptyText = options.emptyText;
	}

	setCurrentSelector(selector: string | undefined): void {
		this.#currentSelector = selector;
	}

	setItems(items: ModelBrowserItem[]): void {
		const selectedKey = this.getSelected()?.selector;
		this.#baseItems = items;
		this.#applyQuery();
		if (selectedKey) {
			this.selectSelector(selectedKey);
		}
	}

	setRoles(roles: RoleAssignments): void {
		this.#roles = roles;
	}

	setMruOrder(order: ReadonlyArray<string>): void {
		this.#mruOrder = order;
	}

	setPerfStats(perf: ReadonlyMap<string, ModelPerfStats>): void {
		this.#perf = perf;
		this.#invalidateColumnWidths();
	}

	setMaxVisible(rows: number): void {
		this.#maxVisible = Math.max(1, rows);
	}

	setShowProvider(show: boolean): void {
		this.#showProvider = show;
	}
	setPreserveQueryOrder(preserve: boolean): void {
		this.#preserveQueryOrder = preserve;
	}
	setDisableOverContext(disable: boolean): void {
		this.#disableOverContext = disable;
	}
	setFocused(focused: boolean): void {
		this.#focused = focused;
	}

	get renderedRows(): number {
		return LIST_ROW_START + this.#maxVisible + DETAIL_ROWS;
	}

	get query(): string {
		return this.#searchInput.getValue();
	}

	setQuery(query: string): void {
		this.#searchInput.setValue(query);
		this.#applyQuery();
	}

	getSelected(): ModelBrowserItem | undefined {
		return this.#visibleItems[this.#selectedIndex];
	}

	get visibleCount(): number {
		return this.#visibleItems.length;
	}

	selectSelector(selector: string): boolean {
		const index = this.#visibleItems.findIndex(item => item.selector === selector);
		if (index < 0) return false;
		this.#selectedIndex = this.#coerceSelectedIndex(index);
		this.#ensureSelectedVisible();
		return true;
	}

	#isDisabled(item: ModelBrowserItem): boolean {
		if (item.id === "separator") return true;
		if (!this.#disableOverContext || this.#currentContextTokens <= 0) return false;
		const contextWindow = item.model.contextWindow ?? 0;
		return contextWindow > 0 && this.#currentContextTokens > contextWindow;
	}

	#coerceSelectedIndex(index: number): number {
		const maxIndex = this.#visibleItems.length - 1;
		if (maxIndex < 0) return 0;
		const clamped = clampLow(index, 0, maxIndex);
		const clampedItem = this.#visibleItems[clamped];
		if (clampedItem && !this.#isDisabled(clampedItem)) return clamped;
		for (let i = clamped + 1; i <= maxIndex; i++) {
			const item = this.#visibleItems[i];
			if (item && !this.#isDisabled(item)) return i;
		}
		for (let i = clamped - 1; i >= 0; i--) {
			const item = this.#visibleItems[i];
			if (item && !this.#isDisabled(item)) return i;
		}
		return clamped;
	}

	#clampWindowStart(start: number): number {
		return clampLow(start, 0, this.#visibleItems.length - this.#maxVisible);
	}

	#ensureSelectedVisible(): void {
		if (this.#selectedIndex < this.#windowStart) {
			this.#windowStart = this.#selectedIndex;
		} else if (this.#selectedIndex >= this.#windowStart + this.#maxVisible) {
			this.#windowStart = this.#selectedIndex - this.#maxVisible + 1;
		}
		this.#windowStart = this.#clampWindowStart(this.#windowStart);
	}

	moveSelection(delta: number, options: { wrap?: boolean } = {}): void {
		const count = this.#visibleItems.length;
		if (count === 0) return;
		if (options.wrap ?? true) {
			let index = this.#selectedIndex;
			for (let step = 0; step < count; step++) {
				index = (index + delta + count) % count;
				const item = this.#visibleItems[index];
				if (item && !this.#isDisabled(item)) {
					this.#setSelectedIndex(index);
					return;
				}
			}
			return;
		}
		const target = clampLow(this.#selectedIndex + delta, 0, count - 1);
		this.#setSelectedIndex(this.#coerceSelectedIndex(target));
	}

	#setSelectedIndex(index: number): void {
		if (index === this.#selectedIndex) return;
		this.#selectedIndex = index;
		this.#ensureSelectedVisible();
		this.onSelectionChange?.(this.getSelected());
	}

	#isRecentOrRole(item: ModelBrowserItem): boolean {
		if (this.#mruOrder.includes(item.selector)) return true;
		for (const role in this.#roles) {
			const r = this.#roles[role];
			if (r && modelsAreEqual(r.model, item.model)) return true;
		}
		return false;
	}
	#insertSeparator(items: ModelBrowserItem[]): ModelBrowserItem[] {
		const filtered = items.filter(item => item.id !== "separator");
		const firstNonRecentIndex = filtered.findIndex(
			item => item.virtualLabel === undefined && !this.#isRecentOrRole(item),
		);
		if (firstNonRecentIndex > 0 && firstNonRecentIndex < filtered.length) {
			const separatorItem: ModelBrowserItem = {
				id: "separator",
				provider: "",
				selector: "separator",
				model: virtualRowModel(),
			};
			return filtered.slice(0, firstNonRecentIndex).concat([separatorItem], filtered.slice(firstNonRecentIndex));
		}
		return filtered;
	}

	#applyQuery(): void {
		const query = this.#searchInput.getValue();
		let items: ModelBrowserItem[];
		if (query.trim()) {
			const ranked = fuzzyRank(this.#baseItems, query, item =>
				item.virtualLabel !== undefined ? item.virtualLabel : `${item.provider}/${item.id}`,
			);
			const matches = ranked.map(result => result.item);
			if (this.#preserveQueryOrder) {
				items = matches;
			} else {
				sortModelItems(matches, { roles: this.#roles, mruOrder: this.#mruOrder, skipRoleRank: true });
				const buckets = new Map<ModelBrowserItem, number>();
				for (const result of ranked) buckets.set(result.item, Math.round(result.score / 10));
				matches.sort((a, b) => (buckets.get(a) ?? 0) - (buckets.get(b) ?? 0));
				items = matches;
			}
		} else {
			items = this.#baseItems;
		}
		this.#visibleItems = this.#insertSeparator(items);
		this.#invalidateColumnWidths();
		this.#selectedIndex = this.#coerceSelectedIndex(Math.min(this.#selectedIndex, this.#visibleItems.length - 1));
		this.#ensureSelectedVisible();
		this.onSelectionChange?.(this.getSelected());
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data)) {
			this.handleCancel();
			return;
		}
		if (matchesSelectUp(data)) {
			this.moveSelection(-1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.moveSelection(1);
			return;
		}
		if (matchesSelectPageUp(data)) {
			this.moveSelection(-this.#maxVisible, { wrap: false });
			return;
		}
		if (matchesSelectPageDown(data)) {
			this.moveSelection(this.#maxVisible, { wrap: false });
			return;
		}
		if (matchesKey(data, "home")) {
			this.moveSelection(-this.#visibleItems.length, { wrap: false });
			return;
		}
		if (matchesKey(data, "end")) {
			this.moveSelection(this.#visibleItems.length, { wrap: false });
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const selected = this.getSelected();
			if (selected && !this.#isDisabled(selected)) {
				this.onActivate?.(selected);
			}
			return;
		}
		const before = this.#searchInput.getValue();
		this.#searchInput.handleInput(data);
		const after = this.#searchInput.getValue();
		if (after !== before) {
			this.#applyQuery();
			this.onQueryChange?.(after);
		}
	}

	handleCancel(): void {
		if (this.#searchInput.getValue().length > 0) {
			this.setQuery("");
			this.onQueryChange?.("");
			return;
		}
		this.onCancel?.();
	}

	routeMouse(event: SgrMouseEvent, line: number): void {
		if (event.wheel !== null) {
			this.#windowStart = this.#clampWindowStart(this.#windowStart + event.wheel);
			this.#setHoveredIndex(this.#hoverIndexAt(line));
			return;
		}
		if (event.motion) {
			this.#setHoveredIndex(this.#hoverIndexAt(line));
			return;
		}
		if (!event.leftClick) return;
		const index = this.#hoverIndexAt(line);
		const item = index !== null ? this.#visibleItems[index] : undefined;
		if (index === null || !item) return;
		if (index === this.#selectedIndex) {
			this.onActivate?.(item);
		} else {
			this.#setSelectedIndex(index);
		}
	}
	clearHover(): void {
		this.#setHoveredIndex(null);
	}

	#setHoveredIndex(index: number | null): void {
		this.#hoveredIndex = index;
		this.#hoverFade?.set(index);
	}

	setHoverMotion(options: HoverFadeOptions): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade(options);
		if (this.#hoveredIndex !== null) this.#hoverFade.set(this.#hoveredIndex);
	}

	disposeHoverMotion(): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredIndex = null;
	}

	#hoverStrength(index: number): number {
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredIndex ? 1 : 0;
	}

	#hoverIndexAt(line: number): number | null {
		const listLine = line - LIST_ROW_START;
		if (listLine < 0 || listLine >= this.#windowCount) return null;
		const index = this.#windowStart + listLine;
		const item = this.#visibleItems[index];
		if (!item || this.#isDisabled(item)) return null;
		return index;
	}

	#invalidateColumnWidths(): void {
		this.#columnWidths = undefined;
	}

	#measureColumns(perfMode: PerfMode): { ctx: number; cost: number; perf: number } {
		const cached = this.#columnWidths;
		if (cached && cached.perfMode === perfMode) return cached;

		let ctx = 0;
		let cost = 0;
		let perf = 0;
		for (const item of this.#visibleItems) {
			if (!item || item.virtualLabel !== undefined) continue;
			ctx = Math.max(ctx, visibleWidth(formatContext(item.model)));
			cost = Math.max(cost, visibleWidth(formatCostPair(item.model)));
			perf = Math.max(perf, visibleWidth(this.#perfCell(item, perfMode)));
		}
		this.#columnWidths = { perfMode, ctx, cost, perf };
		return this.#columnWidths;
	}

	#perfCell(item: ModelBrowserItem, mode: PerfMode): string {
		if (mode === "off") return "";
		const perf = this.#perf.get(item.selector);
		if (!perf) return "";
		const tps = formatTps(perf.tps);
		if (mode === "full" && perf.ttftMs !== null) return `${formatTtft(perf.ttftMs)} ${tps}`;
		return tps;
	}

	#renderRow(
		item: ModelBrowserItem,
		width: number,
		selected: boolean,
		hoverStrength: number,
		ctxWidth: number,
		costWidth: number,
		perfWidth: number,
		perfMode: PerfMode,
	): string {
		if (item.id === "separator") {
			const dashCount = Math.max(0, width - 4);
			const line = theme.fg("muted", "─".repeat(dashCount));
			return `  ${line}  `;
		}
		if (item.virtualLabel !== undefined) {
			const prefix = selected && this.#focused ? `${theme.fg("accent", theme.nav.cursor)} ` : "  ";
			const name = selected ? theme.fg("accent", item.virtualLabel) : theme.fg("muted", item.virtualLabel);
			const currentMark =
				item.selector === this.#currentSelector ? ` ${theme.fg("success", theme.status.enabled)}` : "";
			const line = `${prefix}${name}${currentMark}`;
			return hoverStrength > 0
				? hoverBandAt(line, width, hoverStrength)
				: truncateToWidth(line, width, Ellipsis.Omit, true);
		}
		const disabled = this.#isDisabled(item);
		const prefix = selected && this.#focused ? `${theme.fg("accent", theme.nav.cursor)} ` : "  ";
		const providerPrefix = this.#showProvider ? theme.fg("dim", `${item.provider}/`) : "";
		const name = item.labelColor
			? theme.fg(item.labelColor, item.id)
			: selected
				? theme.fg("accent", item.id)
				: item.id;
		const currentMark =
			item.selector === this.#currentSelector ? ` ${theme.fg("success", theme.status.enabled)}` : "";
		const authBadge = item.badge ? ` ${theme.fg(item.badgeColor ?? "dim", item.badge)}` : "";
		const overLimit = disabled
			? ` ${theme.status.disabled} context>${formatNumber(item.model.contextWindow ?? 0).toLowerCase()}`
			: "";
		let left = `${prefix}${providerPrefix}${name}${currentMark}${authBadge}${overLimit}`;

		const perfCol =
			perfWidth > 0 ? `${theme.fg("dim", padLeftVisible(this.#perfCell(item, perfMode), perfWidth))}  ` : "";
		const meta = `${perfCol}${theme.fg("dim", padLeftVisible(formatContext(item.model), ctxWidth))}  ${theme.fg("dim", padLeftVisible(formatCostPair(item.model), costWidth))}`;
		const metaWidth = ctxWidth + costWidth + 2 + (perfWidth > 0 ? perfWidth + 2 : 0);
		const available = Math.max(1, width - metaWidth - 1);
		left = truncateToWidth(left, available);
		const gap = Math.max(0, available - visibleWidth(left));

		let line = `${left}${padding(gap)} ${meta}`;
		if (disabled) {
			line = theme.fg("dim", Bun.stripANSI(line));
		}
		if (hoverStrength > 0 && !disabled) {
			return hoverBandAt(line, width, hoverStrength);
		}
		return truncateToWidth(line, width);
	}

	#detailLines(width: number): [string, string] {
		const selected = this.getSelected();
		if (!selected) return ["", ""];
		if (selected.virtualLabel !== undefined) {
			const line1 = truncateToWidth(
				theme.fg("muted", `  ${selected.virtualDetail ?? selected.virtualLabel}`),
				width,
			);
			const line2 =
				selected.selector === this.#currentSelector
					? truncateToWidth(`  ${theme.fg("success", `${theme.status.enabled} current`)}`, width)
					: "";
			return [line1, line2];
		}
		const model = selected.model;

		const facts: string[] = [model.name];
		if (model.contextWindow) facts.push(`${formatNumber(model.contextWindow).toLowerCase()} ctx`);
		if (model.maxTokens) facts.push(`${formatNumber(model.maxTokens).toLowerCase()} out`);
		const pricing = getModelPricing(model);
		facts.push(
			pricing === "unpriced" ? "price unknown" : pricing === "free" ? "free" : `${formatCostPair(model)} per M`,
		);
		if (model.reasoning) facts.push("reasoning");
		if (model.input.includes("image")) facts.push("vision");
		const perf = this.#perf.get(selected.selector);
		if (perf) {
			facts.push(`~${formatTps(perf.tps)}`);
			if (perf.ttftMs !== null) facts.push(`${formatTtft(perf.ttftMs)} ttft`);
		}
		const line1 = truncateToWidth(theme.fg("muted", `  ${facts.join(" · ")}`), width);

		if (this.#isDisabled(selected)) {
			const warning = `  ${theme.status.disabled} current context ${formatNumber(this.#currentContextTokens).toLowerCase()} exceeds ${formatNumber(model.contextWindow ?? 0).toLowerCase()} limit`;
			return [line1, truncateToWidth(theme.fg("warning", warning), width)];
		}

		const chips: string[] = [];
		if (selected.selector === this.#currentSelector) {
			chips.push(theme.fg("success", `${theme.status.enabled} current`));
		}
		const seen = new Set<string>();
		const pushRole = (role: string) => {
			if (seen.has(role)) return;
			seen.add(role);
			const assignment = this.#roles[role];
			if (!assignment || !modelsAreEqual(assignment.model, model)) return;
			if (getRoleInfo(role, this.#settings).hidden) return;
			chips.push(formatRoleChip(role, assignment, this.#settings));
		};
		for (const role of MODEL_ROLE_IDS) pushRole(role);
		for (const role in this.#roles) pushRole(role);
		const line2 = chips.length > 0 ? truncateToWidth(`  ${chips.join(theme.fg("dim", " · "))}`, width) : "";
		return [line1, line2];
	}

	render(width: number): string[] {
		const lines: string[] = [];

		const searchIcon = theme.fg("accent", theme.symbol("icon.search"));
		const inputWidth = Math.max(4, width - visibleWidth(theme.symbol("icon.search")) - 2);
		lines.push(` ${searchIcon} ${this.#searchInput.render(inputWidth)[0] ?? ""}`);
		lines.push("");

		const total = this.#visibleItems.length;
		this.#windowStart = this.#clampWindowStart(this.#windowStart);
		const startIndex = this.#windowStart;
		const endIndex = Math.min(startIndex + this.#maxVisible, total);
		this.#windowCount = Math.max(0, endIndex - startIndex);

		if (total === 0) {
			const message =
				this.#emptyText?.() ?? (this.query.trim() ? "  No matching models" : "  No models available in this scope");
			lines.push(truncateToWidth(theme.fg("muted", message), width));
			for (let i = 1; i < this.#maxVisible; i++) lines.push("");
		} else {
			const perfMode: PerfMode = width >= PERF_FULL_MIN_WIDTH ? "full" : width >= PERF_TPS_MIN_WIDTH ? "tps" : "off";
			const { ctx: ctxWidth, cost: costWidth, perf: perfWidth } = this.#measureColumns(perfMode);

			const barCols = total > this.#windowCount ? 2 : 1;
			const rows: string[] = [];
			for (let i = startIndex; i < endIndex; i++) {
				const item = this.#visibleItems[i];
				if (!item) continue;
				rows.push(
					this.#renderRow(
						item,
						width - barCols,
						i === this.#selectedIndex,
						this.#hoverStrength(i),
						ctxWidth,
						costWidth,
						perfWidth,
						perfMode,
					),
				);
			}
			const scrollView = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: total,
				theme: SCROLL_LIST_THEME,
			});
			scrollView.setScrollOffset(startIndex);
			const svLines = scrollView.render(width);
			for (let li = 0; li < svLines.length; li++) lines.push(svLines[li]!);
			for (let i = rows.length; i < this.#maxVisible; i++) lines.push("");
		}

		lines.push("");
		const [detail1, detail2] = this.#detailLines(width);
		lines.push(detail1);
		lines.push(detail2);
		return lines;
	}

	invalidate(): void {}
}
