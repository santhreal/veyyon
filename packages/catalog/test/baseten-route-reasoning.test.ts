/**
 * WHY: Baseten serves every model through one endpoint but validates
 * `reasoning_effort` per route, so this table is the only thing standing
 * between the effort picker and a request the endpoint rejects. Its values are
 * transcribed from two Baseten doc pages that disagree about membership, and a
 * transcription cannot be re-derived from code, which is the case where the
 * data itself is the contract.
 *
 * The GLM 5.2 rows are the expensive ones: Baseten returns a `400` for any
 * depth outside `high`/`max`, so both a missing depth and an extra one are
 * user-visible failures rather than cosmetic drift.
 *
 * Sources:
 *   https://docs.baseten.co/inference/model-apis/overview   (model matrix)
 *   https://docs.baseten.co/inference/model-apis/reasoning   (depth table)
 */
import { describe, expect, test } from "bun:test";
import { Effort, THINKING_EFFORTS } from "@veyyon/catalog/effort";
import { basetenRouteReasoning } from "@veyyon/catalog/provider-models/baseten-reasoning";

describe("Baseten per-route reasoning", () => {
	test("offers each documented depth scale exactly, with no invented tiers", () => {
		const full = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];
		expect(basetenRouteReasoning("openai/gpt-oss-120b")).toEqual({ reasons: true, efforts: full });
		expect(basetenRouteReasoning("deepseek-ai/DeepSeek-V4-Pro")).toEqual({ reasons: true, efforts: full });
		expect(basetenRouteReasoning("thinkingmachines/inkling")).toEqual({ reasons: true, efforts: full });
		expect(basetenRouteReasoning("thinkingmachines/inkling-small")).toEqual({ reasons: true, efforts: full });
		expect(basetenRouteReasoning("moonshotai/Kimi-K3")).toEqual({
			reasons: true,
			efforts: [Effort.Low, Effort.High, Effort.Max],
		});
	});

	test("holds both GLM 5.2 routes to the two depths that do not 400", () => {
		const glm52 = { reasons: true, efforts: [Effort.High, Effort.Max] };
		expect(basetenRouteReasoning("zai-org/GLM-5.2")).toEqual(glm52);
		expect(basetenRouteReasoning("zai-org/GLM-5.2-Fast")).toEqual(glm52);
	});

	test("lets a route reason with no addressable depth", () => {
		// In Baseten's matrix as "Enabled by default", absent from the depth
		// table: the parameter is accepted and ignored, so there is no ladder to
		// offer and `reasoning: true` is the whole surface.
		expect(basetenRouteReasoning("deepseek-ai/DeepSeek-V4-Flash-0731")).toEqual({ reasons: true });
	});

	test("does not advertise reasoning on the opt-in routes Veyyon cannot switch on", () => {
		// These reason only when the request carries
		// `chat_template_args: { enable_thinking: true }`, which Veyyon has no
		// encoding for. Advertising them would offer a control with no switch.
		for (const id of [
			"zai-org/GLM-4.7",
			"moonshotai/Kimi-K2.6",
			"moonshotai/Kimi-K2.7-Code",
			"nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
		]) {
			expect(basetenRouteReasoning(id)).toEqual({ reasons: false });
		}
	});

	test("treats a route outside Baseten's matrix as not reasoning at all", () => {
		for (const id of ["zai-org/GLM-5", "zai-org/GLM-5.1", "moonshotai/Kimi-K2.5", "MiniMaxAI/MiniMax-M2.5"]) {
			expect(basetenRouteReasoning(id)).toBeUndefined();
		}
	});

	test("resolves a route however the host spells it", () => {
		// The routes are HuggingFace repo names and hosts vary the case; a model
		// id's spelling is never a fact about the model.
		expect(basetenRouteReasoning("zai-org/glm-5.2")).toEqual(basetenRouteReasoning("zai-org/GLM-5.2"));
		expect(basetenRouteReasoning("DEEPSEEK-AI/DEEPSEEK-V4-PRO")).toEqual(
			basetenRouteReasoning("deepseek-ai/DeepSeek-V4-Pro"),
		);
	});

	test("never puts the thinking-off state on a depth ladder", () => {
		// Baseten spells disable as `reasoning_effort: "none"`, which is the off
		// state rather than a depth. `Effort` carries no off member precisely so a
		// ladder cannot hold one, and a route that smuggled the wire spelling in
		// would render an "off" entry twice in the picker.
		for (const id of [
			"openai/gpt-oss-120b",
			"deepseek-ai/DeepSeek-V4-Pro",
			"moonshotai/Kimi-K3",
			"zai-org/GLM-5.2",
			"zai-org/GLM-5.2-Fast",
			"thinkingmachines/inkling",
			"thinkingmachines/inkling-small",
		]) {
			const efforts = basetenRouteReasoning(id)?.efforts ?? [];
			expect(efforts).not.toContain("none");
			expect(efforts).not.toContain("off");
			expect(efforts.every(effort => THINKING_EFFORTS.includes(effort))).toBe(true);
		}
	});
});
