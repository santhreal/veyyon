import { describe, expect, it } from "bun:test";
import { estimateCost, estimateTokens } from "../src/core/token-counter";
import { generateId, sha256Hex16, stableMemoryId } from "../src/util/ids";
import {
	cjkFtsTerms,
	containsSpacelessCjk,
	FACT_MATCH_STOPWORDS,
	factMatchTokens,
	ftsQueryTerms,
	isCjkChar,
	minimumRecallRelevance,
	RECALL_SYNONYMS,
	recallTokens,
	unicodeWordTokens,
} from "../src/util/regex";

describe("unicodeWordTokens", () => {
	it("extracts simple words", () => {
		expect(unicodeWordTokens("hello world")).toEqual(["hello", "world"]);
	});

	it("handles empty string", () => {
		expect(unicodeWordTokens("")).toEqual([]);
	});

	it("extracts words with underscores", () => {
		expect(unicodeWordTokens("foo_bar baz")).toEqual(["foo_bar", "baz"]);
	});

	it("extracts words with numbers", () => {
		expect(unicodeWordTokens("abc123 def456")).toEqual(["abc123", "def456"]);
	});

	it("splits on punctuation", () => {
		expect(unicodeWordTokens("hello, world!")).toEqual(["hello", "world"]);
	});

	it("handles unicode letters", () => {
		const tokens = unicodeWordTokens("café naïve");
		expect(tokens).toContain("café");
		expect(tokens).toContain("naïve");
	});
});

describe("FACT_MATCH_STOPWORDS", () => {
	it("contains common English stopwords", () => {
		expect(FACT_MATCH_STOPWORDS.has("the")).toBe(true);
		expect(FACT_MATCH_STOPWORDS.has("a")).toBe(true);
		expect(FACT_MATCH_STOPWORDS.has("is")).toBe(true);
		expect(FACT_MATCH_STOPWORDS.has("and")).toBe(true);
	});

	it("does not contain content words", () => {
		expect(FACT_MATCH_STOPWORDS.has("computer")).toBe(false);
		expect(FACT_MATCH_STOPWORDS.has("memory")).toBe(false);
	});
});

describe("RECALL_SYNONYMS", () => {
	it("maps branding to brand-related terms", () => {
		expect(RECALL_SYNONYMS.branding).toContain("brand");
		expect(RECALL_SYNONYMS.branding).toContain("identity");
	});

	it("maps preference to preference-related terms", () => {
		expect(RECALL_SYNONYMS.preference).toContain("prefer");
		expect(RECALL_SYNONYMS.preference).toContain("reject");
	});
});

describe("isCjkChar", () => {
	it("returns true for Chinese characters", () => {
		expect(isCjkChar("中")).toBe(true);
		expect(isCjkChar("文")).toBe(true);
	});

	it("returns true for Japanese hiragana", () => {
		expect(isCjkChar("あ")).toBe(true);
	});

	it("returns true for Japanese katakana", () => {
		expect(isCjkChar("ア")).toBe(true);
	});

	it("returns true for Korean characters", () => {
		expect(isCjkChar("한")).toBe(true);
	});

	it("returns false for ASCII", () => {
		expect(isCjkChar("a")).toBe(false);
		expect(isCjkChar("1")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isCjkChar("")).toBe(false);
	});
});

describe("containsSpacelessCjk", () => {
	it("returns true for text with CJK", () => {
		expect(containsSpacelessCjk("hello 中文 world")).toBe(true);
	});

	it("returns false for text without CJK", () => {
		expect(containsSpacelessCjk("hello world")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(containsSpacelessCjk("")).toBe(false);
	});
});

describe("recallTokens", () => {
	it("extracts tokens from text", () => {
		const tokens = recallTokens("hello world computer");
		expect(tokens).toContain("hello");
		expect(tokens).toContain("world");
		expect(tokens).toContain("computer");
	});

	it("filters out stopwords", () => {
		const tokens = recallTokens("the computer is good");
		expect(tokens).not.toContain("the");
		expect(tokens).not.toContain("is");
		expect(tokens).toContain("computer");
		expect(tokens).toContain("good");
	});

	it("filters out tokens shorter than 3 chars", () => {
		const tokens = recallTokens("ab computer");
		expect(tokens).not.toContain("ab");
		expect(tokens).toContain("computer");
	});

	it("filters out pure digit tokens", () => {
		const tokens = recallTokens("12345 computer");
		expect(tokens).not.toContain("12345");
		expect(tokens).toContain("computer");
	});

	it("lowercases text", () => {
		const tokens = recallTokens("HELLO World");
		expect(tokens).toContain("hello");
		expect(tokens).toContain("world");
	});

	it("handles empty string", () => {
		expect(recallTokens("")).toEqual([]);
	});
});

describe("factMatchTokens", () => {
	it("returns a Set of unique tokens", () => {
		const tokens = factMatchTokens("computer computer memory");
		expect(tokens).toBeInstanceOf(Set);
		expect(tokens.has("computer")).toBe(true);
		expect(tokens.has("memory")).toBe(true);
		expect(tokens.size).toBe(2);
	});

	it("filters stopwords", () => {
		const tokens = factMatchTokens("the computer");
		expect(tokens.has("the")).toBe(false);
		expect(tokens.has("computer")).toBe(true);
	});
});

describe("minimumRecallRelevance", () => {
	it("returns 0.3 for 4+ tokens", () => {
		expect(minimumRecallRelevance(["a", "b", "c", "d"])).toBe(0.3);
		expect(minimumRecallRelevance(["a", "b", "c", "d", "e"])).toBe(0.3);
	});

	it("returns 0.5 for 3 tokens", () => {
		expect(minimumRecallRelevance(["a", "b", "c"])).toBe(0.5);
	});

	it("returns 0.15 for fewer than 3 tokens", () => {
		expect(minimumRecallRelevance(["a", "b"])).toBe(0.15);
		expect(minimumRecallRelevance(["a"])).toBe(0.15);
		expect(minimumRecallRelevance([])).toBe(0.15);
	});
});

describe("cjkFtsTerms", () => {
	it("extracts single CJK characters", () => {
		const terms = cjkFtsTerms("中文");
		expect(terms).toContain("中");
		expect(terms).toContain("文");
	});

	it("creates bigrams from consecutive CJK characters", () => {
		const terms = cjkFtsTerms("中文");
		expect(terms).toContain('"中文"');
	});

	it("returns empty for non-CJK text", () => {
		expect(cjkFtsTerms("hello")).toEqual([]);
	});

	it("returns empty for empty string", () => {
		expect(cjkFtsTerms("")).toEqual([]);
	});

	it("deduplicates characters but creates bigram for repeated chars", () => {
		const terms = cjkFtsTerms("中中");
		expect(terms).toContain("中");
		// The bigram "中中" is created because it's not in seen yet
		expect(terms).toContain('"中中"');
		// But the character "中" appears only once
		expect(terms.filter(t => t === "中")).toHaveLength(1);
	});

	it("handles mixed CJK and non-CJK", () => {
		const terms = cjkFtsTerms("hello 中 world");
		expect(terms).toContain("中");
	});
});

describe("ftsQueryTerms", () => {
	it("returns quoted terms from query", () => {
		const terms = ftsQueryTerms("computer memory");
		expect(terms.every(t => t.startsWith('"') && t.endsWith('"'))).toBe(true);
	});

	it("includes synonyms in expanded terms", () => {
		const terms = ftsQueryTerms("branding");
		expect(terms.some(t => t.includes("brand"))).toBe(true);
	});

	it("quotes all terms", () => {
		const terms = ftsQueryTerms("computer memory");
		for (const term of terms) {
			expect(term.startsWith('"')).toBe(true);
			expect(term.endsWith('"')).toBe(true);
		}
	});
});

describe("sha256Hex16", () => {
	it("returns a 16-character hex string", () => {
		const result = sha256Hex16("test");
		expect(result).toHaveLength(16);
		expect(result).toMatch(/^[0-9a-f]{16}$/);
	});

	it("is deterministic for same input", () => {
		expect(sha256Hex16("test")).toBe(sha256Hex16("test"));
	});

	it("produces different hashes for different inputs", () => {
		expect(sha256Hex16("test")).not.toBe(sha256Hex16("other"));
	});

	it("handles Uint8Array input", () => {
		const buf = new TextEncoder().encode("test");
		expect(sha256Hex16(buf)).toBe(sha256Hex16("test"));
	});

	it("handles empty string", () => {
		const result = sha256Hex16("");
		expect(result).toHaveLength(16);
	});
});

describe("stableMemoryId", () => {
	it("returns same ID for same content", () => {
		expect(stableMemoryId("test")).toBe(stableMemoryId("test"));
	});

	it("returns different IDs for different content", () => {
		expect(stableMemoryId("test")).not.toBe(stableMemoryId("other"));
	});

	it("incorporates source into ID", () => {
		expect(stableMemoryId("test", "source1")).not.toBe(stableMemoryId("test", "source2"));
	});

	it("differs from no-source ID when source is provided", () => {
		expect(stableMemoryId("test", "source")).not.toBe(stableMemoryId("test"));
	});

	it("returns 16-char hex", () => {
		expect(stableMemoryId("test")).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("generateId", () => {
	it("returns a 16-char hex string", () => {
		expect(generateId("test")).toMatch(/^[0-9a-f]{16}$/);
	});

	it("produces different IDs for same content at different times", () => {
		const id1 = generateId("test", new Date("2024-01-01"));
		const id2 = generateId("test", new Date("2024-01-02"));
		expect(id1).not.toBe(id2);
	});

	it("produces different IDs for different content", () => {
		const now = new Date();
		expect(generateId("test1", now)).not.toBe(generateId("test2", now));
	});
});

describe("estimateTokens", () => {
	it("returns a positive number for non-empty text", () => {
		expect(estimateTokens("hello world")).toBeGreaterThan(0);
	});

	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("scales with text length", () => {
		const short = estimateTokens("hello");
		const long = estimateTokens("hello ".repeat(100));
		expect(long).toBeGreaterThan(short);
	});
});

describe("estimateCost", () => {
	it("returns cost estimate with correct model", () => {
		const result = estimateCost(1000, "claude-sonnet-4");
		expect(result.tokens).toBe(1000);
		expect(result.model).toBe("claude-sonnet-4");
		expect(result.rate_per_1m).toBe(3.0);
	});

	it("calculates cost correctly", () => {
		const result = estimateCost(1_000_000, "claude-sonnet-4");
		expect(result.cost_usd).toBe(3.0);
	});

	it("uses default rate for unknown model", () => {
		const result = estimateCost(1000, "unknown-model");
		expect(result.rate_per_1m).toBe(3.0);
	});

	it("uses claude-sonnet-4 as default model", () => {
		const result = estimateCost(1000);
		expect(result.model).toBe("claude-sonnet-4");
	});

	it("rounds cost to 6 decimal places", () => {
		const result = estimateCost(333, "claude-sonnet-4");
		expect(result.cost_usd).toBe(Math.round((333 / 1_000_000) * 3.0 * 1_000_000) / 1_000_000);
	});

	it("handles zero tokens", () => {
		const result = estimateCost(0);
		expect(result.cost_usd).toBe(0);
		expect(result.tokens).toBe(0);
	});

	it("uses different rates for different models", () => {
		const sonnet = estimateCost(1_000_000, "claude-sonnet-4");
		const haiku = estimateCost(1_000_000, "claude-haiku");
		expect(sonnet.cost_usd).toBeGreaterThan(haiku.cost_usd);
	});
});
