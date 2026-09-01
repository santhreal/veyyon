import { describe, expect, it } from "bun:test";
import {
	type ArgotGate,
	type ArgotGateInput,
	EMPTY_GATE,
	makeGate,
	modelAllowed,
	modelIdSegment,
	shouldEncode,
} from "../src/policy";

describe("EMPTY_GATE", () => {
	it("has empty models array", () => {
		expect(EMPTY_GATE.models).toEqual([]);
	});
	it("has disableAboveTokens 0", () => {
		expect(EMPTY_GATE.disableAboveTokens).toBe(0);
	});
});

describe("makeGate", () => {
	it("returns EMPTY_GATE when disabled", () => {
		expect(makeGate(false)).toBe(EMPTY_GATE);
	});
	it("returns EMPTY_GATE when disabled even with options", () => {
		expect(makeGate(false, { models: ["claude-sonnet"], disableAboveTokens: 1000 })).toBe(EMPTY_GATE);
	});
	it("returns gate with models when enabled", () => {
		const gate = makeGate(true, { models: ["claude-sonnet"] });
		expect(gate.models).toEqual(["claude-sonnet"]);
	});
	it("returns gate with disableAboveTokens when enabled", () => {
		const gate = makeGate(true, { disableAboveTokens: 50000 });
		expect(gate.disableAboveTokens).toBe(50000);
	});
	it("defaults models to empty array", () => {
		const gate = makeGate(true);
		expect(gate.models).toEqual([]);
	});
	it("defaults disableAboveTokens to 0", () => {
		const gate = makeGate(true);
		expect(gate.disableAboveTokens).toBe(0);
	});
});

describe("modelIdSegment", () => {
	it("returns id unchanged when no slash", () => {
		expect(modelIdSegment("claude-sonnet")).toBe("claude-sonnet");
	});
	it("returns segment after last slash", () => {
		expect(modelIdSegment("anthropic/claude-sonnet")).toBe("claude-sonnet");
	});
	it("returns segment after last slash with provider prefix", () => {
		expect(modelIdSegment("anthropic/claude-3-5-sonnet")).toBe("claude-3-5-sonnet");
	});
	it("handles multiple slashes", () => {
		expect(modelIdSegment("a/b/c")).toBe("c");
	});
	it("handles trailing slash", () => {
		expect(modelIdSegment("a/")).toBe("");
	});
	it("handles empty string", () => {
		expect(modelIdSegment("")).toBe("");
	});
	it("handles slash only", () => {
		expect(modelIdSegment("/")).toBe("");
	});
});

describe("modelAllowed", () => {
	it("matches exact id with slash", () => {
		expect(modelAllowed("anthropic/claude-sonnet", "anthropic/claude-sonnet")).toBe(true);
	});
	it("does not match different id with slash", () => {
		expect(modelAllowed("anthropic/claude-sonnet", "anthropic/claude-opus")).toBe(false);
	});
	it("matches segment without slash", () => {
		expect(modelAllowed("claude-sonnet", "anthropic/claude-sonnet")).toBe(true);
	});
	it("does not match different segment", () => {
		expect(modelAllowed("claude-sonnet", "anthropic/claude-opus")).toBe(false);
	});
	it("matches exact id without slash in model", () => {
		expect(modelAllowed("claude-sonnet", "claude-sonnet")).toBe(true);
	});
	it("does not match different id without slash", () => {
		expect(modelAllowed("claude-sonnet", "claude-opus")).toBe(false);
	});
});

describe("shouldEncode", () => {
	const gate: ArgotGate = {
		models: ["anthropic/claude-sonnet"],
		disableAboveTokens: 50_000,
	};

	it("returns false when models is empty", () => {
		const input: ArgotGateInput = { model: "anthropic/claude-sonnet", contextTokens: 100 };
		expect(shouldEncode({ models: [], disableAboveTokens: 0 }, input)).toBe(false);
	});
	it("returns true when model matches and below token limit", () => {
		const input: ArgotGateInput = { model: "anthropic/claude-sonnet", contextTokens: 100 };
		expect(shouldEncode(gate, input)).toBe(true);
	});
	it("returns false when model does not match", () => {
		const input: ArgotGateInput = { model: "anthropic/claude-opus", contextTokens: 100 };
		expect(shouldEncode(gate, input)).toBe(false);
	});
	it("returns false when at token limit", () => {
		const input: ArgotGateInput = { model: "anthropic/claude-sonnet", contextTokens: 50_000 };
		expect(shouldEncode(gate, input)).toBe(false);
	});
	it("returns false when above token limit", () => {
		const input: ArgotGateInput = { model: "anthropic/claude-sonnet", contextTokens: 60_000 };
		expect(shouldEncode(gate, input)).toBe(false);
	});
	it("returns true when disableAboveTokens is 0", () => {
		const noLimitGate: ArgotGate = { models: ["claude-sonnet"], disableAboveTokens: 0 };
		const input: ArgotGateInput = { model: "anthropic/claude-sonnet", contextTokens: 999_999 };
		expect(shouldEncode(noLimitGate, input)).toBe(true);
	});
	it("returns true when just below token limit", () => {
		const input: ArgotGateInput = { model: "anthropic/claude-sonnet", contextTokens: 49_999 };
		expect(shouldEncode(gate, input)).toBe(true);
	});
	it("matches multiple models in list", () => {
		const multiGate: ArgotGate = {
			models: ["anthropic/claude-opus", "anthropic/claude-sonnet"],
			disableAboveTokens: 0,
		};
		const input: ArgotGateInput = { model: "anthropic/claude-sonnet", contextTokens: 100 };
		expect(shouldEncode(multiGate, input)).toBe(true);
	});
	it("returns false when model not in multi list", () => {
		const multiGate: ArgotGate = {
			models: ["anthropic/claude-opus", "anthropic/claude-sonnet"],
			disableAboveTokens: 0,
		};
		const input: ArgotGateInput = { model: "openai/gpt-4", contextTokens: 100 };
		expect(shouldEncode(multiGate, input)).toBe(false);
	});
});
