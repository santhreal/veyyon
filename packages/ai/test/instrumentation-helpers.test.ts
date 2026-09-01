import { describe, expect, it } from "bun:test";
import {
	allowsSessionTelemetry,
	atLeast,
	INSTRUMENTATION_LEVELS,
	instrumentationRank,
	SESSION_TELEMETRY_POLICY,
	type SessionTelemetryCategory,
	sessionTelemetryDetail,
} from "../src/instrumentation";

describe("INSTRUMENTATION_LEVELS", () => {
	it("contains off, basic, rich, ultra", () => {
		expect(INSTRUMENTATION_LEVELS).toEqual(["off", "basic", "rich", "ultra"]);
	});
});

describe("instrumentationRank", () => {
	it("returns 0 for undefined", () => {
		expect(instrumentationRank(undefined)).toBe(0);
	});
	it("returns 0 for off", () => {
		expect(instrumentationRank("off")).toBe(0);
	});
	it("returns 1 for basic", () => {
		expect(instrumentationRank("basic")).toBe(1);
	});
	it("returns 2 for rich", () => {
		expect(instrumentationRank("rich")).toBe(2);
	});
	it("returns 3 for ultra", () => {
		expect(instrumentationRank("ultra")).toBe(3);
	});
});

describe("atLeast", () => {
	it("returns true when level equals minimum", () => {
		expect(atLeast("basic", "basic")).toBe(true);
	});
	it("returns true when level exceeds minimum", () => {
		expect(atLeast("rich", "basic")).toBe(true);
	});
	it("returns false when level is below minimum", () => {
		expect(atLeast("off", "basic")).toBe(false);
	});
	it("returns true when both are off", () => {
		expect(atLeast("off", "off")).toBe(true);
	});
	it("returns true when undefined and minimum is off", () => {
		expect(atLeast(undefined, "off")).toBe(true);
	});
	it("returns false when undefined and minimum is basic", () => {
		expect(atLeast(undefined, "basic")).toBe(false);
	});
	it("returns true for ultra vs any", () => {
		expect(atLeast("ultra", "rich")).toBe(true);
		expect(atLeast("ultra", "basic")).toBe(true);
		expect(atLeast("ultra", "off")).toBe(true);
	});
});

describe("SESSION_TELEMETRY_POLICY", () => {
	it("lifecycle requires basic", () => {
		expect(SESSION_TELEMETRY_POLICY.lifecycle).toBe("basic");
	});
	it("context-breakdown requires rich", () => {
		expect(SESSION_TELEMETRY_POLICY["context-breakdown"]).toBe("rich");
	});
	it("tool-span requires basic", () => {
		expect(SESSION_TELEMETRY_POLICY["tool-span"]).toBe("basic");
	});
	it("model-turn requires basic", () => {
		expect(SESSION_TELEMETRY_POLICY["model-turn"]).toBe("basic");
	});
	it("model-request requires basic", () => {
		expect(SESSION_TELEMETRY_POLICY["model-request"]).toBe("basic");
	});
	it("agent-communication requires rich", () => {
		expect(SESSION_TELEMETRY_POLICY["agent-communication"]).toBe("rich");
	});
	it("goal-verification requires basic", () => {
		expect(SESSION_TELEMETRY_POLICY["goal-verification"]).toBe("basic");
	});
});

describe("sessionTelemetryDetail", () => {
	const categories: SessionTelemetryCategory[] = [
		"lifecycle",
		"context-breakdown",
		"tool-span",
		"model-turn",
		"model-request",
		"agent-communication",
		"goal-verification",
	];

	it("returns none for off level on any category", () => {
		for (const cat of categories) {
			expect(sessionTelemetryDetail("off", cat)).toBe("none");
		}
	});
	it("returns none for undefined level on any category", () => {
		for (const cat of categories) {
			expect(sessionTelemetryDetail(undefined, cat)).toBe("none");
		}
	});
	it("returns basic for basic level on basic-requiring categories", () => {
		expect(sessionTelemetryDetail("basic", "lifecycle")).toBe("basic");
		expect(sessionTelemetryDetail("basic", "tool-span")).toBe("basic");
		expect(sessionTelemetryDetail("basic", "model-turn")).toBe("basic");
	});
	it("returns none for basic level on rich-requiring categories", () => {
		expect(sessionTelemetryDetail("basic", "context-breakdown")).toBe("none");
		expect(sessionTelemetryDetail("basic", "agent-communication")).toBe("none");
	});
	it("returns rich for rich level on rich-requiring categories", () => {
		expect(sessionTelemetryDetail("rich", "context-breakdown")).toBe("rich");
		expect(sessionTelemetryDetail("rich", "agent-communication")).toBe("rich");
	});
	it("returns ultra for ultra level on any category", () => {
		for (const cat of categories) {
			expect(sessionTelemetryDetail("ultra", cat)).toBe("ultra");
		}
	});
});

describe("allowsSessionTelemetry", () => {
	it("returns true when detail is not none", () => {
		expect(allowsSessionTelemetry("basic", "lifecycle")).toBe(true);
	});
	it("returns false when detail is none", () => {
		expect(allowsSessionTelemetry("off", "lifecycle")).toBe(false);
	});
	it("returns false for undefined level", () => {
		expect(allowsSessionTelemetry(undefined, "lifecycle")).toBe(false);
	});
	it("returns true for ultra on any category", () => {
		expect(allowsSessionTelemetry("ultra", "context-breakdown")).toBe(true);
	});
});
