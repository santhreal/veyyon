/**
 * Baseten's Model APIs are one endpoint with per-route reasoning behaviour, so
 * neither "does this model reason" nor "which depths does it accept" can be
 * derived from the model's identity: the route decides, and Baseten publishes
 * the answer per route.
 *
 * Two pages, each authoritative for a different fact:
 *
 * - https://docs.baseten.co/inference/model-apis/overview carries the model
 *   matrix, which says whether a route reasons and whether reasoning is on by
 *   default or opt-in.
 * - https://docs.baseten.co/inference/model-apis/reasoning carries the
 *   "Control reasoning depth" table, which says whether `reasoning_effort`
 *   does anything and which values it accepts.
 *
 * They do not agree on membership, so neither one alone is enough:
 * `DeepSeek-V4-Flash-0731` is in the matrix as "Enabled by default" and absent
 * from the depth table, meaning it reasons with no addressable depth. That is
 * why `efforts` is optional here rather than defaulted to a ladder.
 *
 * A route missing from this table entirely is absent from Baseten's matrix and
 * does not reason. A route present with no `efforts` reasons but accepts
 * `reasoning_effort` and ignores it, which the reasoning page warns about
 * outright ("a successful request doesn't mean `reasoning_effort` took
 * effect"), so offering a ladder there would sell the operator a control that
 * does nothing.
 *
 * `none` is deliberately absent from every ladder. It is the thinking-off
 * state, not a depth tier, and Veyyon spells that as `Effort.Off` on the
 * ladder that `canonicalizeEfforts` owns.
 */
import { Effort } from "../effort";

/** How one Baseten route reasons, and which depths it accepts. */
export interface BasetenRouteReasoning {
	/**
	 * Whether Veyyon can make this route reason at all. False for the routes
	 * Baseten's matrix marks "Opt-in", which reason only when the request
	 * carries `chat_template_args: { enable_thinking: true }`. Veyyon has no
	 * encoding for that field (`thinkingFormat` covers top-level
	 * `enable_thinking` and `chat_template_kwargs`, both a different parameter),
	 * so advertising those routes as reasoning would offer a control that
	 * cannot be switched on. GLM 5.2 is marked "Opt-in" too and is still true
	 * here: its template reads `reasoning_effort` in both placements, so a
	 * depth alone engages it.
	 */
	readonly reasons: boolean;
	/**
	 * The accepted `reasoning_effort` depths, or `undefined` when the route
	 * reasons but ignores the parameter.
	 */
	readonly efforts?: readonly Effort[];
}

/** Routes accepting Baseten's full depth scale (`minimal` through `max`). */
const BASETEN_FULL_EFFORTS: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

/** GLM 5.2 and GLM 5.2 Fast: `400` for any depth outside `high`/`max`. */
const BASETEN_GLM_52_EFFORTS: readonly Effort[] = [Effort.High, Effort.Max];

/** Kimi K3: three depths, no `minimal`, `medium`, or `xhigh`. */
const BASETEN_KIMI_K3_EFFORTS: readonly Effort[] = [Effort.Low, Effort.High, Effort.Max];

/**
 * Keyed by lowercased model id: the routes are HuggingFace repo names, and how
 * a host spells them is not a fact about the model.
 */
const BASETEN_ROUTE_REASONING: Readonly<Record<string, BasetenRouteReasoning>> = {
	"deepseek-ai/deepseek-v4-flash-0731": { reasons: true },
	"deepseek-ai/deepseek-v4-pro": { reasons: true, efforts: BASETEN_FULL_EFFORTS },
	"moonshotai/kimi-k2.6": { reasons: false },
	"moonshotai/kimi-k2.7-code": { reasons: false },
	"moonshotai/kimi-k3": { reasons: true, efforts: BASETEN_KIMI_K3_EFFORTS },
	"nvidia/nvidia-nemotron-3-ultra-550b-a55b": { reasons: false },
	"openai/gpt-oss-120b": { reasons: true, efforts: BASETEN_FULL_EFFORTS },
	"thinkingmachines/inkling": { reasons: true, efforts: BASETEN_FULL_EFFORTS },
	"thinkingmachines/inkling-small": { reasons: true, efforts: BASETEN_FULL_EFFORTS },
	"zai-org/glm-4.7": { reasons: false },
	"zai-org/glm-5.2": { reasons: true, efforts: BASETEN_GLM_52_EFFORTS },
	"zai-org/glm-5.2-fast": { reasons: true, efforts: BASETEN_GLM_52_EFFORTS },
};

/**
 * The reasoning surface Baseten documents for one of its routes, or `undefined`
 * when the route does not reason.
 */
export function basetenRouteReasoning(modelId: string): BasetenRouteReasoning | undefined {
	return BASETEN_ROUTE_REASONING[modelId.toLowerCase()];
}
