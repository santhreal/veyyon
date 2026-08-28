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

export const OLLAMA_WIRE_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.Max];

const OLLAMA_CLOUD_GLM_52_WIRE_EFFORTS: readonly Effort[] = [Effort.High, Effort.Max];

function normalizeOllamaWireEfforts<TApi extends Api>(
	spec: ModelSpec<TApi>,
	efforts: readonly Effort[],
): readonly Effort[] {
	if (spec.provider !== "ollama" && spec.provider !== "ollama-cloud") return efforts;
	if (spec.provider === "ollama-cloud" && isGlm52ReasoningEffortModelId(spec.id)) {
		return OLLAMA_CLOUD_GLM_52_WIRE_EFFORTS;
	}
	if (efforts.includes(Effort.Minimal) || efforts.includes(Effort.XHigh)) {
		return OLLAMA_WIRE_EFFORTS;
	}
	return efforts;
}

const BUDGET_CONTROL_EFFORTS: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
];

export function resolveModelThinking<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): ThinkingConfig | undefined {
	if (!spec.reasoning) return undefined;
	if (omitsWireReasoningEffort(spec.api, compat)) return undefined;
	if (spec.thinking?.effortRouting !== undefined) {
		return fillThinkingWireDefaults(spec, compat, spec.thinking);
	}
	if (spec.reasoningOptions !== undefined) {
		if (spec.reasoningOptions.noEffortControl === true) return undefined;
		const discovered = spec.reasoningOptions.efforts;
		if (discovered !== undefined && discovered.length > 0) {
			return thinkingConfigFromEfforts(
				spec,
				compat,
				normalizeOllamaWireEfforts(spec, canonicalizeEfforts(discovered)),
			);
		}
	}
	if (spec.thinking && Array.isArray(spec.thinking.efforts) && spec.thinking.efforts.length > 0) {
		return fillThinkingWireDefaults(spec, compat, spec.thinking);
	}
	if ((compat as ResolvedDevinCompat | ResolvedCursorCompat | undefined)?.trustExplicitThinkingOnly === true) {
		return undefined;
	}
	if (inferThinkingControlMode(spec, parseKnownModel(spec.id)) === "budget") {
		return thinkingConfigFromEfforts(spec, compat, BUDGET_CONTROL_EFFORTS);
	}
	if (spec.reasoning === true && (spec.provider === "ollama" || spec.provider === "ollama-cloud")) {
		return thinkingConfigFromEfforts(spec, compat, normalizeOllamaWireEfforts(spec, OLLAMA_WIRE_EFFORTS));
	}
	return undefined;
}

function fillThinkingWireDefaults<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	thinking: ThinkingConfig,
): ThinkingConfig {
	const parsed = parseKnownModel(spec.id);
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

function thinkingConfigFromEfforts<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	efforts: readonly Effort[],
): ThinkingConfig {
	const parsed = parseKnownModel(spec.id);
	const config: ThinkingConfig = {
		mode: inferThinkingControlMode(spec, parsed),
		efforts,
	};
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
	if (modelMatchesHost(spec, "fireworks")) {
		return FIREWORKS_REASONING_EFFORT_MAP;
	}
	return undefined;
}

const OPENAI_O_SERIES_RE = /^o[134](?:$|[-:.])/i;

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
				if (parsedModel.kind === "opus" && semverGte(parsedModel.version, "4.5")) {
					return "anthropic-budget-effort";
				}
			}
			return "budget";

		default:
			return "effort";
	}
}

export function getSupportedEfforts<TApi extends Api>(model: ApiModel<TApi>): readonly Effort[] {
	if (!model.reasoning) {
		return [];
	}
	return model.thinking?.efforts ?? [];
}

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

export function resolveWireModelId<TApi extends Api>(model: ApiModel<TApi>, effort: Effort | undefined): string {
	return model.thinking?.effortRouting?.[effort ?? "off"] ?? model.requestModelId ?? model.id;
}

export function minimumSupportedEffort<TApi extends Api>(model: ApiModel<TApi>): Effort | undefined {
	const efforts = model.thinking?.efforts;
	if (!efforts || efforts.length === 0) return undefined;
	return canonicalizeEfforts(efforts)[0];
}

export type ReasoningSelectionState = "unsupported" | "uncontrolled" | "disabled" | "enabled";

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
