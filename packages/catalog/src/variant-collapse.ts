import { buildCompat, buildModel } from "./build";
import { Effort } from "./effort";
import { stripThinkingVariantToken } from "./identity/family";
import { resolveModelThinking } from "./model-thinking";
import type { Api, Model, ModelSpec, Provider, ThinkingConfig } from "./types";

export type VariantSpecLike = Omit<ModelSpec<Api>, "compat"> & { compat?: unknown };

export interface EffortVariantFamily {
	id: string;
	name: string;
	members: readonly string[];
	retiredMembers?: readonly string[];
	routing: Readonly<Partial<Record<Effort | "off", string>>>;
	thinking: Readonly<Omit<ThinkingConfig, "effortRouting" | "suppressWhenOff">>;
	suppressWhenOff?: boolean;
	preserveAbsentEffortRoutes?: boolean;
	extraAliases?: readonly string[];
}

export interface VariantCollapseTable {
	families: readonly EffortVariantFamily[];
}

const EFFORT_TIER_SUFFIX_RE = /-(?:minimal|low|medium|high|xhigh|max|none|thinking)$/;

export function stripEffortTierSuffix(id: string): string | undefined {
	const stripped = id.replace(EFFORT_TIER_SUFFIX_RE, "");
	return stripped !== id && stripped.length > 0 ? stripped : undefined;
}

function thinkingPair(baseId: string, name: string): EffortVariantFamily {
	return {
		id: baseId,
		name,
		members: [baseId, `${baseId}-thinking`],
		routing: {
			off: baseId,
			[Effort.Minimal]: `${baseId}-thinking`,
			[Effort.Low]: `${baseId}-thinking`,
			[Effort.Medium]: `${baseId}-thinking`,
			[Effort.High]: `${baseId}-thinking`,
		},

		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		preserveAbsentEffortRoutes: true,
	};
}

type DevinTierRoutes = Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string>>;

const DEVIN_FIVE_TIER_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];
const DEVIN_FOUR_TIER_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];

function devinTierFamily(
	id: string,
	name: string,
	routes: DevinTierRoutes,
	efforts: readonly Effort[],
): EffortVariantFamily {
	const routing: Partial<Record<Effort | "off", string>> = {};
	if (routes.off) routing.off = routes.off;
	for (const effort of efforts) {
		switch (effort) {
			case Effort.Minimal:
				if (routes.minimal) routing[effort] = routes.minimal;
				break;
			case Effort.Low:
				if (routes.low) routing[effort] = routes.low;
				break;
			case Effort.Medium:
				if (routes.medium) routing[effort] = routes.medium;
				break;
			case Effort.High:
				if (routes.high) routing[effort] = routes.high;
				break;
			case Effort.XHigh:
				if (routes.xhigh) routing[effort] = routes.xhigh;
				break;
			case Effort.Max:
				if (routes.max) routing[effort] = routes.max;
				break;
		}
	}
	const members = [
		routes.off,
		routes.minimal,
		routes.low,
		routes.medium,
		routes.high,
		routes.xhigh,
		routes.max,
	].filter((member, index, items): member is string => typeof member === "string" && items.indexOf(member) === index);
	return {
		id,
		name,
		members,
		routing,
		thinking: {
			mode: "effort",
			efforts,
			...(routes.off ? undefined : { requiresEffort: true }),
		},
	};
}

function devinGpt56Families(variant: "luna" | "sol" | "terra", name: string): readonly EffortVariantFamily[] {
	const base = `gpt-5-6-${variant}`;
	return [
		devinTierFamily(
			base,
			name,
			{
				off: `${base}-none`,
				low: `${base}-low`,
				medium: `${base}-medium`,
				high: `${base}-high`,
				xhigh: `${base}-xhigh`,
				max: `${base}-max`,
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		devinTierFamily(
			`${base}-fast`,
			`${name} Fast`,
			{
				off: `${base}-none-priority`,
				low: `${base}-low-priority`,
				medium: `${base}-medium-priority`,
				high: `${base}-high-priority`,
				xhigh: `${base}-xhigh-priority`,
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
	];
}

const GEMINI_3_FLASH_FAMILY_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const GEMINI_3_PRO_FAMILY_EFFORTS: readonly Effort[] = [Effort.Low, Effort.High];

const GEMINI_3_FLASH_FAMILY_BUDGETS: Readonly<Partial<Record<Effort, number>>> = {
	[Effort.Minimal]: 1000,
	[Effort.Low]: 1000,
	[Effort.Medium]: 4000,
	[Effort.High]: 10000,
};
const GEMINI_3_PRO_FAMILY_BUDGETS: Readonly<Partial<Record<Effort, number>>> = {
	[Effort.Low]: 1001,
	[Effort.High]: 10001,
};

function geminiFlashFamily(mode: "budget" | "google-level"): EffortVariantFamily {
	const budget = mode === "budget";
	return {
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		members: ["gemini-3.5-flash-extra-low", "gemini-3.5-flash-low", "gemini-3-flash-agent"],
		routing: budget
			? {
					off: "gemini-3.5-flash-extra-low",
					[Effort.Minimal]: "gemini-3.5-flash-extra-low",
					[Effort.Low]: "gemini-3.5-flash-extra-low",
					[Effort.Medium]: "gemini-3.5-flash-low",
					[Effort.High]: "gemini-3-flash-agent",
				}
			: {
					off: "gemini-3.5-flash-extra-low",
					[Effort.Minimal]: "gemini-3-flash-agent",
					[Effort.Low]: "gemini-3.5-flash-extra-low",
					[Effort.Medium]: "gemini-3.5-flash-extra-low",
					[Effort.High]: "gemini-3.5-flash-low",
				},
		thinking: budget
			? { mode: "budget", efforts: GEMINI_3_FLASH_FAMILY_EFFORTS, effortBudgets: GEMINI_3_FLASH_FAMILY_BUDGETS }
			: { mode: "google-level", efforts: GEMINI_3_FLASH_FAMILY_EFFORTS },
		suppressWhenOff: true,
		extraAliases: ["gemini-3-flash"],
	};
}

function geminiProFamily(mode: "budget" | "google-level"): EffortVariantFamily {
	const budget = mode === "budget";
	return {
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		members: ["gemini-3.1-pro-low", "gemini-pro-agent", "gemini-3.1-pro-high"],
		retiredMembers: ["gemini-3.1-pro-high"],
		routing: {
			off: "gemini-3.1-pro-low",
			[Effort.Low]: "gemini-3.1-pro-low",
			[Effort.High]: "gemini-pro-agent",
		},
		thinking: budget
			? { mode: "budget", efforts: GEMINI_3_PRO_FAMILY_EFFORTS, effortBudgets: GEMINI_3_PRO_FAMILY_BUDGETS }
			: { mode: "google-level", efforts: GEMINI_3_PRO_FAMILY_EFFORTS },
		suppressWhenOff: true,
	};
}

function gemini36FlashFamily(): EffortVariantFamily {
	return {
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		members: ["gemini-3.6-flash-low", "gemini-3.6-flash-medium", "gemini-3.6-flash-high"],
		routing: {
			[Effort.Minimal]: "gemini-3.6-flash-low",
			[Effort.Low]: "gemini-3.6-flash-low",
			[Effort.Medium]: "gemini-3.6-flash-medium",
			[Effort.High]: "gemini-3.6-flash-high",
		},
		thinking: { mode: "effort", efforts: GEMINI_3_FLASH_FAMILY_EFFORTS },
	};
}

function geminiTieredFlashFamily(id: string, name: string, wireId: string): EffortVariantFamily {
	return {
		id,
		name,
		members: [wireId],
		routing: {
			[Effort.Low]: wireId,
			[Effort.Medium]: wireId,
			[Effort.High]: wireId,
		},
		thinking: { mode: "google-level", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	};
}

const SHARED_CCA_FAMILIES: readonly EffortVariantFamily[] = [
	gemini36FlashFamily(),
	geminiTieredFlashFamily("gemini-3.7-flash", "Gemini 3.7 Flash", "gemini-3.7-flash-tiered"),
	geminiTieredFlashFamily("gemini-3.6-flash-tiered", "Gemini 3.6 Flash Tiered", "gemini-3.6-flash-tiered"),
	{
		id: "gemini-3-pro",
		name: "Gemini 3 Pro",
		members: ["gemini-3-pro-low", "gemini-3-pro-high"],
		routing: {
			off: "gemini-3-pro-low",
			[Effort.Low]: "gemini-3-pro-low",
			[Effort.High]: "gemini-3-pro-high",
		},
		thinking: { mode: "google-level", efforts: GEMINI_3_PRO_FAMILY_EFFORTS },
		suppressWhenOff: true,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B",
		members: ["gpt-oss-120b-medium"],
		routing: {},
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	},

	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		members: ["claude-sonnet-4-6", "claude-sonnet-4-6-thinking"],
		retiredMembers: ["claude-sonnet-4-6-thinking"],
		routing: {},
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	},

	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		members: ["claude-opus-4-6-thinking", "claude-opus-4-6"],
		retiredMembers: ["claude-opus-4-6"],
		routing: {},
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	},
	thinkingPair("claude-sonnet-4-5", "Claude Sonnet 4.5"),
	thinkingPair("claude-opus-4-5", "Claude Opus 4.5"),
	thinkingPair("gemini-2.5-flash", "Gemini 2.5 Flash"),
];

export const ANTIGRAVITY_VARIANT_COLLAPSE_TABLE: VariantCollapseTable = {
	families: [geminiFlashFamily("budget"), geminiProFamily("budget"), ...SHARED_CCA_FAMILIES],
};

export const GEMINI_CLI_VARIANT_COLLAPSE_TABLE: VariantCollapseTable = {
	families: [geminiFlashFamily("google-level"), geminiProFamily("google-level"), ...SHARED_CCA_FAMILIES],
};
export const DEVIN_VARIANT_COLLAPSE_TABLE: VariantCollapseTable = {
	families: [
		devinTierFamily(
			"claude-opus-4-7",
			"Claude Opus 4.7",
			{
				low: "claude-opus-4-7-low",
				medium: "claude-opus-4-7-medium",
				high: "claude-opus-4-7-high",
				xhigh: "claude-opus-4-7-xhigh",
				max: "claude-opus-4-7-max",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		devinTierFamily(
			"claude-opus-4-7-fast",
			"Claude Opus 4.7 Fast",
			{
				low: "claude-opus-4-7-low-fast",
				medium: "claude-opus-4-7-medium-fast",
				high: "claude-opus-4-7-high-fast",
				xhigh: "claude-opus-4-7-xhigh-fast",
				max: "claude-opus-4-7-max-fast",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		devinTierFamily(
			"claude-opus-4-8",
			"Claude Opus 4.8",
			{
				low: "claude-opus-4-8-low",
				medium: "claude-opus-4-8-medium",
				high: "claude-opus-4-8-high",
				xhigh: "claude-opus-4-8-xhigh",
				max: "claude-opus-4-8-max",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		devinTierFamily(
			"claude-opus-4-8-fast",
			"Claude Opus 4.8 Fast",
			{
				low: "claude-opus-4-8-low-fast",
				medium: "claude-opus-4-8-medium-fast",
				high: "claude-opus-4-8-high-fast",
				xhigh: "claude-opus-4-8-xhigh-fast",
				max: "claude-opus-4-8-max-fast",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		devinTierFamily(
			"claude-5-fable",
			"Claude Fable 5",
			{
				low: "claude-5-fable-low",
				medium: "claude-5-fable-medium",
				high: "claude-5-fable-high",
				xhigh: "claude-5-fable-xhigh",
				max: "claude-5-fable-max",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		devinTierFamily(
			"claude-sonnet-5",
			"Claude Sonnet 5",
			{
				low: "claude-sonnet-5-low",
				medium: "claude-sonnet-5-medium",
				high: "claude-sonnet-5-high",
				xhigh: "claude-sonnet-5-xhigh",
				max: "claude-sonnet-5-max",
			},
			DEVIN_FIVE_TIER_EFFORTS,
		),
		devinTierFamily(
			"grok-4-5",
			"Grok 4.5",
			{
				low: "grok-4-5-low",
				medium: "grok-4-5-medium",
				high: "grok-4-5-high",
			},
			[Effort.Low, Effort.Medium, Effort.High],
		),

		devinTierFamily(
			"glm-5-2",
			"GLM-5.2",
			{
				off: "glm-5-2-none",
				high: "glm-5-2",
				max: "glm-5-2-max",
			},
			[Effort.High, Effort.Max],
		),
		devinTierFamily(
			"glm-5-2-1m",
			"GLM-5.2 1M",
			{
				off: "glm-5-2-none-1m",
				high: "glm-5-2-1m",
				max: "glm-5-2-max-1m",
			},
			[Effort.High, Effort.Max],
		),

		devinTierFamily(
			"MODEL_CLAUDE_4_5_OPUS",
			"Claude Opus 4.5",
			{
				off: "MODEL_CLAUDE_4_5_OPUS",
				high: "MODEL_CLAUDE_4_5_OPUS_THINKING",
			},
			[Effort.High],
		),
		devinTierFamily(
			"gpt-5-2",
			"GPT-5.2",
			{
				off: "MODEL_GPT_5_2_NONE",
				low: "MODEL_GPT_5_2_LOW",
				medium: "MODEL_GPT_5_2_MEDIUM",
				high: "MODEL_GPT_5_2_HIGH",
				xhigh: "MODEL_GPT_5_2_XHIGH",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		devinTierFamily(
			"gpt-5-3-codex",
			"GPT-5.3 Codex",
			{
				low: "gpt-5-3-codex-low",
				medium: "gpt-5-3-codex-medium",
				high: "gpt-5-3-codex-high",
				xhigh: "gpt-5-3-codex-xhigh",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		devinTierFamily(
			"gpt-5-3-codex-fast",
			"GPT-5.3 Codex Fast",
			{
				low: "gpt-5-3-codex-low-priority",
				medium: "gpt-5-3-codex-medium-priority",
				high: "gpt-5-3-codex-high-priority",
				xhigh: "gpt-5-3-codex-xhigh-priority",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		devinTierFamily(
			"gpt-5-4",
			"GPT-5.4",
			{
				off: "gpt-5-4-none",
				low: "gpt-5-4-low",
				medium: "gpt-5-4-medium",
				high: "gpt-5-4-high",
				xhigh: "gpt-5-4-xhigh",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		devinTierFamily(
			"gpt-5-4-fast",
			"GPT-5.4 Fast",
			{
				off: "gpt-5-4-none-priority",
				low: "gpt-5-4-low-priority",
				medium: "gpt-5-4-medium-priority",
				high: "gpt-5-4-high-priority",
				xhigh: "gpt-5-4-xhigh-priority",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		devinTierFamily(
			"gpt-5-4-mini",
			"GPT-5.4 Mini",
			{
				low: "gpt-5-4-mini-low",
				medium: "gpt-5-4-mini-medium",
				high: "gpt-5-4-mini-high",
				xhigh: "gpt-5-4-mini-xhigh",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		devinTierFamily(
			"gpt-5-5",
			"GPT-5.5",
			{
				off: "gpt-5-5-none",
				low: "gpt-5-5-low",
				medium: "gpt-5-5-medium",
				high: "gpt-5-5-high",
				xhigh: "gpt-5-5-xhigh",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		devinTierFamily(
			"gpt-5-5-fast",
			"GPT-5.5 Fast",
			{
				off: "gpt-5-5-none-priority",
				low: "gpt-5-5-low-priority",
				medium: "gpt-5-5-medium-priority",
				high: "gpt-5-5-high-priority",
				xhigh: "gpt-5-5-xhigh-priority",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		...devinGpt56Families("luna", "GPT-5.6 Luna"),
		...devinGpt56Families("sol", "GPT-5.6 Sol"),
		...devinGpt56Families("terra", "GPT-5.6 Terra"),
		devinTierFamily(
			"gemini-3-1-pro",
			"Gemini 3.1 Pro",
			{
				low: "gemini-3-1-pro-low",
				high: "gemini-3-1-pro-high",
			},
			[Effort.Low, Effort.High],
		),
		devinTierFamily(
			"gemini-3-5-flash",
			"Gemini 3.5 Flash",
			{
				minimal: "gemini-3-5-flash-minimal",
				low: "gemini-3-5-flash-low",
				medium: "gemini-3-5-flash-medium",
				high: "gemini-3-5-flash-high",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		),
		devinTierFamily(
			"gemini-3-flash",
			"Gemini 3 Flash",
			{
				minimal: "MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL",
				low: "MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW",
				medium: "MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM",
				high: "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		),
	],
};

export const CURSOR_VARIANT_COLLAPSE_TABLE: VariantCollapseTable = {
	families: [
		devinTierFamily(
			"gpt-5.4",
			"GPT-5.4",
			{
				low: "gpt-5.4-low",
				medium: "gpt-5.4-medium",
				high: "gpt-5.4-high",
				xhigh: "gpt-5.4-xhigh",
			},
			DEVIN_FOUR_TIER_EFFORTS,
		),
		{
			id: "gpt-5.2-codex",
			name: "GPT-5.2 Codex",
			members: ["gpt-5.2-codex", "gpt-5.2-codex-low", "gpt-5.2-codex-high", "gpt-5.2-codex-xhigh"],
			routing: {
				[Effort.Low]: "gpt-5.2-codex-low",
				[Effort.High]: "gpt-5.2-codex-high",
				[Effort.XHigh]: "gpt-5.2-codex-xhigh",
			},
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High, Effort.XHigh] },
		},
		{
			id: "gpt-5.3-codex",
			name: "GPT-5.3 Codex",
			members: ["gpt-5.3-codex", "gpt-5.3-codex-low", "gpt-5.3-codex-high", "gpt-5.3-codex-xhigh"],
			routing: {
				[Effort.Low]: "gpt-5.3-codex-low",
				[Effort.High]: "gpt-5.3-codex-high",
				[Effort.XHigh]: "gpt-5.3-codex-xhigh",
			},
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High, Effort.XHigh] },
		},
		{
			id: "gpt-5.2",
			name: "GPT-5.2",
			members: ["gpt-5.2", "gpt-5.2-high"],
			routing: { [Effort.High]: "gpt-5.2-high" },
			thinking: { mode: "effort", efforts: [Effort.High] },
		},
	],
};

export const VARIANT_COLLAPSE_TABLES: Readonly<Record<string, VariantCollapseTable>> = {
	"google-antigravity": ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
	"google-gemini-cli": GEMINI_CLI_VARIANT_COLLAPSE_TABLE,
	devin: DEVIN_VARIANT_COLLAPSE_TABLE,
	cursor: CURSOR_VARIANT_COLLAPSE_TABLE,
};

export function deriveThinkingPairFamilies<TSpec extends VariantSpecLike>(
	specs: readonly TSpec[],
	table?: VariantCollapseTable,
): EffortVariantFamily[] {
	const byId = new Map<string, TSpec>();
	for (const spec of specs) {
		if (!byId.has(spec.id)) byId.set(spec.id, spec);
	}
	const claimed = table ? getAliasIndex(table) : undefined;
	const families: EffortVariantFamily[] = [];
	for (const spec of specs) {
		const baseId = stripThinkingVariantToken(spec.id);
		if (baseId === undefined || baseId === spec.id) continue;
		const base = byId.get(baseId);
		if (!base) continue;
		if (claimed) {
			const forward = claimed.forward;
			if (
				forward.has(spec.id.toLowerCase()) ||
				forward.has(baseId.toLowerCase()) ||
				claimed.familyIds.has(spec.id) ||
				claimed.familyIds.has(baseId)
			) {
				continue;
			}
		}
		if (spec.api !== base.api) continue;
		const specPriced = spec.cost.input !== 0 || spec.cost.output !== 0;
		const basePriced = base.cost.input !== 0 || base.cost.output !== 0;

		const cacheFieldDiffers = (a: number, b: number): boolean => a !== 0 && b !== 0 && a !== b;
		if (
			specPriced &&
			basePriced &&
			(spec.cost.input !== base.cost.input ||
				spec.cost.output !== base.cost.output ||
				cacheFieldDiffers(spec.cost.cacheRead, base.cost.cacheRead) ||
				cacheFieldDiffers(spec.cost.cacheWrite, base.cost.cacheWrite))
		) {
			continue;
		}
		const surface = derivePairThinkingSurface(spec, base);
		const routing: Partial<Record<Effort | "off", string>> = { off: base.id };
		for (const effort of surface.efforts) {
			routing[effort] = spec.id;
		}
		families.push({
			id: base.id,
			name: base.name,
			members: [base.id, spec.id],
			routing,
			thinking: surface,
		});
	}
	return families;
}

const DEFAULT_PAIR_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];

function derivePairThinkingSurface(
	thinkingSpec: VariantSpecLike,
	baseSpec: VariantSpecLike,
): Omit<ThinkingConfig, "effortRouting" | "suppressWhenOff" | "requiresEffort"> {
	const baked = thinkingSpec.thinking ?? baseSpec.thinking;
	if (baked && baked.efforts.length > 0) {
		const { effortRouting: _routing, suppressWhenOff: _suppress, requiresEffort: _required, ...surface } = baked;
		return surface;
	}
	const derived = resolveModelThinking(
		{ ...(thinkingSpec as unknown as ModelSpec<Api>), reasoning: true, thinking: undefined },
		buildCompat(thinkingSpec as unknown as ModelSpec<Api>),
	);
	if (derived && derived.efforts.length > 0) {
		const { effortRouting: _dRouting, suppressWhenOff: _dSuppress, requiresEffort: _dRequired, ...surface } = derived;
		return surface;
	}
	return { mode: "budget", efforts: DEFAULT_PAIR_EFFORTS };
}

export function isVariantCollapsedSpec(spec: VariantSpecLike): boolean {
	if (spec.thinking?.effortRouting !== undefined) {
		return true;
	}
	if (spec.requestModelId === undefined) {
		return false;
	}
	const table = VARIANT_COLLAPSE_TABLES[spec.provider];
	return table !== undefined && getAliasIndex(table).familyIds.has(spec.id);
}

function reconcileRetiredRouting<TSpec extends VariantSpecLike>(
	spec: TSpec,
	family: EffortVariantFamily,
	retired: ReadonlySet<string>,
): TSpec {
	const routing = spec.thinking?.effortRouting;
	const requestRetired = spec.requestModelId !== undefined && retired.has(spec.requestModelId);
	let routingRetired = false;
	if (routing !== undefined) {
		for (const key in routing) {
			const target = routing[key as Effort | "off"];
			if (target !== undefined && retired.has(target)) {
				routingRetired = true;
				break;
			}
		}
	}
	if (!requestRetired && !routingRetired) return spec;

	const offTarget = family.routing.off;
	const fallbackWireId =
		offTarget !== undefined && !retired.has(offTarget) ? offTarget : family.members.find(id => !retired.has(id));
	const next: TSpec = { ...spec };
	if (routingRetired && routing !== undefined) {
		const nextRouting: Partial<Record<Effort | "off", string>> = {};
		for (const key in routing) {
			const effortKey = key as Effort | "off";
			const target = routing[effortKey];
			if (target === undefined) continue;
			if (!retired.has(target)) {
				nextRouting[effortKey] = target;
				continue;
			}
			const tableTarget = family.routing[effortKey];
			if (tableTarget !== undefined && !retired.has(tableTarget)) {
				nextRouting[effortKey] = tableTarget;
			} else if (fallbackWireId !== undefined) {
				nextRouting[effortKey] = fallbackWireId;
			}
		}
		next.thinking = { ...(spec.thinking as ThinkingConfig), effortRouting: nextRouting };
	}
	if (requestRetired) {
		if (fallbackWireId !== undefined && fallbackWireId !== spec.id) {
			next.requestModelId = fallbackWireId;
		} else {
			delete next.requestModelId;
		}
	}
	return next;
}

function refreshCollapsedThinking<TSpec extends VariantSpecLike>(
	spec: TSpec,
	family: EffortVariantFamily,
	retired: ReadonlySet<string> | undefined,
): TSpec {
	if (!spec.reasoning || family.thinking.effortBudgets === undefined) return spec;
	const routing: Partial<Record<Effort | "off", string>> = {};
	let hasRouting = false;
	for (const effortKey in family.routing) {
		const target = family.routing[effortKey as Effort | "off"];
		if (target !== undefined && !retired?.has(target)) {
			routing[effortKey as Effort | "off"] = target;
			hasRouting = true;
		}
	}
	const thinking: ThinkingConfig = { ...family.thinking };
	if (hasRouting) thinking.effortRouting = routing;
	if (family.suppressWhenOff) thinking.suppressWhenOff = true;
	const offTarget = family.routing.off;
	const requestModelId =
		offTarget !== undefined && !retired?.has(offTarget) && offTarget !== spec.id ? offTarget : spec.requestModelId;
	if (Bun.deepEquals(thinking, spec.thinking) && requestModelId === spec.requestModelId) {
		return spec;
	}
	return { ...spec, thinking, ...(requestModelId !== undefined ? { requestModelId } : {}) };
}

export function collapseEffortVariants<TSpec extends VariantSpecLike>(
	specs: readonly TSpec[],
	table: VariantCollapseTable,
): TSpec[] {
	const byId = new Map<string, TSpec>();
	for (const spec of specs) {
		if (!byId.has(spec.id)) byId.set(spec.id, spec);
	}

	const replacement = new Map<string, TSpec>();

	const familyIdBySpecId = new Map<string, string>();

	for (const family of table.families) {
		const retired =
			family.retiredMembers !== undefined && family.retiredMembers.length > 0
				? new Set(family.retiredMembers)
				: undefined;
		const existing = byId.get(family.id);
		const existingCollapsed =
			existing !== undefined &&
			(existing.requestModelId !== undefined || existing.thinking?.effortRouting !== undefined);
		const reconciled =
			existing !== undefined && existingCollapsed && retired !== undefined
				? reconcileRetiredRouting(existing, family, retired)
				: existing;
		const rawPresent = family.members.filter(id => byId.has(id) && !(id === family.id && existingCollapsed));
		if (rawPresent.length === 0) {
			const refreshed =
				existing !== undefined && existingCollapsed
					? refreshCollapsedThinking(reconciled ?? existing, family, retired)
					: reconciled;
			if (refreshed !== undefined && refreshed !== existing) {
				familyIdBySpecId.set(family.id, family.id);
				replacement.set(family.id, refreshed);
			}
			continue;
		}

		for (const id of rawPresent) familyIdBySpecId.set(id, family.id);
		if (existing) familyIdBySpecId.set(family.id, family.id);

		if (existingCollapsed) {
			replacement.set(family.id, reconciled as TSpec);
			continue;
		}

		const memberSpecs = rawPresent.map(id => byId.get(id) as TSpec);
		const presentSet = new Set(rawPresent);
		const routing: Partial<Record<Effort | "off", string>> = {};
		let hasRouting = false;
		let hasEffortRoute = false;
		let usedAbsentEffortRoute = false;
		for (const effortKey in family.routing) {
			const target = family.routing[effortKey as Effort | "off"];
			const effort = effortKey as Effort | "off";
			const targetPresent = target !== undefined && presentSet.has(target);
			const preserveAbsentEffort =
				target !== undefined && effort !== "off" && family.preserveAbsentEffortRoutes === true;
			if (target !== undefined && (targetPresent || preserveAbsentEffort) && !retired?.has(target)) {
				routing[effort] = target;
				hasRouting = true;
				if (effortKey !== "off") hasEffortRoute = true;
				if (!targetPresent && effort !== "off") usedAbsentEffortRoute = true;
			}
		}

		const reasoning = memberSpecs.some(spec => spec.reasoning) || hasEffortRoute;
		const thinking: ThinkingConfig = { ...family.thinking };
		if (hasRouting) thinking.effortRouting = routing;
		if (family.suppressWhenOff) thinking.suppressWhenOff = true;

		const input: ("text" | "image")[] = [];
		if (memberSpecs.some(spec => spec.input.includes("text"))) input.push("text");
		if (memberSpecs.some(spec => spec.input.includes("image"))) input.push("image");

		const collapsed: TSpec = {
			...(memberSpecs[0] as TSpec),
			id: family.id,
			name: family.name,
			reasoning,
			input,
			contextWindow: maxOrNull(memberSpecs.map(spec => spec.contextWindow)),
			maxTokens: maxOrNull(memberSpecs.map(spec => spec.maxTokens)),
		};

		const defaultWireId = rawPresent.find(id => !retired?.has(id)) ?? rawPresent[0];
		if (defaultWireId === family.id) {
			if (usedAbsentEffortRoute) {
				collapsed.requestModelId = defaultWireId as string;
			} else {
				delete collapsed.requestModelId;
			}
		} else {
			collapsed.requestModelId = defaultWireId as string;
		}
		if (reasoning) {
			collapsed.thinking = thinking;
		} else {
			delete collapsed.thinking;
		}
		replacement.set(family.id, collapsed);
	}

	for (const family of table.families) {
		if (family.extraAliases === undefined) continue;
		const retired =
			family.retiredMembers !== undefined && family.retiredMembers.length > 0
				? new Set(family.retiredMembers)
				: undefined;
		for (const alias of family.extraAliases) {
			if (alias === family.id || familyIdBySpecId.has(alias)) continue;
			const aliasSpec = byId.get(alias);
			if (aliasSpec === undefined) continue;
			const refreshed = refreshCollapsedThinking(aliasSpec, family, retired);
			if (refreshed !== aliasSpec) {
				familyIdBySpecId.set(alias, alias);
				replacement.set(alias, refreshed);
			}
		}
	}

	if (replacement.size === 0) return specs.slice();

	const emitted = new Set<string>();
	const out: TSpec[] = [];
	for (const spec of specs) {
		const familyId = familyIdBySpecId.get(spec.id);
		if (familyId === undefined) {
			out.push(spec);
			continue;
		}
		if (emitted.has(familyId)) continue;
		emitted.add(familyId);
		out.push(replacement.get(familyId) as TSpec);
	}
	return out;
}

export function collapseEffortVariantsAcrossProviders<TSpec extends VariantSpecLike>(specs: readonly TSpec[]): TSpec[] {
	const byProvider = new Map<string, TSpec[]>();
	for (const spec of specs) {
		const slice = byProvider.get(spec.provider);
		if (slice) {
			slice.push(spec);
		} else {
			byProvider.set(spec.provider, [spec]);
		}
	}
	const out: TSpec[] = [];
	for (const [provider, slice] of byProvider) {
		const table = VARIANT_COLLAPSE_TABLES[provider];
		let result = table ? collapseEffortVariants(slice, table) : slice;
		const derived = deriveThinkingPairFamilies(result, table);
		if (derived.length > 0) {
			result = collapseEffortVariants(result, { families: derived });
		}
		for (let ri = 0; ri < result.length; ri++) out.push(result[ri]!);
	}
	return out;
}

export function collapseBuiltModelVariants<TApi extends Api>(models: readonly Model<TApi>[]): Model<TApi>[] {
	const collapsed = collapseEffortVariantsAcrossProviders(models);
	const inputRefs = new Set<Model<TApi>>(models);
	return collapsed.map(model =>
		inputRefs.has(model) ? model : buildModel({ ...model, compat: model.compatConfig } as unknown as ModelSpec<TApi>),
	);
}

interface VariantAliasIndex {
	forward: Map<string, string>;

	reverse: Map<string, readonly string[]>;

	familyIds: Set<string>;
}

const kAliasIndex = Symbol("variant-collapse.aliasIndex");

interface TableWithAliasIndex extends VariantCollapseTable {
	[kAliasIndex]?: VariantAliasIndex;
}

function getAliasIndex(table: VariantCollapseTable): VariantAliasIndex {
	const tagged = table as TableWithAliasIndex;
	const cached = tagged[kAliasIndex];
	if (cached) return cached;
	const forward = new Map<string, string>();
	const reverse = new Map<string, string[]>();
	const add = (from: string, to: string) => {
		if (from === to) return;
		forward.set(from.toLowerCase(), to);
		const sources = reverse.get(to);
		if (sources) {
			sources.push(from);
		} else {
			reverse.set(to, [from]);
		}
	};
	const familyIds = new Set<string>();
	for (const family of table.families) {
		familyIds.add(family.id);
		for (const member of family.members) add(member, family.id);
		for (const alias of family.extraAliases ?? []) add(alias, family.id);
	}
	const index: VariantAliasIndex = { forward, reverse, familyIds };
	tagged[kAliasIndex] = index;
	return index;
}

export function resolveVariantAlias(provider: Provider, modelId: string): string | undefined {
	const table = VARIANT_COLLAPSE_TABLES[provider] ?? VARIANT_COLLAPSE_TABLES[provider.toLowerCase()];
	if (!table) return undefined;
	return getAliasIndex(table).forward.get(modelId.trim().toLowerCase());
}

export interface BareVariantAliasHit {
	id: string;
	providers: readonly Provider[];
}

export function resolveBareVariantAlias(modelId: string): BareVariantAliasHit | undefined {
	const normalized = modelId.trim().toLowerCase();
	for (const provider in VARIANT_COLLAPSE_TABLES) {
		const table = VARIANT_COLLAPSE_TABLES[provider] as VariantCollapseTable;
		const hit = getAliasIndex(table).forward.get(normalized);
		if (hit === undefined) continue;
		const providers: Provider[] = [];
		for (const candidate in VARIANT_COLLAPSE_TABLES) {
			if (
				getAliasIndex(VARIANT_COLLAPSE_TABLES[candidate] as VariantCollapseTable).forward.get(normalized) === hit
			) {
				providers.push(candidate);
			}
		}
		return { id: hit, providers };
	}
	return undefined;
}

export function getVariantAliasSources(provider: Provider, modelId: string): readonly string[] {
	const table = VARIANT_COLLAPSE_TABLES[provider] ?? VARIANT_COLLAPSE_TABLES[provider.toLowerCase()];
	if (!table) return [];
	return getAliasIndex(table).reverse.get(modelId) ?? [];
}

function maxOrNull(values: ReadonlyArray<number | null>): number | null {
	const known = values.filter((v): v is number => v != null);
	return known.length ? Math.max(...known) : null;
}
