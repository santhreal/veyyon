import { describe, expect, it } from "bun:test";
import {
	FIREPASS_WIRE_PREFIX,
	isFireworksFastModelId,
	toFirepassPublicModelId,
	toFirepassWireModelId,
	toFireworksBaseModelId,
	toFireworksPublicModelId,
	toFireworksWireModelId,
} from "../src/fireworks-model-id";

describe("toFireworksPublicModelId", () => {
	it("strips wire prefix and converts p to dot", () => {
		expect(toFireworksPublicModelId("accounts/fireworks/models/llama-v3p1-405b")).toBe("llama-v3.1-405b");
	});

	it("converts p to dot without prefix", () => {
		expect(toFireworksPublicModelId("llama-v3p1-405b")).toBe("llama-v3.1-405b");
	});

	it("handles multiple p separators", () => {
		expect(toFireworksPublicModelId("model-v3p1p2")).toBe("model-v3.1.2");
	});

	it("handles no version separators", () => {
		expect(toFireworksPublicModelId("accounts/fireworks/models/simple-model")).toBe("simple-model");
	});

	it("does not convert p without digits around it", () => {
		expect(toFireworksPublicModelId("accounts/fireworks/models/apple-pie")).toBe("apple-pie");
	});
});

describe("toFireworksWireModelId", () => {
	it("adds wire prefix and converts dot to p", () => {
		expect(toFireworksWireModelId("llama-v3.1-405b")).toBe("accounts/fireworks/models/llama-v3p1-405b");
	});

	it("converts dot to p without prefix", () => {
		expect(toFireworksWireModelId("llama-v3.1-405b")).toBe("accounts/fireworks/models/llama-v3p1-405b");
	});

	it("handles multiple dot separators", () => {
		expect(toFireworksWireModelId("model-v3.1.2")).toBe("accounts/fireworks/models/model-v3p1p2");
	});

	it("handles no version separators", () => {
		expect(toFireworksWireModelId("simple-model")).toBe("accounts/fireworks/models/simple-model");
	});

	it("does not double-add prefix", () => {
		const wire = toFireworksWireModelId("test-model");
		const result = toFireworksWireModelId(wire);
		expect(result).toBe(wire);
	});

	it("does not convert dot without digits around it", () => {
		expect(toFireworksWireModelId("accounts/fireworks/models/test.model")).toBe(
			"accounts/fireworks/models/test.model",
		);
	});
});

describe("toFirepassPublicModelId", () => {
	it("strips firepass prefix and converts p to dot", () => {
		expect(toFirepassPublicModelId("accounts/fireworks/routers/llama-v3p1")).toBe("llama-v3.1");
	});

	it("converts p to dot without prefix", () => {
		expect(toFirepassPublicModelId("llama-v3p1")).toBe("llama-v3.1");
	});

	it("handles no version separators", () => {
		expect(toFirepassPublicModelId("accounts/fireworks/routers/simple-router")).toBe("simple-router");
	});
});

describe("toFirepassWireModelId", () => {
	it("adds firepass prefix and converts dot to p", () => {
		expect(toFirepassWireModelId("llama-v3.1")).toBe("accounts/fireworks/routers/llama-v3p1");
	});

	it("does not double-add prefix", () => {
		const wire = toFirepassWireModelId("test");
		const result = toFirepassWireModelId(wire);
		expect(result).toBe(wire);
	});

	it("handles no version separators", () => {
		expect(toFirepassWireModelId("simple-router")).toBe("accounts/fireworks/routers/simple-router");
	});
});

describe("isFireworksFastModelId", () => {
	it("returns true for model with -fast suffix", () => {
		expect(isFireworksFastModelId("llama-v3-fast")).toBe(true);
	});

	it("returns false for model without -fast suffix", () => {
		expect(isFireworksFastModelId("llama-v3")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isFireworksFastModelId("")).toBe(false);
	});

	it("returns true for model that just is -fast", () => {
		expect(isFireworksFastModelId("-fast")).toBe(true);
	});
});

describe("toFireworksBaseModelId", () => {
	it("strips -fast suffix", () => {
		expect(toFireworksBaseModelId("llama-v3-fast")).toBe("llama-v3");
	});

	it("returns unchanged when no -fast suffix", () => {
		expect(toFireworksBaseModelId("llama-v3")).toBe("llama-v3");
	});

	it("handles empty string", () => {
		expect(toFireworksBaseModelId("")).toBe("");
	});

	it("only strips the last -fast", () => {
		expect(toFireworksBaseModelId("model-fast-fast")).toBe("model-fast");
	});
});

describe("FIREPASS_WIRE_PREFIX constant", () => {
	it("is the firepass router prefix", () => {
		expect(FIREPASS_WIRE_PREFIX).toBe("accounts/fireworks/routers/");
	});
});
