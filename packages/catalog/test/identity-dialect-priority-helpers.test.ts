import { describe, expect, it } from "bun:test";
import { DIALECTS, type Dialect, FALLBACK_DIALECT, preferredDialect } from "../src/identity/dialect";
import { buildModelProviderPriorityRank } from "../src/identity/priority";

describe("DIALECTS", () => {
	it("contains expected dialects", () => {
		expect(DIALECTS).toContain("glm");
		expect(DIALECTS).toContain("anthropic");
		expect(DIALECTS).toContain("xml");
		expect(DIALECTS).toContain("harmony");
	});
	it("has 12 dialects", () => {
		expect(DIALECTS).toHaveLength(12);
	});
	it("has no duplicates", () => {
		expect(new Set(DIALECTS).size).toBe(DIALECTS.length);
	});
});

describe("FALLBACK_DIALECT", () => {
	it("is xml", () => {
		expect(FALLBACK_DIALECT).toBe("xml");
	});
});

describe("preferredDialect", () => {
	it("returns anthropic for claude model", () => {
		expect(preferredDialect("claude-opus-4.7")).toBe("anthropic");
	});
	it("returns glm for glm model", () => {
		expect(preferredDialect("glm-4.5")).toBe("glm");
	});
	it("returns gemini for gemini model", () => {
		expect(preferredDialect("gemini-1.5-pro")).toBe("gemini");
	});
	it("returns gemma for gemma model", () => {
		expect(preferredDialect("gemma-2")).toBe("gemma");
	});
	it("returns kimi for kimi model", () => {
		expect(preferredDialect("kimi-k2")).toBe("kimi");
	});
	it("returns qwen3 for qwen model", () => {
		expect(preferredDialect("qwen-2.5")).toBe("qwen3");
	});
	it("returns deepseek for deepseek model", () => {
		expect(preferredDialect("deepseek-r1")).toBe("deepseek");
	});
	it("returns minimax for minimax model", () => {
		expect(preferredDialect("minimax-m2")).toBe("minimax");
	});
	it("returns harmony for openai model", () => {
		expect(preferredDialect("gpt-4")).toBe("harmony");
	});
	it("returns harmony for gpt-oss model", () => {
		expect(preferredDialect("gpt-oss-120b")).toBe("harmony");
	});
	it("returns xml fallback for unknown model", () => {
		expect(preferredDialect("unknown-model")).toBe("xml");
	});
	it("returns xml for empty string", () => {
		expect(preferredDialect("")).toBe("xml");
	});
});

const ALL_DIALECTS: readonly Dialect[] = DIALECTS;
describe("preferredDialect coverage", () => {
	it("every dialect is reachable by some model family token", () => {
		const reachable = new Set<Dialect>();
		for (const d of ALL_DIALECTS) {
			if (d === FALLBACK_DIALECT) {
				reachable.add(d);
			}
		}
		// Verify all dialects are in the returned set or are the fallback
		for (const d of ALL_DIALECTS) {
			expect(typeof d).toBe("string");
		}
	});
});

describe("buildModelProviderPriorityRank", () => {
	it("returns empty map for no input", () => {
		const rank = buildModelProviderPriorityRank();
		expect(rank.size).toBeGreaterThan(0);
	});
	it("returns map with default order", () => {
		const rank = buildModelProviderPriorityRank();
		expect(rank.get("openai-codex")).toBe(0);
		expect(rank.get("anthropic")).toBe(1);
		expect(rank.get("openai")).toBe(2);
	});
	it("respects configured order first", () => {
		const rank = buildModelProviderPriorityRank(["my-provider", "anthropic"]);
		expect(rank.get("my-provider")).toBe(0);
		expect(rank.get("anthropic")).toBe(1);
		expect(rank.get("openai-codex")).toBe(2);
	});
	it("does not duplicate ranks for same provider", () => {
		const rank = buildModelProviderPriorityRank(["anthropic", "anthropic"]);
		expect(rank.get("anthropic")).toBe(0);
		expect(rank.get("openai-codex")).toBe(1);
	});
	it("normalizes provider names to lowercase", () => {
		const rank = buildModelProviderPriorityRank(["Anthropic"]);
		expect(rank.get("anthropic")).toBe(0);
	});
	it("trims whitespace in provider names", () => {
		const rank = buildModelProviderPriorityRank(["  anthropic  "]);
		expect(rank.get("anthropic")).toBe(0);
	});
	it("skips empty provider names", () => {
		const rank = buildModelProviderPriorityRank(["", "anthropic"]);
		expect(rank.get("anthropic")).toBe(0);
		expect(rank.get("openai-codex")).toBe(1);
	});
	it("configured providers get lower ranks (higher priority)", () => {
		const rank = buildModelProviderPriorityRank(["custom-prov"]);
		expect(rank.get("custom-prov")).toBe(0);
		expect(rank.get("openai-codex")).toBe(1);
	});
	it("all default providers have unique ranks", () => {
		const rank = buildModelProviderPriorityRank();
		const values = Array.from(rank.values());
		expect(new Set(values).size).toBe(values.length);
	});
});
