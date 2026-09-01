import { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { getModelPricing, modelsAreEqual } from "@veyyon/catalog/models";
import { padding, visibleWidth } from "@veyyon/tui";
import { formatNumber } from "@veyyon/utils";
import { resolveEffort, withLegacyDefaultEffort } from "../../config/effort-resolver";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import { DEFAULT_MODEL_SLOT, getKnownRoleIds, getRoleInfo, MODEL_ROLE_IDS } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../../thinking";
import { type ThemeColor, theme } from "../theme/theme";

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

export function virtualRowModel(): Model {
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

export function formatCostPair(model: Model): string {
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

export function formatContext(model: Model): string {
	const ctx = model.contextWindow ?? 0;
	if (ctx <= 0) return "";
	return `${formatNumber(ctx).toLowerCase()} ${theme.icon.context.replace(/:$/, "")}`;
}

export function formatTps(tps: number): string {
	const value = tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1);
	return `${value}t/s`;
}

export function formatTtft(ms: number): string {
	const seconds = ms / 1000;
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}

export function padLeftVisible(text: string, width: number): string {
	const missing = width - visibleWidth(text);
	return missing > 0 ? padding(missing) + text : text;
}

export interface ModelBrowserOptions {
	showProvider?: boolean;
	currentContextTokens?: number;
	disableOverContext?: boolean;
	emptyText?: () => string | undefined;
}

export const LIST_ROW_START = 2;
export const DETAIL_ROWS = 3;
export const PERF_TPS_MIN_WIDTH = 76;
export const PERF_FULL_MIN_WIDTH = 96;
export type PerfMode = "off" | "tps" | "full";
