import { describe, expect, it } from "bun:test";
import { canonicalizeEfforts, Effort, isEffort, THINKING_EFFORTS } from "../src/effort";
import {
	clampThinkingLevelForModel,
	getSupportedEfforts,
	mapEffortToGoogleThinkingLevel,
	minimumSupportedEffort,
	OLLAMA_WIRE_EFFORTS,
	resolveWireModelId,
} from "../src/model-thinking";
import type { Model } from "../src/types";

describe("isEffort", () => {
	it("returns true for valid effort strings", () => {
		expect(isEffort("minimal")).toBe(true);
		expect(isEffort("low")).toBe(true);
		expect(isEffort("medium")).toBe(true);
		expect(isEffort("high")).toBe(true);
		expect(isEffort("xhigh")).toBe(true);
		expect(isEffort("max")).toBe(true);
	});

	it("returns false for invalid strings", () => {
		expect(isEffort("ultra")).toBe(false);
		expect(isEffort("")).toBe(false);
		expect(isEffort("LOW")).toBe(false);
	});

	it("returns false for non-strings", () => {
		expect(isEffort(42)).toBe(false);
		expect(isEffort(null)).toBe(false);
		expect(isEffort(undefined)).toBe(false);
		expect(isEffort(true)).toBe(false);
		expect(isEffort({})).toBe(false);
	});
});

describe("canonicalizeEfforts", () => {
	it("returns efforts in canonical order", () => {
		const result = canonicalizeEfforts([Effort.High, Effort.Low, Effort.Max]);
		expect(result).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});

	it("preserves already canonical order", () => {
		const result = canonicalizeEfforts([Effort.Minimal, Effort.Low, Effort.Medium]);
		expect(result).toEqual([Effort.Minimal, Effort.Low, Effort.Medium]);
	});

	it("removes duplicates", () => {
		const result = canonicalizeEfforts([Effort.Low, Effort.Low, Effort.High]);
		expect(result).toEqual([Effort.Low, Effort.High]);
	});

	it("returns empty array for empty input", () => {
		expect(canonicalizeEfforts([])).toEqual([]);
	});

	it("handles single element", () => {
		expect(canonicalizeEfforts([Effort.Medium])).toEqual([Effort.Medium]);
	});

	it("handles all efforts", () => {
		const result = canonicalizeEfforts(THINKING_EFFORTS);
		expect(result).toEqual([...THINKING_EFFORTS]);
	});

	it("handles reverse order", () => {
		const result = canonicalizeEfforts([
			Effort.Max,
			Effort.XHigh,
			Effort.High,
			Effort.Medium,
			Effort.Low,
			Effort.Minimal,
		]);
		expect(result).toEqual([...THINKING_EFFORTS]);
	});
});

describe("THINKING_EFFORTS", () => {
	it("contains all 6 efforts in order", () => {
		expect(THINKING_EFFORTS).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
	});

	it("is readonly", () => {
		// Type-level check: THINKING_EFFORTS is readonly Effort[]
		expect(THINKING_EFFORTS.length).toBe(6);
	});
});

describe("OLLAMA_WIRE_EFFORTS", () => {
	it("contains Low, Medium, High, Max", () => {
		expect(OLLAMA_WIRE_EFFORTS).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
	});

	it("does not contain Minimal or XHigh", () => {
		expect(OLLAMA_WIRE_EFFORTS).not.toContain(Effort.Minimal);
		expect(OLLAMA_WIRE_EFFORTS).not.toContain(Effort.XHigh);
	});
});

describe("mapEffortToGoogleThinkingLevel", () => {
	it("maps Minimal to MINIMAL", () => {
		expect(mapEffortToGoogleThinkingLevel(Effort.Minimal)).toBe("MINIMAL");
	});

	it("maps Low to LOW", () => {
		expect(mapEffortToGoogleThinkingLevel(Effort.Low)).toBe("LOW");
	});

	it("maps Medium to MEDIUM", () => {
		expect(mapEffortToGoogleThinkingLevel(Effort.Medium)).toBe("MEDIUM");
	});

	it("maps High to HIGH", () => {
		expect(mapEffortToGoogleThinkingLevel(Effort.High)).toBe("HIGH");
	});

	it("maps XHigh to HIGH", () => {
		expect(mapEffortToGoogleThinkingLevel(Effort.XHigh)).toBe("HIGH");
	});

	it("maps Max to HIGH", () => {
		expect(mapEffortToGoogleThinkingLevel(Effort.Max)).toBe("HIGH");
	});
});

describe("getSupportedEfforts", () => {
	it("returns empty array when model has no reasoning", () => {
		const model = { reasoning: false } as unknown as Model<"openai">;
		expect(getSupportedEfforts(model)).toEqual([]);
	});

	it("returns thinking efforts when model has reasoning", () => {
		const model = {
			reasoning: true,
			thinking: { efforts: [Effort.Low, Effort.High] },
		} as unknown as Model<"openai">;
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.High]);
	});

	it("returns empty array when thinking has no efforts", () => {
		const model = {
			reasoning: true,
			thinking: { efforts: [] },
		} as unknown as Model<"openai">;
		expect(getSupportedEfforts(model)).toEqual([]);
	});

	it("returns empty array when thinking is undefined", () => {
		const model = {
			reasoning: true,
			thinking: undefined,
		} as unknown as Model<"openai">;
		expect(getSupportedEfforts(model)).toEqual([]);
	});
});

describe("clampThinkingLevelForModel", () => {
	it("returns requested when model is undefined", () => {
		expect(clampThinkingLevelForModel(undefined, Effort.High)).toBe(Effort.High);
	});

	it("returns undefined when model has no reasoning", () => {
		const model = { reasoning: false } as unknown as Model<"openai">;
		expect(clampThinkingLevelForModel(model, Effort.High)).toBeUndefined();
	});

	it("returns undefined when requested is undefined", () => {
		const model = {
			reasoning: true,
			thinking: { efforts: [Effort.Low, Effort.High] },
		} as unknown as Model<"openai">;
		expect(clampThinkingLevelForModel(model, undefined)).toBeUndefined();
	});

	it("returns requested when it is supported", () => {
		const model = {
			reasoning: true,
			thinking: { efforts: [Effort.Low, Effort.High] },
		} as unknown as Model<"openai">;
		expect(clampThinkingLevelForModel(model, Effort.High)).toBe(Effort.High);
	});

	it("clamps down to nearest supported level", () => {
		const model = {
			reasoning: true,
			thinking: { efforts: [Effort.Low, Effort.High] },
		} as unknown as Model<"openai">;
		// Medium is not supported, should clamp to Low
		expect(clampThinkingLevelForModel(model, Effort.Medium)).toBe(Effort.Low);
	});

	it("clamps to first level when requested is below all supported", () => {
		const model = {
			reasoning: true,
			thinking: { efforts: [Effort.High, Effort.Max] },
		} as unknown as Model<"openai">;
		expect(clampThinkingLevelForModel(model, Effort.Minimal)).toBe(Effort.High);
	});

	it("returns highest supported below requested", () => {
		const model = {
			reasoning: true,
			thinking: { efforts: [Effort.Minimal, Effort.Medium, Effort.Max] },
		} as unknown as Model<"openai">;
		// High not supported, should clamp to Medium
		expect(clampThinkingLevelForModel(model, Effort.High)).toBe(Effort.Medium);
	});
});

describe("minimumSupportedEffort", () => {
	it("returns undefined when thinking is undefined", () => {
		const model = { thinking: undefined } as unknown as Model<"openai">;
		expect(minimumSupportedEffort(model)).toBeUndefined();
	});

	it("returns undefined when efforts is empty", () => {
		const model = { thinking: { efforts: [] } } as unknown as Model<"openai">;
		expect(minimumSupportedEffort(model)).toBeUndefined();
	});

	it("returns first canonical effort", () => {
		const model = {
			thinking: { efforts: [Effort.High, Effort.Low, Effort.Max] },
		} as unknown as Model<"openai">;
		expect(minimumSupportedEffort(model)).toBe(Effort.Low);
	});

	it("returns single effort", () => {
		const model = {
			thinking: { efforts: [Effort.Medium] },
		} as unknown as Model<"openai">;
		expect(minimumSupportedEffort(model)).toBe(Effort.Medium);
	});
});

describe("resolveWireModelId", () => {
	it("returns effort routing when available", () => {
		const model = {
			id: "base-model",
			requestModelId: "request-id",
			thinking: { effortRouting: { [Effort.High]: "high-variant" } },
		} as unknown as Model<"openai">;
		expect(resolveWireModelId(model, Effort.High)).toBe("high-variant");
	});

	it("returns requestModelId when no effort routing", () => {
		const model = {
			id: "base-model",
			requestModelId: "request-id",
			thinking: {},
		} as unknown as Model<"openai">;
		expect(resolveWireModelId(model, Effort.High)).toBe("request-id");
	});

	it("returns model id when no requestModelId and no routing", () => {
		const model = {
			id: "base-model",
			thinking: {},
		} as unknown as Model<"openai">;
		expect(resolveWireModelId(model, Effort.High)).toBe("base-model");
	});

	it("returns effort routing for undefined effort (off)", () => {
		const model = {
			id: "base-model",
			requestModelId: "request-id",
			thinking: { effortRouting: { off: "off-variant" } },
		} as unknown as Model<"openai">;
		expect(resolveWireModelId(model, undefined)).toBe("off-variant");
	});

	it("returns requestModelId for undefined effort when no off routing", () => {
		const model = {
			id: "base-model",
			requestModelId: "request-id",
			thinking: { effortRouting: {} },
		} as unknown as Model<"openai">;
		expect(resolveWireModelId(model, undefined)).toBe("request-id");
	});

	it("returns model id when thinking is undefined", () => {
		const model = {
			id: "base-model",
			thinking: undefined,
		} as unknown as Model<"openai">;
		expect(resolveWireModelId(model, Effort.High)).toBe("base-model");
	});
});
