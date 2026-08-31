import { describe, expect, it } from "bun:test";
import { applyCompatOverrides } from "../src/compat/apply";
import { buildCursorCompat } from "../src/compat/cursor";
import { buildDevinCompat } from "../src/compat/devin";
import { matchesKimiK27CodeFamily } from "../src/compat/kimi";
import { leakedToolCallGrammar } from "../src/compat/markup-leaks";

describe("applyCompatOverrides", () => {
	it("applies overrides to existing keys", () => {
		const compat = { a: 1, b: 2 };
		applyCompatOverrides(compat, { a: 10 });
		expect(compat.a).toBe(10);
		expect(compat.b).toBe(2);
	});
	it("does not apply overrides for non-existing keys", () => {
		const compat = { a: 1 };
		applyCompatOverrides(compat, { b: 2 });
		expect(compat).toEqual({ a: 1 });
	});
	it("does not apply undefined overrides", () => {
		const compat = { a: 1 };
		applyCompatOverrides(compat, { a: undefined });
		expect(compat.a).toBe(1);
	});
	it("does nothing for undefined overrides", () => {
		const compat = { a: 1 };
		applyCompatOverrides(compat, undefined);
		expect(compat).toEqual({ a: 1 });
	});
	it("handles empty compat object", () => {
		const compat = {};
		applyCompatOverrides(compat, { a: 1 });
		expect(compat).toEqual({});
	});
	it("handles empty overrides", () => {
		const compat = { a: 1 };
		applyCompatOverrides(compat, {});
		expect(compat).toEqual({ a: 1 });
	});
	it("applies multiple overrides", () => {
		const compat = { a: 1, b: 2, c: 3 };
		applyCompatOverrides(compat, { a: 10, c: 30 });
		expect(compat).toEqual({ a: 10, b: 2, c: 30 });
	});
	it("applies false and null values", () => {
		const compat = { a: true, b: "x" };
		applyCompatOverrides(compat, { a: false, b: null });
		expect(compat.a).toBe(false);
		expect(compat.b).toBeNull();
	});
	it("applies zero value", () => {
		const compat = { a: 5 };
		applyCompatOverrides(compat, { a: 0 });
		expect(compat.a).toBe(0);
	});
});

describe("buildCursorCompat", () => {
	it("returns trustExplicitThinkingOnly true", () => {
		const result = buildCursorCompat({} as never);
		expect(result.trustExplicitThinkingOnly).toBe(true);
	});
});

describe("buildDevinCompat", () => {
	it("returns trustExplicitThinkingOnly true", () => {
		const result = buildDevinCompat({} as never);
		expect(result.trustExplicitThinkingOnly).toBe(true);
	});
});

describe("matchesKimiK27CodeFamily", () => {
	it("matches kimi-k2.7-code id", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2.7-code" })).toBe(true);
	});
	it("matches kimi-k27-code id", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-k27-code" })).toBe(true);
	});
	it("matches kimi-k2p7-code id", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2p7-code" })).toBe(true);
	});
	it("matches with highspeed suffix", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2.7-code-highspeed" })).toBe(true);
	});
	it("matches with slash prefix", () => {
		expect(matchesKimiK27CodeFamily({ id: "moonshot/kimi-k2.7-code" })).toBe(true);
	});
	it("matches kimi-for-coding with k2.7 code name", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-for-coding", name: "Kimi K2.7 Code" })).toBe(true);
	});
	it("does not match kimi-for-coding without k2.7 code name", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-for-coding", name: "Kimi K2" })).toBe(false);
	});
	it("does not match kimi-k2 id", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2" })).toBe(false);
	});
	it("does not match non-kimi id", () => {
		expect(matchesKimiK27CodeFamily({ id: "gpt-4o" })).toBe(false);
	});
	it("is case-insensitive", () => {
		expect(matchesKimiK27CodeFamily({ id: "KIMI-K2.7-CODE" })).toBe(true);
	});
});

describe("leakedToolCallGrammar", () => {
	it("returns kimi for kimi-code provider", () => {
		expect(leakedToolCallGrammar("kimi-code", "kimi-k2")).toBe("kimi");
	});
	it("returns kimi for moonshot provider", () => {
		expect(leakedToolCallGrammar("moonshot", "kimi-k2")).toBe("kimi");
	});
	it("returns kimi for model id matching kimi pattern", () => {
		expect(leakedToolCallGrammar("other", "kimi-k2-chat")).toBe("kimi");
	});
	it("returns dsml for deepseek model on ollama", () => {
		expect(leakedToolCallGrammar("ollama", "deepseek-r1")).toBe("dsml");
	});
	it("returns dsml for deepseek model on deepseek provider", () => {
		expect(leakedToolCallGrammar("deepseek", "deepseek-chat")).toBe("dsml");
	});
	it("returns dsml for deepseek model on fireworks", () => {
		expect(leakedToolCallGrammar("fireworks", "deepseek-v3")).toBe("dsml");
	});
	it("returns dsml for deepseek model on nvidia", () => {
		expect(leakedToolCallGrammar("nvidia", "deepseek-r1")).toBe("dsml");
	});
	it("returns dsml for deepseek model on openrouter", () => {
		expect(leakedToolCallGrammar("openrouter", "deepseek-chat")).toBe("dsml");
	});
	it("returns undefined for non-deepseek on dsml provider", () => {
		expect(leakedToolCallGrammar("ollama", "llama-v3")).toBeUndefined();
	});
	it("returns undefined for deepseek on non-dsml provider", () => {
		expect(leakedToolCallGrammar("openai", "deepseek-chat")).toBeUndefined();
	});
	it("returns undefined for unknown provider and model", () => {
		expect(leakedToolCallGrammar("unknown", "unknown-model")).toBeUndefined();
	});
	it("returns kimi for kimi model id regardless of provider", () => {
		expect(leakedToolCallGrammar("openai", "kimi-k2-chat")).toBe("kimi");
	});
});
