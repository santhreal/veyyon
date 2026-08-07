/**
 * Thinking metadata: declared-surface resolution and runtime field reads.
 *
 * The effort ladder a model exposes is EXACTLY the ladder its endpoint
 * declared (models.dev `reasoning_options`, normalized onto
 * `spec.reasoningOptions`) or an explicit hand-authored `spec.thinking`.
 * When neither exists the model carries no `thinking` at all and the picker
 * stays closed — the same contract OpenCode implements in
 * `provider/transform.ts` `reasoningVariants` (undefined options, no
 * variants). Identity-derived ladders were removed on purpose: a guessed
 * ladder offers tiers the endpoint rejects, and it silently lags every
 * upstream release.
 *
 * Resolution (`resolveModelThinking`) runs exactly once per model — from
 * `buildModel` for dynamic specs and from the catalog generator for bundled
 * entries. Identity is still consulted for WIRE facts a declared ladder does
 * not carry: the control mode (budget vs effort vs adaptive), the effort wire
 * map, and mandatory-reasoning floors. Everything below the "runtime helpers"
 * divider reads baked fields only: no id parsing, no host matching, no compat
 * detection per request.
 */
import { canonicalizeEfforts, Effort, THINKING_EFFORTS } from "./effort";
import { modelMatchesHost } from "./hosts";
import {
	bareModelId,
	isAnthropicAdaptiveGenAtLeast,
	type ParsedModel,
	parseKnownModel,
	semverGte,
} from "./identity/classify";
import {
	findThinkingVariantToken,
	isGlm52ReasoningEffortModelId,
	isMimoModelIdOrName,
	isMinimaxM2FamilyModelId,
	isMinimaxM3FamilyModelId,
	supportsAdaptiveThinkingDisplay,
} from "./identity/family";
import type {
	Api,
	CompatOf,
	Model,
	ModelSpec,
	ResolvedCursorCompat,
	ResolvedDevinCompat,
	ResolvedOpenAICompat,
	ResolvedOpenAIResponsesCompat,
	ThinkingConfig,
} from "./types";

/**
 * Runtime helpers read baked metadata only, so they accept both pre-build
 * specs and built models.
 */
type ApiModel<TApi extends Api = Api> = ModelSpec<TApi> | Model<TApi>;

type EffortMap = Partial<Record<Effort, string>>;

const GROQ_QWEN3_32B_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "default",
	[Effort.Low]: "default",
	[Effort.Medium]: "default",
	[Effort.High]: "default",
	[Effort.XHigh]: "default",
};
const FIREWORKS_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "none",
};
const MIMO_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "low",
	[Effort.XHigh]: "high",
};

const MINIMAX_ANTHROPIC_ADAPTIVE_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Low]: "adaptive",
	[Effort.Medium]: "adaptive",
	[Effort.High]: "adaptive",
};

// ---------------------------------------------------------------------------
// Build-time derivation (buildModel + catalog generator only)
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical thinking metadata for a spec. Called exactly once per
 * model by `buildModel`, after compat resolution.
 *
 * - Non-reasoning models never carry thinking.
 * - Models that reason natively but reject the wire effort param
 *   (`compat.supportsReasoningEffort: false` on openai-responses*) carry no
 *   thinking either: `reasoning: true, thinking: undefined` IS the encoding
 *   for "thinks, but exposes no control surface".
 * - The models.dev-declared surface (`reasoningOptions`) owns the ladder when
 *   present; an explicit `spec.thinking` owns it otherwise. The wire facts
 *   (`effortMap`, `supportsDisplay`, mandatory-reasoning floors) are
 *   backfilled around the declared ladder, never in place of it.
 * - A spec with no declared surface gets NO thinking config. There is no
 *   identity inference: guessing a ladder from the model id is how the picker
 *   used to offer tiers the endpoint rejects.
 */
/**
 * Ollama declares its effort vocabulary server-wide, not per model:
 * `reasoning.effort` accepts low|medium|high|max (plus `none` to disable) for
 * every thinking model on both the local daemon and Ollama Cloud. models.dev
 * cannot catalog a local daemon, so this host fact is declared at discovery
 * time; stale cache rows from the remap era still carry minimal/xhigh and get
 * normalized back to the wire vocabulary in fillThinkingWireDefaults.
 */
export const OLLAMA_WIRE_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.Max];

const OLLAMA_CLOUD_GLM_52_WIRE_EFFORTS: readonly Effort[] = [Effort.High, Effort.Max];

/** Efforts a budget transport's token schedule addresses distinctly. */
const BUDGET_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const ANTHROPIC_BUDGET_EFFORTS: readonly Effort[] = [...BUDGET_EFFORTS, Effort.XHigh];

/** Google's published `thinkingLevel` vocabulary: Pro takes two levels, the rest four. */
const GEMINI_LEVEL_EFFORTS_PRO: readonly Effort[] = [Effort.Low, Effort.High];
const GEMINI_LEVEL_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];

function normalizeOllamaWireEfforts<TApi extends Api>(
	spec: ModelSpec<TApi>,
	efforts: readonly Effort[],
): readonly Effort[] {
	if (spec.provider !== "ollama" && spec.provider !== "ollama-cloud") return efforts;
	// Ollama Cloud's GLM-5.2 endpoint 400s on every level except high/max.
	if (spec.provider === "ollama-cloud" && isGlm52ReasoningEffortModelId(spec.id)) {
		return OLLAMA_CLOUD_GLM_52_WIRE_EFFORTS;
	}
	if (efforts.includes(Effort.Minimal) || efforts.includes(Effort.XHigh)) {
		return OLLAMA_WIRE_EFFORTS;
	}
	return efforts;
}

export function resolveModelThinking<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): ThinkingConfig | undefined {
	if (!spec.reasoning) return undefined;
	if (omitsWireReasoningEffort(spec.api, compat)) return undefined;
	// A routed row's surface is owned by its collapse table: the per-effort
	// wire ids ARE the control, and neither discovery nor identity may
	// re-derive them.
	if (spec.thinking?.effortRouting !== undefined) {
		return fillThinkingWireDefaults(spec, compat, spec.thinking);
	}
	// Discovery-declared reasoning surfaces (models.dev `reasoning_options`)
	// win over every derived or previously baked ladder: the endpoint stated
	// which efforts it accepts. `noEffortControl` (empty options, or a binary
	// toggle with no levels) means the model reasons but exposes no control,
	// the same encoding as `reasoning: true, thinking: undefined`.
	if (spec.reasoningOptions !== undefined) {
		if (spec.reasoningOptions.noEffortControl === true) return undefined;
		const discovered = spec.reasoningOptions.efforts;
		if (discovered !== undefined && discovered.length > 0) {
			return thinkingConfigFromEfforts(
				spec,
				compat,
				inferThinkingControlMode(spec, parseKnownModel(spec.id)),
				canonicalizeEfforts(discovered),
			);
		}
	}
	if (spec.thinking && Array.isArray(spec.thinking.efforts) && spec.thinking.efforts.length > 0) {
		return fillThinkingWireDefaults(spec, compat, spec.thinking);
	}
	// Cascade/Cursor select effort only by routing to a sibling model id, so a
	// model on those transports with no explicit routed thinking has no
	// controllable surface: never fabricate an effort ladder from identity.
	if ((compat as ResolvedDevinCompat | ResolvedCursorCompat | undefined)?.trustExplicitThinkingOnly === true) {
		return undefined;
	}
	// Ollama declares its effort vocabulary host-wide (see OLLAMA_WIRE_EFFORTS)
	// and models.dev cannot catalog a local daemon, so bare ollama specs — stale
	// cache rows from before discovery declared the ladder — still get the host
	// vocabulary. This is a host fact, not per-model identity derivation.
	if (spec.reasoning === true && (spec.provider === "ollama" || spec.provider === "ollama-cloud")) {
		return thinkingConfigFromEfforts(
			spec,
			compat,
			inferThinkingControlMode(spec, parseKnownModel(spec.id)),
			normalizeOllamaWireEfforts(spec, OLLAMA_WIRE_EFFORTS),
		);
	}
	// Nothing declared. A transport whose thinking control is NOT an
	// endpoint-validated effort name still has a ladder, because the ladder is
	// ours: see clientComputedLadder. Everything else offers no surface —
	// fabricating an effort enum from the model id is how the picker used to
	// offer tiers the endpoint rejects.
	const fallback = clientComputedSurface(spec, parseKnownModel(spec.id));
	if (fallback !== undefined) {
		return thinkingConfigFromEfforts(spec, compat, fallback.mode, fallback.efforts);
	}
	return undefined;
}

/**
 * The ladder for a transport that does not validate an effort NAME.
 *
 * The declared-surface rule exists because an invented `reasoning_effort`
 * value gets a 400 from the endpoint. Two control modes carry no such risk and
 * therefore keep their ladders when no catalogue declares one:
 *
 * - `budget`: the wire carries `thinking.budget_tokens` / `thinkingBudget`, a
 *   NUMBER that Veyyon computes from its own per-effort schedule (`@veyyon/ai`
 *   `reasoning-budget.ts`). models.dev states exactly this by declaring
 *   `budget_tokens` with a token range and no values. The ladder is the set of
 *   efforts that schedule addresses distinctly, so every tier changes the
 *   request; a shorter ladder does not protect anyone, it just resolves the
 *   operator's `low` upward into a more expensive budget.
 * - `google-level`: the wire carries Google's `thinkingLevel` enum, which
 *   Google publishes per family (LOW/HIGH for Gemini 3 Pro,
 *   MINIMAL/LOW/MEDIUM/HIGH for the Flash line). No catalogue covers Cloud
 *   Code Assist at all, so a declaration will never arrive for the first-party
 *   Gemini CLI and Antigravity transports; without this they lose thinking
 *   control entirely.
 *
 * Effort-enum transports (`effort`, `anthropic-budget-effort`,
 * `anthropic-adaptive`) are deliberately absent: those send a level name the
 * endpoint checks, so an undeclared ladder there is the guess the declared
 * surface rule was written to stop. MiniMax on the Anthropic endpoint is the
 * one adaptive exception, below, because it sends no name at all.
 */
function clientComputedSurface<TApi extends Api>(
	spec: ModelSpec<TApi>,
	parsed: ParsedModel,
): { mode: ThinkingConfig["mode"]; efforts: readonly Effort[] } | undefined {
	const mode = inferThinkingControlMode(spec, parsed);
	switch (mode) {
		case "budget":
			return { mode, efforts: budgetLadder(spec) };
		// `output_config.effort` rides ALONGSIDE `thinking.budget_tokens` here, so
		// an undeclared row still has a working control: drop the unverified enum
		// and keep the budget. Sending an effort a model rejects is #3497's HTTP
		// 400 ("This model does not support the effort parameter"), so this is
		// both safer than guessing the enum and better than offering nothing.
		case "anthropic-budget-effort":
			return { mode: "budget", efforts: budgetLadder(spec) };
		case "google-level":
			return {
				mode,
				efforts:
					parsed.family === "gemini" && parsed.kind === "pro" ? GEMINI_LEVEL_EFFORTS_PRO : GEMINI_LEVEL_EFFORTS,
			};
		// MiniMax collapses every tier to the single literal `adaptive`
		// (MINIMAX_ANTHROPIC_ADAPTIVE_EFFORT_MAP), so no effort NAME reaches the
		// endpoint and there is nothing for it to reject. The tiers still differ
		// in what Veyyon does locally, so keeping them costs nothing and dropping
		// them would take the dial away from a model that has one.
		case "anthropic-adaptive":
			return isMinimaxReasoningModelOnAnthropicEndpoint(spec)
				? { mode, efforts: Object.keys(MINIMAX_ANTHROPIC_ADAPTIVE_EFFORT_MAP) as Effort[] }
				: undefined;
		default:
			return undefined;
	}
}

/**
 * Anthropic's schedule gives xhigh its own 32k budget; Google's and Bedrock's
 * top out at high, so a fifth tier there would just repeat bytes.
 */
function budgetLadder<TApi extends Api>(spec: ModelSpec<TApi>): readonly Effort[] {
	return spec.api === "anthropic-messages" ? ANTHROPIC_BUDGET_EFFORTS : BUDGET_EFFORTS;
}

/**
 * Backfill wire facts onto declared thinking metadata. The declared ladder
 * always stands; only the wire encoding around it (`effortMap`,
 * `supportsDisplay`, `requiresEffort`) is derived, and only when not
 * explicitly set.
 */
function fillThinkingWireDefaults<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	thinking: ThinkingConfig,
): ThinkingConfig {
	const parsed = parseKnownModel(spec.id);
	// Canonicalize the ladder so a hand-authored `thinking.efforts` that violates
	// the documented least->most order (or carries duplicates) still bakes into a
	// canonical ladder; identity-derived ladders are already canonical, so this is
	// a no-op for them. Without it, an out-of-order user ladder reaches the clamp
	// helpers, which walk it in array order and pick the wrong effort.
	const normalizedEfforts = normalizeOllamaWireEfforts(spec, canonicalizeEfforts(thinking.efforts));
	const effortsChanged = !sameEffortList(normalizedEfforts, thinking.efforts);
	const effortMap =
		thinking.effortMap === undefined || effortsChanged
			? inferEffortMap(spec, compat, thinking.mode, normalizedEfforts)
			: undefined;
	const shouldReplaceEffortMap = thinking.effortMap === undefined ? effortMap !== undefined : effortsChanged;
	const needsDisplay =
		thinking.supportsDisplay === undefined &&
		(spec.api === "anthropic-messages" || spec.api === "bedrock-converse-stream") &&
		supportsAdaptiveThinkingDisplay(spec.id);
	const needsRequiresEffort = thinking.requiresEffort === undefined && impliesMandatoryReasoning(parsed, spec.id);
	if (!effortsChanged && !shouldReplaceEffortMap && !needsDisplay && !needsRequiresEffort) {
		return thinking;
	}
	const filled: ThinkingConfig = { ...thinking };
	if (effortsChanged) {
		filled.efforts = normalizedEfforts;
	}
	if (shouldReplaceEffortMap) {
		if (effortMap === undefined) {
			delete filled.effortMap;
		} else {
			filled.effortMap = effortMap;
		}
	}
	if (needsDisplay) {
		filled.supportsDisplay = true;
	}
	if (needsRequiresEffort) {
		filled.requiresEffort = true;
	}
	return filled;
}

/**
 * Assemble the thinking config around a declared ladder: the control mode and
 * every wire fact (effort map, adaptive display, mandatory reasoning) derive
 * from identity + compat, so any declared ladder bakes into the same shape.
 */
function thinkingConfigFromEfforts<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	mode: ThinkingConfig["mode"],
	efforts: readonly Effort[],
): ThinkingConfig {
	const parsed = parseKnownModel(spec.id);
	const config: ThinkingConfig = { mode, efforts };
	const effortMap = inferEffortMap(spec, compat, config.mode, config.efforts);
	if (effortMap !== undefined) {
		config.effortMap = effortMap;
	}
	if (
		(spec.api === "anthropic-messages" || spec.api === "bedrock-converse-stream") &&
		supportsAdaptiveThinkingDisplay(spec.id)
	) {
		config.supportsDisplay = true;
	}
	if (impliesMandatoryReasoning(parsed, spec.id)) {
		config.requiresEffort = true;
	}
	return config;
}

/**
 * True when the model reasons natively but rejects the wire `reasoning.effort`
 * param. Scoped to openai-responses* because that's the only API surface where
 * `compat.supportsReasoningEffort: false` means "omit the field entirely"
 * (xAI Grok off the `isGrokReasoningEffortCapable` allowlist: grok-build,
 * grok-4.20-0309-reasoning). openai-completions keeps its thinking config even
 * without effort support — binary thinking formats (zai/qwen) drive reasoning
 * through other request fields.
 */
function omitsWireReasoningEffort(api: Api, compat: CompatOf<Api>): boolean {
	if (api !== "openai-responses" && api !== "openai-codex-responses" && api !== "azure-openai-responses") {
		return false;
	}
	return (compat as ResolvedOpenAIResponsesCompat | undefined)?.supportsReasoningEffort === false;
}

function inferEffortMap<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	mode: ThinkingConfig["mode"],
	efforts: readonly Effort[],
): EffortMap | undefined {
	const detected = inferDetectedEffortMap(spec, compat, mode);
	const configured = readCompatEffortMap(compat);
	const merged =
		detected === undefined ? configured : configured === undefined ? detected : { ...detected, ...configured };
	return merged === undefined ? undefined : filterEffortMapToSupportedEfforts(merged, efforts);
}

function filterEffortMapToSupportedEfforts(map: EffortMap, efforts: readonly Effort[]): EffortMap | undefined {
	let filtered: EffortMap | undefined;
	for (const effort of efforts) {
		const mapped = map[effort];
		if (mapped === undefined) continue;
		if (filtered === undefined) filtered = {};
		filtered[effort] = mapped;
	}
	return filtered;
}

function sameEffortList(left: readonly Effort[], right: readonly Effort[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function isOpenAICompatReasoningApi(api: Api): boolean {
	return api === "openai-completions" || api === "openrouter";
}

function isAnthropicMessagesGlm52ReasoningEffortModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return (
		spec.api === "anthropic-messages" &&
		(spec.provider === "umans" || spec.provider === "zai") &&
		isGlm52ReasoningEffortModelId(spec.id)
	);
}

function isMinimaxReasoningModelOnAnthropicEndpoint<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return spec.api === "anthropic-messages" && (isMinimaxM2FamilyModelId(spec.id) || isMinimaxM3FamilyModelId(spec.id));
}

function isOpenAICompatMimoReasoningEffortModel<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): boolean {
	if (!isOpenAICompatReasoningApi(spec.api)) return false;
	if (!isMimoModelIdOrName(spec.id) && !isMimoModelIdOrName(spec.name ?? "")) return false;
	const resolved = compat as ResolvedOpenAICompat | undefined;
	return (
		(resolved?.thinkingFormat === "openai" || resolved?.thinkingFormat === "openrouter") &&
		resolved.supportsReasoningEffort
	);
}

function readCompatEffortMap(compat: unknown): EffortMap | undefined {
	if (typeof compat !== "object" || compat === null || !("reasoningEffortMap" in compat)) {
		return undefined;
	}
	const map = (compat as { reasoningEffortMap?: EffortMap }).reasoningEffortMap;
	return map && Object.keys(map).length > 0 ? map : undefined;
}

function inferDetectedEffortMap<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	mode: ThinkingConfig["mode"],
): EffortMap | undefined {
	if (mode === "anthropic-adaptive") {
		if (isMinimaxReasoningModelOnAnthropicEndpoint(spec)) {
			return MINIMAX_ANTHROPIC_ADAPTIVE_EFFORT_MAP;
		}
		// Adaptive effort ladders are wire-exact (see
		// getAnthropicAdaptiveEfforts) — no mapping needed.
		return undefined;
	}
	if (!isOpenAICompatReasoningApi(spec.api)) {
		return undefined;
	}
	if (spec.provider === "groq" && spec.id === "qwen/qwen3-32b") {
		return GROQ_QWEN3_32B_REASONING_EFFORT_MAP;
	}
	if (isOpenAICompatMimoReasoningEffortModel(spec, compat)) {
		return MIMO_REASONING_EFFORT_MAP;
	}
	// Host quirk: Fireworks rejects `minimal` (maps to `none`) on ladders
	// that genuinely include it. Filtered to supported efforts later.
	if (modelMatchesHost(spec, "fireworks")) {
		return FIREWORKS_REASONING_EFFORT_MAP;
	}
	return undefined;
}

const OPENAI_O_SERIES_RE = /^o[134](?:$|[-:.])/i;

/**
 * Reasoning-only upstreams reject disabled or omitted thinking ("Reasoning is
 * mandatory for this endpoint and cannot be disabled") — the floor is the
 * lowest effort, never off:
 * - Gemini 3.x exposes levels only; Gemini 2.5 Pro floors thinkingBudget at
 *   128 and rejects 0 (2.5 Flash/Flash-Lite keep the off switch).
 * - OpenAI o-series and MiniMax M2 are reasoning-first architectures.
 * - Thinking-variant SKUs (`*-thinking`, `*-reasoner`, `*-reasoning`) ARE the
 *   thinking checkpoint; live bare twins pair-collapse away
 *   (variant-collapse) and the collapsed entry owns off — this floor protects
 *   the orphans.
 */
function impliesMandatoryReasoning(parsed: ParsedModel, modelId: string): boolean {
	if (parsed.family === "gemini") {
		if (semverGte(parsed.version, "3.0")) return true;
		if (parsed.kind === "pro" && semverGte(parsed.version, "2.5")) return true;
	}
	if (isMinimaxM2FamilyModelId(modelId)) return true;
	if (OPENAI_O_SERIES_RE.test(bareModelId(modelId))) return true;
	return findThinkingVariantToken(modelId) !== undefined;
}

function inferThinkingControlMode<TApi extends Api>(
	spec: ModelSpec<TApi>,
	parsedModel: ParsedModel,
): ThinkingConfig["mode"] {
	switch (spec.api) {
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
			return parsedModel.family === "gemini" &&
				semverGte(parsedModel.version, "3.0") &&
				parsedModel.version.major === 3
				? "google-level"
				: "budget";

		case "anthropic-messages":
			if (isMinimaxReasoningModelOnAnthropicEndpoint(spec)) {
				return "anthropic-adaptive";
			}
			if (isAnthropicMessagesGlm52ReasoningEffortModel(spec)) {
				return "anthropic-budget-effort";
			}
			if (parsedModel.family === "anthropic") {
				if (semverGte(parsedModel.version, "4.6")) {
					return "anthropic-adaptive";
				}
				// Opus 4.5 supports `output_config.effort` (sent alongside
				// `thinking.budget_tokens`); Sonnet 4.5 and Haiku 4.5 reject the
				// field with HTTP 400 "This model does not support the effort
				// parameter." (#3497).
				if (parsedModel.kind === "opus" && semverGte(parsedModel.version, "4.5")) {
					return "anthropic-budget-effort";
				}
			}
			return "budget";

		case "bedrock-converse-stream":
			if (parsedModel.family === "anthropic") {
				if (isAnthropicAdaptiveGenAtLeast(parsedModel, "4.6")) {
					return "anthropic-adaptive";
				}
				// Opus 4.5 on Bedrock metadata mirrors the direct-Anthropic
				// shape; the Bedrock provider still emits plain budget thinking
				// on the wire for the budget-effort mode.
				if (parsedModel.kind === "opus" && semverGte(parsedModel.version, "4.5")) {
					return "anthropic-budget-effort";
				}
			}
			return "budget";

		default:
			return "effort";
	}
}

// ---------------------------------------------------------------------------
// Runtime helpers (field reads only — safe per request)
// ---------------------------------------------------------------------------

/**
 * Returns the supported thinking efforts declared on the model metadata.
 * Empty for non-reasoning models and for reasoning models without a
 * controllable effort surface (`thinking: undefined`).
 */
export function getSupportedEfforts<TApi extends Api>(model: ApiModel<TApi>): readonly Effort[] {
	if (!model.reasoning) {
		return [];
	}
	return model.thinking?.efforts ?? [];
}

/**
 * Clamps a requested thinking level against explicit model metadata.
 *
 * Non-reasoning models always resolve to `undefined`.
 */
export function clampThinkingLevelForModel<TApi extends Api>(
	model: ApiModel<TApi> | undefined,
	requested: Effort | undefined,
): Effort | undefined {
	if (!model) {
		return requested;
	}
	if (!model.reasoning || requested === undefined) {
		return undefined;
	}

	const levels = getSupportedEfforts(model);
	if (levels.includes(requested)) {
		return requested;
	}

	const requestedIndex = THINKING_EFFORTS.indexOf(requested);
	if (requestedIndex === -1) {
		return undefined;
	}

	let clamped: Effort | undefined;
	for (const effort of levels) {
		if (THINKING_EFFORTS.indexOf(effort) > requestedIndex) {
			break;
		}
		clamped = effort;
	}

	return clamped ?? levels[0];
}

export function requireSupportedEffort<TApi extends Api>(model: ApiModel<TApi>, effort: Effort): Effort {
	if (!model.reasoning) {
		throw new Error(`Model ${model.provider}/${model.id} does not support thinking`);
	}
	const levels = getSupportedEfforts(model);
	if (!levels.includes(effort)) {
		if (levels.length === 0) {
			// Distinct message for the no-effort-surface case: the old text ended
			// "Supported efforts: " with an empty list, which reads as truncated
			// and gives the operator no way forward.
			throw new Error(
				`Thinking effort ${effort} is not supported by ${model.provider}/${model.id}: the model exposes no controllable thinking efforts. Send no effort (the model manages reasoning internally) or turn thinking off.`,
			);
		}
		throw new Error(
			`Thinking effort ${effort} is not supported by ${model.provider}/${model.id}. Supported efforts: ${levels.join(", ")}`,
		);
	}
	return effort;
}

/** Maps a normalized thinking effort to Google's `thinkingLevel` enum values. */
export function mapEffortToGoogleThinkingLevel(effort: Effort): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
	switch (effort) {
		case Effort.Minimal:
			return "MINIMAL";
		case Effort.Low:
			return "LOW";
		case Effort.Medium:
			return "MEDIUM";
		case Effort.High:
		case Effort.XHigh:
		case Effort.Max:
			return "HIGH";
	}
}

/**
 * Maps a normalized thinking effort to Anthropic adaptive effort values via
 * the model's baked `thinking.effortMap` (identity for unmapped efforts).
 */
export function mapEffortToAnthropicAdaptiveEffort<TApi extends Api>(
	model: ApiModel<TApi>,
	effort: Effort,
): "low" | "medium" | "high" | "xhigh" | "max" | "adaptive" {
	const supported = requireSupportedEffort(model, effort);
	return (model.thinking?.effortMap?.[supported] ?? supported) as
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max"
		| "adaptive";
}

/**
 * Resolves the upstream wire model id for a request at the given effort
 * (`undefined` = thinking off). Collapsed effort-tier variants route through
 * `thinking.effortRouting`; everything else falls back to
 * `requestModelId ?? id`.
 */
export function resolveWireModelId<TApi extends Api>(model: ApiModel<TApi>, effort: Effort | undefined): string {
	return model.thinking?.effortRouting?.[effort ?? "off"] ?? model.requestModelId ?? model.id;
}

/**
 * Lowest supported effort in canonical order — the clamp target for
 * thinking-off requests on `thinking.requiresEffort` models.
 */
export function minimumSupportedEffort<TApi extends Api>(model: ApiModel<TApi>): Effort | undefined {
	const efforts = model.thinking?.efforts;
	if (!efforts || efforts.length === 0) return undefined;
	// Canonical order regardless of how the ladder was authored: the lowest
	// supported effort is the first entry of the canonicalized ladder.
	return canonicalizeEfforts(efforts)[0];
}

/** Canonical reasoning state after applying user intent to one model capability. */
export type ReasoningSelectionState = "unsupported" | "uncontrolled" | "disabled" | "enabled";

/**
 * Provider-neutral request plan. `effort` is the supported canonical level,
 * `wireEffort` is the model's baked provider value, and `wireModelId` covers
 * providers that expose effort as separate model SKUs.
 */
export interface ReasoningSelection {
	state: ReasoningSelectionState;
	effort: Effort | undefined;
	wireEffort: string | undefined;
	wireModelId: string;
	mode: ThinkingConfig["mode"] | undefined;
	forcedByModel: boolean;
	enabled: boolean;
}

export interface ReasoningSelectionIntent {
	effort?: Effort;
	disabled?: boolean;
}

function resolveSelectedEffort<TApi extends Api>(model: ApiModel<TApi>, requested: Effort): Effort {
	const thinking = model.thinking;
	if (thinking?.efforts.includes(requested)) return requested;
	const compatMapped = readCompatEffortMap(model.compat)?.[requested];
	if (
		compatMapped !== undefined &&
		THINKING_EFFORTS.includes(compatMapped as Effort) &&
		thinking?.efforts.includes(compatMapped as Effort)
	) {
		return compatMapped as Effort;
	}
	const mapped = thinking?.effortMap?.[requested];
	if (
		mapped !== undefined &&
		THINKING_EFFORTS.includes(mapped as Effort) &&
		thinking?.efforts.includes(mapped as Effort)
	) {
		return mapped as Effort;
	}
	if (mapped !== undefined) return requested;
	return requireSupportedEffort(model, requested);
}

/**
 * Resolve reasoning once before provider serialization.
 *
 * `effort` and “thinking level” are the same user intent. Provider-specific
 * controls (enum, token budget, adaptive output effort, or a routed model id)
 * are facts on the returned plan, not separate settings.
 */
export function resolveReasoningSelection<TApi extends Api>(
	model: ApiModel<TApi>,
	intent: ReasoningSelectionIntent = {},
): ReasoningSelection {
	const fallbackWireModelId = model.requestModelId ?? model.id;
	if (!model.reasoning) {
		return {
			state: "unsupported",
			effort: undefined,
			wireEffort: undefined,
			wireModelId: fallbackWireModelId,
			mode: undefined,
			forcedByModel: false,
			enabled: false,
		};
	}
	const thinking = model.thinking;
	if (!thinking) {
		return {
			state: intent.disabled ? "disabled" : "uncontrolled",
			effort: undefined,
			wireEffort: undefined,
			wireModelId: resolveWireModelId(model, undefined),
			mode: undefined,
			forcedByModel: false,
			enabled: false,
		};
	}
	if (intent.disabled || intent.effort === undefined) {
		if (thinking.requiresEffort && !thinking.suppressWhenOff) {
			const floor = minimumSupportedEffort(model);
			if (floor === undefined) {
				throw new Error(`Model ${model.provider}/${model.id} requires thinking but declares no supported effort`);
			}
			return {
				state: "enabled",
				effort: floor,
				wireEffort: thinking.effortMap?.[floor] ?? floor,
				wireModelId: resolveWireModelId(model, floor),
				mode: thinking.mode,
				forcedByModel: true,
				enabled: true,
			};
		}
		return {
			state: "disabled",
			effort: undefined,
			wireEffort: undefined,
			wireModelId: resolveWireModelId(model, undefined),
			mode: thinking.mode,
			forcedByModel: false,
			enabled: false,
		};
	}
	const effort = resolveSelectedEffort(model, intent.effort);
	return {
		state: "enabled",
		effort,
		wireEffort: readCompatEffortMap(model.compat)?.[intent.effort] ?? thinking.effortMap?.[effort] ?? effort,
		wireModelId: resolveWireModelId(model, effort),
		mode: thinking.mode,
		forcedByModel: false,
		enabled: true,
	};
}
