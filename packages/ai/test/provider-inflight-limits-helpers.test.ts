import { afterEach, describe, expect, it } from "bun:test";
import { configureProviderMaxInFlightRequests, resolveProviderInFlightLimit } from "../src/provider-inflight-limits";

afterEach(() => {
	configureProviderMaxInFlightRequests(undefined);
});

describe("resolveProviderInFlightLimit", () => {
	it("returns undefined for provider not in limits", () => {
		expect(resolveProviderInFlightLimit("unknown")).toBeUndefined();
	});
	it("returns undefined for empty limits", () => {
		configureProviderMaxInFlightRequests({});
		expect(resolveProviderInFlightLimit("openai")).toBeUndefined();
	});
	it("returns configured limit", () => {
		configureProviderMaxInFlightRequests({ openai: 5 });
		expect(resolveProviderInFlightLimit("openai")).toBe(5);
	});
	it("returns undefined for non-number value", () => {
		configureProviderMaxInFlightRequests({ openai: "not a number" as unknown as number });
		expect(resolveProviderInFlightLimit("openai")).toBeUndefined();
	});
	it("returns undefined for NaN", () => {
		configureProviderMaxInFlightRequests({ openai: Number.NaN });
		expect(resolveProviderInFlightLimit("openai")).toBeUndefined();
	});
	it("returns undefined for Infinity", () => {
		configureProviderMaxInFlightRequests({ openai: Number.POSITIVE_INFINITY });
		expect(resolveProviderInFlightLimit("openai")).toBeUndefined();
	});
	it("returns undefined for zero", () => {
		configureProviderMaxInFlightRequests({ openai: 0 });
		expect(resolveProviderInFlightLimit("openai")).toBeUndefined();
	});
	it("returns undefined for negative", () => {
		configureProviderMaxInFlightRequests({ openai: -1 });
		expect(resolveProviderInFlightLimit("openai")).toBeUndefined();
	});
	it("floors fractional values", () => {
		configureProviderMaxInFlightRequests({ openai: 3.7 });
		expect(resolveProviderInFlightLimit("openai")).toBe(3);
	});
	it("uses perCallLimits when provided", () => {
		configureProviderMaxInFlightRequests({ openai: 10 });
		expect(resolveProviderInFlightLimit("openai", { openai: 3 })).toBe(3);
	});
	it("uses perCallLimits when configured is empty", () => {
		expect(resolveProviderInFlightLimit("openai", { openai: 2 })).toBe(2);
	});
	it("returns 1 for fractional less than 1 (clamped up)", () => {
		configureProviderMaxInFlightRequests({ openai: 0.5 });
		expect(resolveProviderInFlightLimit("openai")).toBe(1);
	});
});

describe("configureProviderMaxInFlightRequests", () => {
	it("sets limits that can be resolved", () => {
		configureProviderMaxInFlightRequests({ anthropic: 3, google: 5 });
		expect(resolveProviderInFlightLimit("anthropic")).toBe(3);
		expect(resolveProviderInFlightLimit("google")).toBe(5);
	});
	it("clears limits when called with undefined", () => {
		configureProviderMaxInFlightRequests({ openai: 5 });
		configureProviderMaxInFlightRequests(undefined);
		expect(resolveProviderInFlightLimit("openai")).toBeUndefined();
	});
	it("clears limits when called with empty object", () => {
		configureProviderMaxInFlightRequests({ openai: 5 });
		configureProviderMaxInFlightRequests({});
		expect(resolveProviderInFlightLimit("openai")).toBeUndefined();
	});
});
