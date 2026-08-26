/**
 * Effort-tier variant collapsing: collapses multi-tier and thinking-suffixed upstream
 * IDs into single logical model specs with per-effort wire routing (`effortRouting`).
 */
import { buildCompat, buildModel } from "./build";
import { Effort } from "./effort";
import { stripThinkingVariantToken } from "./identity/family";
import { resolveModelThinking } from "./model-thinking";
import type { Api, Model, ModelSpec, Provider, ThinkingConfig } from "./types";

/**
 * Structural bound for collapse inputs: both raw `ModelSpec`s and built
 * `Model`s qualify. (`Model.compat` is the resolved record, not the sparse
 * config, so the two are not mutually assignable — collapsing never touches
 * `compat`.)
 */
export type VariantSpecLike = Omit<ModelSpec<Api>, "compat"> & { compat?: unknown };

/** One collapsed family: logical id + member wire ids + per-effort routing. */
export interface EffortVariantFamily {
	/** Collapsed logical id (may equal a member id — e.g. bare/thinking pairs). */
	id: string;
	/** Final display name, no tier marker. */
	name: string;
	/**
	 * Member wire ids in priority order. The first member present in the input
	 * becomes the collapsed spec's default wire id (`requestModelId`; omitted
	 * when it equals the logical id).
	 */
	members: readonly string[];
	/**
	 * Wire IDs no longer served upstream. Routing targets pointing to retired IDs
	 * are re-pointed to active members during collapse reconciliation.
	 */
	retiredMembers?: readonly string[];
	/**
	 * Per-effort upstream wire id; `"off"` applies when thinking is disabled.
	 * Entries whose target member is absent from the input are dropped — those
	 * efforts fall back to `requestModelId ?? id`.
	 */
	routing: Readonly<Partial<Record<Effort | "off", string>>>;
	/** Explicit capability surface for the collapsed spec — no inference. */
	thinking: Readonly<Omit<ThinkingConfig, "effortRouting" | "suppressWhenOff">>;
	/** Thinking-off requests must explicitly suppress thinking on the wire. */
	suppressWhenOff?: boolean;
	/**
	 * Preserve non-off effort routes even when discovery omits the backing member.
	 * Used for Cloud Code Assist `X`/`X-thinking` pairs where upstream accepts
	 * the `-thinking` wire id but the model-list endpoint may advertise only the
	 * bare id.
	 */
	preserveAbsentEffortRoutes?: boolean;
	/** Retired/recycled selector ids that alias to this family without being members. */
	extraAliases?: readonly string[];
}

export interface VariantCollapseTable {
	families: readonly EffortVariantFamily[];
}

/**
 * Regular expression matching trailing effort-tier suffixes on sibling wire IDs
 * (e.g. `-minimal`, `-low`, `-medium`, `-high`, `-xhigh`, `-max`, `-none`, `-thinking`).
 */
const EFFORT_TIER_SUFFIX_RE = /-(?:minimal|low|medium|high|xhigh|max|none|thinking)$/;

/** The base id with one trailing effort-tier suffix removed, or undefined
 *  when `id` carries no tier suffix. */
export function stripEffortTierSuffix(id: string): string | undefined {
	const stripped = id.replace(EFFORT_TIER_SUFFIX_RE, "");
	return stripped !== id && stripped.length > 0 ? stripped : undefined;
}

/** `X` + `X-thinking` hand family: off routes to the bare id, efforts to `-thinking`. */
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
		// Thinking-off routes to the non-thinking backing id, where omitting
		// thinkingConfig is already correct — no suppressWhenOff.
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		preserveAbsentEffortRoutes: true,
	};
}

type DevinTierRoutes = Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string>>;

/** Devin families with a `-max` sibling: five wire tiers, `low` floor. */
const DEVIN_FIVE_TIER_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];
/** Devin families topping out at `-xhigh` (pre-5.6 GPT, 5.6 fast lanes). */
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

/**
 * GPT-5.6 (Luna/Sol/Terra) serves per-tier siblings for the full five-tier
 * `low..max` wire scale; user efforts route 1:1 onto them. Devin serves no
 * `-max-priority` sibling, so the fast family tops out at `xhigh`.
 */
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

/**
 * Antigravity Cloud Code Assist sends an explicit `thinkingBudget` per tier
 * (verified against captured `daily-cloudcode-pa` requests). Flash uses round
 * budgets; Pro offsets every budget by +1. Minimal mirrors Low (the Antigravity
 * UI exposes Low/Medium/High only) so the effort stays selectable.
 */
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

/**
 * Gemini Flash family for Cloud Code Assist providers, parameterized by thinking
 * transport mode (`"budget"` for google-antigravity vs `"google-level"` for gemini-cli).
 */
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
		// Retired bare id; the alias only fires when no live model holds it
		// (exact match wins in every resolver).
		//
		// `gemini-3.6-flash` is deliberately NOT aliased here. It is the id of a
		// real, separate family ({@link gemini36FlashFamily}) whose per-tier wire
		// ids come from the same Antigravity discovery list this family is built
		// from, so the two CAN be live on one provider — they are presence
		// filtered, not provider partitioned. Aliasing it meant that whenever
		// discovery happened not to serve the 3.6 tiers, a request for 3.6
		// quietly resolved to this 3.5 family instead: a different model, chosen
		// silently, with nothing in the resolved id to show the substitution. A
		// deepswe-bench run hit exactly that and measured 3.5 while reporting 3.6,
		// which also disabled its argot encode gate because the allowlist named
		// the requested id rather than the resolved one. Without the alias, asking
		// for 3.6 either gets 3.6 or fails loudly, which is the honest outcome.
		extraAliases: ["gemini-3-flash"],
	};
}

function geminiProFamily(mode: "budget" | "google-level"): EffortVariantFamily {
	const budget = mode === "budget";
	return {
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		// High routes to `gemini-pro-agent` — the upstream `gemini-3.1-pro-high`
		// deployment returns INVALID_ARGUMENT on every streamGenerateContent
		// request (both CCA endpoints) while discovery still lists it;
		// `gemini-pro-agent` is the same model ("Gemini 3.1 Pro (High)", same
		// thinking budget/caps) and accepts the identical request body.
		// `gemini-3.1-pro-high` stays a member so the dead raw id is consumed.
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

/**
 * Gemini 3.6 Flash family (Cloud Code Assist), collapsing per-tier wire IDs
 * (`gemini-3.6-flash-{low,medium,high}`) into a single logical model.
 */
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

/**
 * Gemini 3.x tiered Flash deployment family (e.g. `gemini-3.7-flash-tiered`),
 * routing to a single wire ID using `"google-level"` in-body thinking.
 */
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

/** CCA families shared verbatim by both providers (transport-agnostic, or one transport both endpoints speak). */
const SHARED_CCA_FAMILIES: readonly EffortVariantFamily[] = [
	gemini36FlashFamily(),
	geminiTieredFlashFamily("gemini-3.7-flash", "Gemini 3.7 Flash", "gemini-3.7-flash-tiered"),
	geminiTieredFlashFamily("gemini-3.6-flash-tiered", "Gemini 3.6 Flash Tiered", "gemini-3.6-flash-tiered"),
	{
		// Legacy static family — covers stale snapshots and caches. Stale ids are
		// unverified against the budget-mode CCA contract; keep them on level.
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
		// Rename-only collapse: every effort and off fall back to the wire id.
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B",
		members: ["gpt-oss-120b-medium"],
		routing: {},
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	},
	// Antigravity Cloud Code Assist exposes Claude 4.6 asymmetrically: only the
	// bare `claude-sonnet-4-6` wire id (no `-thinking` twin) and only the
	// `claude-opus-4-6-thinking` wire id (no bare twin). Per-effort thinking is
	// carried in the request body via `thinkingBudget`, so both ids accept on/off
	// requests. Listing both candidates in `members` (priority order) keeps the
	// collapse correct if the backend mix ever rebalances; `retiredMembers`
	// re-points stale collapsed snapshots (bundled catalog rows, cache rows
	// written by prior generations) away from the dead wire id via
	// `reconcileRetiredRouting`.
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

/** `google-antigravity` (daily-cloudcode-pa): Gemini 3.x on the budget transport. */
export const ANTIGRAVITY_VARIANT_COLLAPSE_TABLE: VariantCollapseTable = {
	families: [geminiFlashFamily("budget"), geminiProFamily("budget"), ...SHARED_CCA_FAMILIES],
};

/** `google-gemini-cli` (cloudcode-pa): Gemini 3.x on the level transport (official CLI parity). */
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
		// GLM-5.2 serves an off sibling (`-none`), a high tier (the bare id),
		// and a max tier — an effort axis, not separate SKUs. Lower requested
		// efforts clamp up to `high`.
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
		// Legacy uppercase pair: the underscore token defeats the automatic
		// `X`/`X-thinking` derivation, so collapse it by hand.
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

/**
 * Cursor variant collapse table, mapping reasoning effort tiers to tier-suffixed
 * sibling model IDs required by Cursor's transport.
 */
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

/** Provider id → hand collapse table. The CCA providers diverge on thinking transport. */
export const VARIANT_COLLAPSE_TABLES: Readonly<Record<string, VariantCollapseTable>> = {
	"google-antigravity": ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
	"google-gemini-cli": GEMINI_CLI_VARIANT_COLLAPSE_TABLE,
	devin: DEVIN_VARIANT_COLLAPSE_TABLE,
	cursor: CURSOR_VARIANT_COLLAPSE_TABLE,
};

/**
 * Derive `X` + `X-thinking` variant families automatically for matching pairs
 * in `specs` with identical pricing and APIs.
 */
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
		// Cache fields compare only when BOTH sides report one: a zero cache
		// price on an aggregator means "not told", same as an all-zero row (the
		// openrouter qwen3-max twin ships identical input/output but zero cache
		// fields and must still pair).
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

/**
 * Surface fallback chain: thinking member → bare member → canonical deriver →
 * budget default. `requiresEffort` is dropped from every source: the COLLAPSED
 * pair can disable thinking (off routes to the bare backing id), even though
 * the thinking member alone cannot.
 */
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

/**
 * True when `spec` is the output of collapsing rather than a raw upstream
 * member. `thinking.effortRouting` is written only by collapsing; the
 * `requestModelId` arm is scoped to the provider's hand-table family ids so
 * unrelated carriers (GitHub Copilot `-1m` context variants) never match.
 */
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

/**
 * Re-point stale collapsed specs whose `requestModelId` or routing target retired
 * wire IDs, updating them to active member IDs or falling back to defaults.
 */
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

/**
 * Refresh a collapsed snapshot's thinking surface, budgets, and routing in place
 * from the hand table while preserving the original spec ID.
 */
function refreshCollapsedThinking<TSpec extends VariantSpecLike>(
	spec: TSpec,
	family: EffortVariantFamily,
	retired: ReadonlySet<string> | undefined,
): TSpec {
	// Scope snapshot self-heal to families carrying a curated per-effort budget
	// contract (Antigravity gemini-3.x). Their routing targets are all verified
	// live, so rebuilding routing here is safe; families without `effortBudgets`
	// (derived `X`/`X-thinking` pairs, claude pairs) keep their presence-filtered
	// snapshot routing untouched.
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

/**
 * Collapse every family in `table` found in `specs`. Non-member specs pass
 * through verbatim (by reference), order preserved; the collapsed spec
 * replaces the first occurrence of its family.
 */
export function collapseEffortVariants<TSpec extends VariantSpecLike>(
	specs: readonly TSpec[],
	table: VariantCollapseTable,
): TSpec[] {
	const byId = new Map<string, TSpec>();
	for (const spec of specs) {
		if (!byId.has(spec.id)) byId.set(spec.id, spec);
	}

	/** family id → spec to emit at the family's first occurrence. */
	const replacement = new Map<string, TSpec>();
	/** spec ids that belong to a touched family (members + logical id). */
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
			// Inert (no members) or already collapsed (pass-through). A stale
			// family.id-keyed snapshot is refreshed in place from the current
			// hand-table family (transport/budgets/routing); retired targets drop.
			// Recycled extraAliases rows are healed in a later pass.
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
			// Mixed input: the collapsed entry (live truth) wins; stale raw
			// members are deduped away. Retired targets are re-pointed first.
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

		// A family that routes efforts to a live thinking backing id reasons
		// even when upstream metadata forgot to mark the members.
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
		// The default wire id is the highest-priority live member; omit when it
		// equals the logical id (bare/thinking pairs) — `resolveWireModelId`
		// falls back. Retired members never become the default.
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

	// Refresh stale alias-keyed snapshots in place (recycled bare ids). Runs even
	// when the canonical family.id row is also present, since the exact-id merge
	// keeps the stale alias row alongside the discovered canonical one.
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

	if (replacement.size === 0) return [...specs];

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

/**
 * Collapse a full mixed-provider list: per provider, the hand table (when
 * registered) plus the automatic `X`/`X-thinking` pair rule. Used by the
 * catalog generator; the runtime equivalent lives at the model-manager merge
 * point. Output is regrouped by provider — callers re-sort.
 */
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
		out.push(...result);
	}
	return out;
}

/**
 * Collapse variants for already-built `Model` lists and rebuild models from
 * projected specs to resolve wire defaults.
 */
export function collapseBuiltModelVariants<TApi extends Api>(models: readonly Model<TApi>[]): Model<TApi>[] {
	const collapsed = collapseEffortVariantsAcrossProviders(models);
	const inputRefs = new Set<Model<TApi>>(models);
	return collapsed.map(model =>
		// Rebuild from a projected spec (sparse compatConfig) instead of resolved compat.
		inputRefs.has(model) ? model : buildModel({ ...model, compat: model.compatConfig } as unknown as ModelSpec<TApi>),
	);
}

interface VariantAliasIndex {
	/** lowercased retired id → replacement model id. */
	forward: Map<string, string>;
	/** replacement model id → retired ids that resolve to it. */
	reverse: Map<string, readonly string[]>;
	/** Collapsed logical ids declared by the table. */
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

/**
 * Resolve a retired variant or alias ID to its replacement model ID for `provider`
 * using the hand collapse table. Returns undefined if not a known alias.
 */
export function resolveVariantAlias(provider: Provider, modelId: string): string | undefined {
	const table = VARIANT_COLLAPSE_TABLES[provider] ?? VARIANT_COLLAPSE_TABLES[provider.toLowerCase()];
	if (!table) return undefined;
	return getAliasIndex(table).forward.get(modelId.trim().toLowerCase());
}

/** Bare-id alias hit: replacement id plus the providers declaring it. */
export interface BareVariantAliasHit {
	id: string;
	/** Providers whose table declares the alias — candidates from these win ties. */
	providers: readonly Provider[];
}

/**
 * Provider-agnostic hand-table alias lookup for bare-id selectors. Returns
 * the declaring providers so callers can prefer their models when the
 * replacement id exists on unrelated providers too (e.g. a retired Cursor
 * tier id must not resolve to `openai/gpt-5.4`).
 */
export function resolveBareVariantAlias(modelId: string): BareVariantAliasHit | undefined {
	const normalized = modelId.trim().toLowerCase();
	for (const provider in VARIANT_COLLAPSE_TABLES) {
		const table = VARIANT_COLLAPSE_TABLES[provider] as VariantCollapseTable;
		const hit = getAliasIndex(table).forward.get(normalized);
		if (hit === undefined) continue;
		const providers: Provider[] = [];
		for (const candidate in VARIANT_COLLAPSE_TABLES) {
			// Match by resolved alias target, not table identity: the CCA providers
			// now hold distinct table objects that still share these aliases.
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

/**
 * Reverse alias lookup: the retired ids that resolve to `modelId` for
 * `provider` via the hand table. Used to re-key config keyed by raw member
 * ids (models.yml `modelOverrides`, suppressed selectors) onto the collapsed
 * model. Empty for providers without a table.
 */
export function getVariantAliasSources(provider: Provider, modelId: string): readonly string[] {
	const table = VARIANT_COLLAPSE_TABLES[provider] ?? VARIANT_COLLAPSE_TABLES[provider.toLowerCase()];
	if (!table) return [];
	return getAliasIndex(table).reverse.get(modelId) ?? [];
}

function maxOrNull(values: ReadonlyArray<number | null>): number | null {
	const known = values.filter((v): v is number => v != null);
	return known.length ? Math.max(...known) : null;
}
