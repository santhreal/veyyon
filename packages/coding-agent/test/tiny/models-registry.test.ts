import { describe, expect, it } from "bun:test";
import {
	DEFAULT_MEMORY_LOCAL_MODEL_KEY,
	DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY,
	getTinyLocalModelSpec,
	getTinyMemoryModelSpec,
	getTinyTitleModelSpec,
	isTinyLocalModelKey,
	isTinyMemoryLocalModelKey,
	isTinyMemoryReasoningModelKey,
	isTinyTitleLocalModelKey,
	TINY_LOCAL_MODELS,
	type TinyMemoryLocalModelKey,
	type TinyTitleLocalModelKey,
} from "@veyyon/coding-agent/tiny/models";

/**
 * The tiny title/memory model registries and their lookup guards had no direct test. These guards
 * gate which on-device model the shared inference worker loads, so a stale key (a renamed repo, a
 * key that drifts between the title and memory registries) would silently pick the wrong model or
 * fail a download. These pin registry membership, the two-registry separation (a title key is NOT a
 * memory key and vice versa), the "online" sentinel being no local key at all, the throw-on-unknown
 * spec getters, the reasoning flag, and that each named default is itself a valid registry key.
 */

describe("isTinyTitleLocalModelKey / getTinyTitleModelSpec", () => {
	it("recognizes title registry keys and rejects the online sentinel, memory keys, and unknowns", () => {
		expect(isTinyTitleLocalModelKey("lfm2-350m")).toBe(true);
		expect(isTinyTitleLocalModelKey("online")).toBe(false);
		expect(isTinyTitleLocalModelKey("lfm2-1.2b")).toBe(false);
		expect(isTinyTitleLocalModelKey("xyz")).toBe(false);
	});

	it("returns the matching spec and throws a named error for an unknown key", () => {
		expect(getTinyTitleModelSpec("lfm2-350m").repo).toBe("onnx-community/LFM2-350M-ONNX");
		expect(() => getTinyTitleModelSpec("nope" as TinyTitleLocalModelKey)).toThrow("Unknown tiny title model: nope");
	});
});

describe("isTinyMemoryLocalModelKey / getTinyMemoryModelSpec / isTinyMemoryReasoningModelKey", () => {
	it("recognizes memory registry keys and rejects the online sentinel, title keys, and unknowns", () => {
		expect(isTinyMemoryLocalModelKey("lfm2-1.2b")).toBe(true);
		expect(isTinyMemoryLocalModelKey("online")).toBe(false);
		expect(isTinyMemoryLocalModelKey("lfm2-350m")).toBe(false);
		expect(isTinyMemoryLocalModelKey("xyz")).toBe(false);
	});

	it("returns the matching spec and throws a named error for an unknown key", () => {
		const blocked = getTinyMemoryModelSpec("qwen3-1.7b") as { repo: string; unsupportedReason?: string };
		expect(blocked.repo).toBe("onnx-community/Qwen3-1.7B-ONNX");
		expect(blocked.unsupportedReason).toBeDefined();
		expect(() => getTinyMemoryModelSpec("nope" as TinyMemoryLocalModelKey)).toThrow(
			"Unknown tiny memory model: nope",
		);
	});

	it("reports the reasoning flag: true for qwen3-1.7b, false for a non-reasoning memory model", () => {
		expect(isTinyMemoryReasoningModelKey("qwen3-1.7b")).toBe(true);
		expect(isTinyMemoryReasoningModelKey("lfm2-1.2b")).toBe(false);
	});
});

describe("getTinyLocalModelSpec / isTinyLocalModelKey (combined registry)", () => {
	it("resolves both a title key and a memory key, returning undefined for the sentinel and unknowns", () => {
		expect(getTinyLocalModelSpec("lfm2-350m")?.key).toBe("lfm2-350m");
		expect(getTinyLocalModelSpec("lfm2-1.2b")?.key).toBe("lfm2-1.2b");
		expect(getTinyLocalModelSpec("online")).toBeUndefined();
		expect(getTinyLocalModelSpec("zzz")).toBeUndefined();
	});

	it("treats any local key from either registry as local but not the online sentinel", () => {
		expect(isTinyLocalModelKey("lfm2-350m")).toBe(true);
		expect(isTinyLocalModelKey("lfm2-1.2b")).toBe(true);
		expect(isTinyLocalModelKey("online")).toBe(false);
		expect(isTinyLocalModelKey("zzz")).toBe(false);
	});

	it("combines both registries: TINY_LOCAL_MODELS is the union of title and memory models", () => {
		expect(TINY_LOCAL_MODELS.length).toBe(10);
	});
});

describe("named default keys are valid registry members", () => {
	it("the default title and memory local keys resolve in their own registries", () => {
		expect(isTinyTitleLocalModelKey(DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY)).toBe(true);
		expect(isTinyMemoryLocalModelKey(DEFAULT_MEMORY_LOCAL_MODEL_KEY)).toBe(true);
	});
});
