import { describe, expect, it } from "bun:test";
import { Effort } from "../src/effort";
import {
	clampThinkingLevelForModel,
	getSupportedEfforts,
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	minimumSupportedEffort,
	OLLAMA_WIRE_EFFORTS,
	type ReasoningSelection,
	type ReasoningSelectionIntent,
	requireSupportedEffort,
	resolveReasoningSelection,
	resolveWireModelId,
} from "../src/model-thinking";
import type { Api, Model } from "../src/types";

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "test-model",
		provider: "test",
		name: "Test",
		api: "openai-completions",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 16384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: undefined,
		...overrides,
	} as unknown as Model<Api>;
}

describe("OLLAMA_WIRE_EFFORTS", () => {
	it("has 4 efforts", () => {
		expect(OLLAMA_WIRE_EFFORTS).toHaveLength(4);
	});
	it("contains low, medium, high, max", () => {
		expect(OLLAMA_WIRE_EFFORTS).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
	});
});

describe("getSupportedEfforts", () => {
	it("returns empty for non-reasoning model", () => {
		expect(getSupportedEfforts(makeModel({ reasoning: false }))).toEqual([]);
	});
	it("returns thinking efforts when reasoning model", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		});
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.High]);
	});
	it("returns empty when reasoning but no thinking config", () => {
		expect(getSupportedEfforts(makeModel({ thinking: undefined }))).toEqual([]);
	});
});

describe("clampThinkingLevelForModel", () => {
	it("returns requested when undefined model", () => {
		expect(clampThinkingLevelForModel(undefined, Effort.High)).toBe(Effort.High);
	});
	it("returns undefined for non-reasoning model", () => {
		expect(clampThinkingLevelForModel(makeModel({ reasoning: false }), Effort.High)).toBeUndefined();
	});
	it("returns undefined when no requested effort", () => {
		expect(clampThinkingLevelForModel(makeModel(), undefined)).toBeUndefined();
	});
	it("returns requested when supported", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		});
		expect(clampThinkingLevelForModel(model, Effort.Medium)).toBe(Effort.Medium);
	});
	it("clamps down to nearest supported effort", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		});
		expect(clampThinkingLevelForModel(model, Effort.Medium)).toBe(Effort.Low);
	});
	it("clamps to first effort when requested is below all", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
		});
		expect(clampThinkingLevelForModel(model, Effort.Minimal)).toBe(Effort.High);
	});
	it("clamps to max when requested is above all", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium] },
		});
		expect(clampThinkingLevelForModel(model, Effort.Max)).toBe(Effort.Medium);
	});
	it("returns undefined for invalid effort", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.Low] },
		});
		expect(clampThinkingLevelForModel(model, "invalid" as unknown as Effort)).toBeUndefined();
	});
});

describe("requireSupportedEffort", () => {
	it("returns effort when supported", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		});
		expect(requireSupportedEffort(model, Effort.Low)).toBe(Effort.Low);
	});
	it("throws for non-reasoning model", () => {
		const model = makeModel({ reasoning: false });
		expect(() => requireSupportedEffort(model, Effort.Low)).toThrow("does not support thinking");
	});
	it("throws for unsupported effort with alternatives", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		});
		expect(() => requireSupportedEffort(model, Effort.Max)).toThrow("not supported");
	});
	it("throws with no efforts message when efforts empty", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [] },
		});
		expect(() => requireSupportedEffort(model, Effort.Low)).toThrow("no controllable thinking efforts");
	});
});

describe("mapEffortToGoogleThinkingLevel", () => {
	it("maps minimal", () => {
		expect(mapEffortToGoogleThinkingLevel(Effort.Minimal)).toBe("MINIMAL");
	});
	it("maps low", () => {
		expect(mapEffortToGoogleThinkingLevel(Effort.Low)).toBe("LOW");
	});
	it("maps medium", () => {
		expect(mapEffortToGoogleThinkingLevel(Effort.Medium)).toBe("MEDIUM");
	});
	it("maps high", () => {
		expect(mapEffortToGoogleThinkingLevel(Effort.High)).toBe("HIGH");
	});
	it("maps xhigh to HIGH", () => {
		expect(mapEffortToGoogleThinkingLevel(Effort.XHigh)).toBe("HIGH");
	});
	it("maps max to HIGH", () => {
		expect(mapEffortToGoogleThinkingLevel(Effort.Max)).toBe("HIGH");
	});
});

describe("mapEffortToAnthropicAdaptiveEffort", () => {
	it("returns effort when no effortMap", () => {
		const model = makeModel({
			thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.High] },
		});
		expect(mapEffortToAnthropicAdaptiveEffort(model, Effort.Low)).toBe("low");
	});
	it("returns mapped effort when effortMap present", () => {
		const model = makeModel({
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.High],
				effortMap: { [Effort.High]: "adaptive" },
			},
		});
		expect(mapEffortToAnthropicAdaptiveEffort(model, Effort.High)).toBe("adaptive");
	});
	it("throws for unsupported effort", () => {
		const model = makeModel({
			thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low] },
		});
		expect(() => mapEffortToAnthropicAdaptiveEffort(model, Effort.Max)).toThrow("not supported");
	});
});

describe("resolveWireModelId", () => {
	it("returns id when no thinking config", () => {
		expect(resolveWireModelId(makeModel(), Effort.High)).toBe("test-model");
	});
	it("returns effortRouting for given effort", () => {
		const model = makeModel({
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.High],
				effortRouting: { [Effort.High]: "test-model-high" },
			},
		});
		expect(resolveWireModelId(model, Effort.High)).toBe("test-model-high");
	});
	it("returns off routing when effort is undefined", () => {
		const model = makeModel({
			requestModelId: "test-model-base",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low],
				effortRouting: { off: "test-model-off" },
			},
		});
		expect(resolveWireModelId(model, undefined)).toBe("test-model-off");
	});
	it("returns requestModelId when no routing matches", () => {
		const model = makeModel({
			requestModelId: "test-model-base",
			thinking: { mode: "effort", efforts: [Effort.Low] },
		});
		expect(resolveWireModelId(model, Effort.High)).toBe("test-model-base");
	});
	it("returns id when no routing and no requestModelId", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.Low] },
		});
		expect(resolveWireModelId(model, Effort.High)).toBe("test-model");
	});
});

describe("minimumSupportedEffort", () => {
	it("returns undefined for no thinking config", () => {
		expect(minimumSupportedEffort(makeModel())).toBeUndefined();
	});
	it("returns undefined for empty efforts", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [] },
		});
		expect(minimumSupportedEffort(model)).toBeUndefined();
	});
	it("returns first canonical effort", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.High, Effort.Low, Effort.Medium] },
		});
		expect(minimumSupportedEffort(model)).toBe(Effort.Low);
	});
	it("returns the only effort", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.Medium] },
		});
		expect(minimumSupportedEffort(model)).toBe(Effort.Medium);
	});
});

describe("resolveReasoningSelection", () => {
	it("returns unsupported for non-reasoning model", () => {
		const result = resolveReasoningSelection(makeModel({ reasoning: false }));
		expect(result.state).toBe("unsupported");
		expect(result.enabled).toBe(false);
		expect(result.effort).toBeUndefined();
	});
	it("returns uncontrolled for reasoning model without thinking", () => {
		const result = resolveReasoningSelection(makeModel({ thinking: undefined }));
		expect(result.state).toBe("uncontrolled");
		expect(result.enabled).toBe(false);
	});
	it("returns disabled for reasoning model with thinking and no effort", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.Low] },
		});
		const result = resolveReasoningSelection(model);
		expect(result.state).toBe("disabled");
		expect(result.enabled).toBe(false);
	});
	it("returns disabled when intent.disabled is true", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.Low] },
		});
		const intent: ReasoningSelectionIntent = { disabled: true };
		const result = resolveReasoningSelection(model, intent);
		expect(result.state).toBe("disabled");
		expect(result.enabled).toBe(false);
	});
	it("returns enabled when effort is provided", () => {
		const model = makeModel({
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		});
		const result = resolveReasoningSelection(model, { effort: Effort.High });
		expect(result.state).toBe("enabled");
		expect(result.effort).toBe(Effort.High);
		expect(result.enabled).toBe(true);
		expect(result.forcedByModel).toBe(false);
	});
	it("returns enabled with forcedByModel when requiresEffort and no suppressWhenOff", () => {
		const model = makeModel({
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.High],
				requiresEffort: true,
				suppressWhenOff: false,
			},
		});
		const result = resolveReasoningSelection(model);
		expect(result.state).toBe("enabled");
		expect(result.forcedByModel).toBe(true);
		expect(result.effort).toBe(Effort.Low);
	});
	it("throws when requiresEffort but no efforts", () => {
		const model = makeModel({
			thinking: {
				mode: "effort",
				efforts: [],
				requiresEffort: true,
				suppressWhenOff: false,
			},
		});
		expect(() => resolveReasoningSelection(model)).toThrow("requires thinking but declares no supported effort");
	});
	it("returns wireModelId from effortRouting", () => {
		const model = makeModel({
			thinking: {
				mode: "effort",
				efforts: [Effort.High],
				effortRouting: { [Effort.High]: "test-model-high" },
			},
		});
		const result = resolveReasoningSelection(model, { effort: Effort.High });
		expect(result.wireModelId).toBe("test-model-high");
	});
	it("returns fallback wireModelId for non-reasoning model", () => {
		const model = makeModel({ reasoning: false, requestModelId: "fallback-id" });
		const result = resolveReasoningSelection(model);
		expect(result.wireModelId).toBe("fallback-id");
	});
});
