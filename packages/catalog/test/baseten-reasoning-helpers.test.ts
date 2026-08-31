import { describe, expect, it } from "bun:test";
import { Effort } from "../src/effort";
import { basetenRouteReasoning } from "../src/provider-models/baseten-reasoning";

describe("basetenRouteReasoning", () => {
	it("returns undefined for unknown model", () => {
		expect(basetenRouteReasoning("unknown/model")).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(basetenRouteReasoning("")).toBeUndefined();
	});
	it("returns reasoning for deepseek v4 flash", () => {
		const result = basetenRouteReasoning("deepseek-ai/deepseek-v4-flash-0731");
		expect(result).toBeDefined();
		expect(result!.reasons).toBe(true);
		expect(result!.efforts).toBeUndefined();
	});
	it("returns reasoning with full efforts for deepseek v4 pro", () => {
		const result = basetenRouteReasoning("deepseek-ai/deepseek-v4-pro");
		expect(result).toBeDefined();
		expect(result!.reasons).toBe(true);
		expect(result!.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
	});
	it("returns no reasoning for kimi k2.6", () => {
		const result = basetenRouteReasoning("moonshotai/kimi-k2.6");
		expect(result).toBeDefined();
		expect(result!.reasons).toBe(false);
	});
	it("returns no reasoning for kimi k2.7-code", () => {
		const result = basetenRouteReasoning("moonshotai/kimi-k2.7-code");
		expect(result).toBeDefined();
		expect(result!.reasons).toBe(false);
	});
	it("returns reasoning with kimi k3 efforts", () => {
		const result = basetenRouteReasoning("moonshotai/kimi-k3");
		expect(result).toBeDefined();
		expect(result!.reasons).toBe(true);
		expect(result!.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});
	it("returns no reasoning for nemotron", () => {
		const result = basetenRouteReasoning("nvidia/nvidia-nemotron-3-ultra-550b-a55b");
		expect(result).toBeDefined();
		expect(result!.reasons).toBe(false);
	});
	it("returns reasoning with full efforts for gpt-oss-120b", () => {
		const result = basetenRouteReasoning("openai/gpt-oss-120b");
		expect(result).toBeDefined();
		expect(result!.reasons).toBe(true);
		expect(result!.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
	});
	it("returns reasoning for inkling", () => {
		const result = basetenRouteReasoning("thinkingmachines/inkling");
		expect(result).toBeDefined();
		expect(result!.reasons).toBe(true);
		expect(result!.efforts).toBeDefined();
	});
	it("returns reasoning for inkling-small", () => {
		const result = basetenRouteReasoning("thinkingmachines/inkling-small");
		expect(result).toBeDefined();
		expect(result!.reasons).toBe(true);
	});
	it("returns no reasoning for glm-4.7", () => {
		const result = basetenRouteReasoning("zai-org/glm-4.7");
		expect(result).toBeDefined();
		expect(result!.reasons).toBe(false);
	});
	it("returns reasoning with glm-5.2 efforts", () => {
		const result = basetenRouteReasoning("zai-org/glm-5.2");
		expect(result).toBeDefined();
		expect(result!.reasons).toBe(true);
		expect(result!.efforts).toEqual([Effort.High, Effort.Max]);
	});
	it("returns reasoning with glm-5.2-fast efforts", () => {
		const result = basetenRouteReasoning("zai-org/glm-5.2-fast");
		expect(result).toBeDefined();
		expect(result!.reasons).toBe(true);
		expect(result!.efforts).toEqual([Effort.High, Effort.Max]);
	});
	it("is case insensitive", () => {
		const result = basetenRouteReasoning("DeepSeek-AI/DeepSeek-V4-Pro");
		expect(result).toBeDefined();
		expect(result!.reasons).toBe(true);
	});
});
