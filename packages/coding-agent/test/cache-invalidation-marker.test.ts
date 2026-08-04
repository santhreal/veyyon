import { beforeAll, describe, expect, it } from "bun:test";
import type { Usage } from "@veyyon/ai/types";
import {
	CacheInvalidationMarkerComponent,
	detectCacheInvalidation,
	usesExplicitPromptCache,
} from "@veyyon/coding-agent/modes/components/cache-invalidation-marker";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

function usage(parts: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number }): Usage {
	const input = parts.input ?? 0;
	const output = parts.output ?? 0;
	const cacheRead = parts.cacheRead ?? 0;
	const cacheWrite = parts.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("detectCacheInvalidation", () => {
	it("does not flag the first turn (no prior cache footprint)", () => {
		expect(detectCacheInvalidation(undefined, usage({ cacheWrite: 50_000, input: 2 }))).toBeUndefined();
	});

	it("flags a cacheRead collapse after a warm turn and reports reprocessed tokens", () => {
		// Mirrors the observed session: warm turn reads ~50k, next request reads
		// nothing and re-creates the whole prefix.
		const prev = usage({ cacheRead: 49_837, cacheWrite: 980, output: 79 });
		const current = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99, output: 99 });
		expect(detectCacheInvalidation(prev, current)).toEqual({ reprocessedTokens: 50_999 });
	});

	it("does not flag a cold turn whose predecessor only wrote the cache (never read it)", () => {
		// The session's opening request writes the prefix (cacheRead 0); a long
		// first tool call then outlives the provider's cache TTL, so the follow-up
		// re-writes cold. The cache was never proven live, so this is expected
		// warming/expiry — not a user-caused invalidation worth a marker right
		// under the opening message.
		const prev = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99 });
		const current = usage({ cacheRead: 0, cacheWrite: 51_113, input: 16 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});

	it("does not flag a turn that reused any cache", () => {
		const prev = usage({ cacheRead: 50_900, cacheWrite: 980 });
		const current = usage({ cacheRead: 50_900, cacheWrite: 3_459, input: 2 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});

	it("does not flag implicit best-effort caches that report no cacheWrite", () => {
		// Gemini/antigravity and Fireworks/glm report `cacheWrite: 0` and drop
		// `cacheRead` to zero intermittently while the prefix is unchanged — a
		// provider propagation race that self-heals next turn, not an invalidation.
		// Mirrors the observed gemini-3.5-flash turn (warm 40.8k read, then a cold
		// 43.1k reprocess with zero cacheWrite).
		const prev = usage({ cacheRead: 40_789, input: 1_069, output: 353 });
		const current = usage({ cacheRead: 0, cacheWrite: 0, input: 43_102, output: 58 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});

	it("ignores collapses when the prior footprint was below the cacheable floor", () => {
		// No meaningful cache existed to invalidate (e.g. provider without prompt
		// caching, or a tiny early context).
		const prev = usage({ input: 500 });
		expect(detectCacheInvalidation(prev, usage({ input: 600 }))).toBeUndefined();
	});

	it("ignores a cold turn that reprocessed only a trivial prompt", () => {
		const prev = usage({ cacheRead: 40_000, cacheWrite: 1_000 });
		expect(detectCacheInvalidation(prev, usage({ cacheRead: 0, input: 12 }))).toBeUndefined();
	});

	/**
	 * The cause is the actionable half of the marker. A bare token count tells an
	 * operator that the conversation was just re-read at full rate and nothing about
	 * what to stop doing. A measured session made that concrete: four prefix
	 * rebuilds of roughly 32k characters each, every one of them caused by
	 * re-rooting the working directory, and the transcript said only "cache miss".
	 */
	it("carries the recorded reason through to the marker", () => {
		const prev = usage({ cacheRead: 49_837, cacheWrite: 980, output: 79 });
		const current = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99, output: 99 });

		expect(detectCacheInvalidation(prev, current, "cwd-change")).toEqual({
			reprocessedTokens: 50_999,
			cause: "cwd-change",
		});
	});

	/**
	 * A blank or whitespace reason must not become a `cause`, or the divider renders
	 * a trailing separator with nothing after it. Absent is the honest state when
	 * the session recorded nothing for this turn, which is every turn on a
	 * transcript rebuilt from disk.
	 */
	it.each([undefined, "", "   "])("omits an empty cause (%p)", cause => {
		const prev = usage({ cacheRead: 49_837, cacheWrite: 980 });
		const current = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99 });

		expect(detectCacheInvalidation(prev, current, cause)).toEqual({ reprocessedTokens: 50_999 });
	});

	/**
	 * A cause never promotes a non-invalidation into a marker. Every suppression
	 * rule above runs before the reason is considered, so a recorded reason on a
	 * turn that reused its cache still renders nothing.
	 */
	it("does not flag a warm turn merely because a reason was recorded", () => {
		const prev = usage({ cacheRead: 50_900, cacheWrite: 980 });
		const current = usage({ cacheRead: 50_900, cacheWrite: 3_459, input: 2 });

		expect(detectCacheInvalidation(prev, current, "cwd-change")).toBeUndefined();
	});
});

describe("CacheInvalidationMarkerComponent", () => {
	beforeAll(async () => {
		// render() reads the global theme singleton (icons, rule glyph, colors).
		await initTheme();
	});

	it("renders a slim, left-aligned, partial-width divider padded by blank lines", () => {
		const lines = new CacheInvalidationMarkerComponent({ reprocessedTokens: 50_999 }).render(80);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("");
		expect(lines[2]).toBe("");
		// The divider spans only a short rule + label — well under the full width.
		const dividerWidth = Bun.stringWidth(lines[1]);
		expect(dividerWidth).toBeGreaterThan(0);
		expect(dividerWidth).toBeLessThan(80);
	});

	/**
	 * The rendered divider must actually show the reason, in the same
	 * separator-joined shape as the token count, since that string is the entire
	 * operator-visible surface for a cache loss. Asserted on the stripped text
	 * rather than the styled bytes so a theme change cannot silently drop it.
	 */
	it("names the cause in the divider next to the token count", () => {
		const lines = new CacheInvalidationMarkerComponent({
			reprocessedTokens: 50_999,
			cause: "cwd-change",
		}).render(80);
		const text = Bun.stripANSI(lines[1] ?? "");

		expect(text).toContain("cache miss");
		expect(text).toContain("51K tokens");
		expect(text).toContain("cwd-change");
	});

	/**
	 * Without a cause the divider keeps its previous shape exactly: no dangling
	 * separator, nothing implying a reason was known and withheld.
	 */
	it("keeps the token-only divider when no cause is known", () => {
		const lines = new CacheInvalidationMarkerComponent({ reprocessedTokens: 50_999 }).render(80);
		const text = Bun.stripANSI(lines[1] ?? "").trimEnd();

		expect(text).toContain("51K tokens");
		expect(text.endsWith("tokens")).toBe(true);
	});
});

/**
 * The case the detector used to discard.
 *
 * `cacheWrite <= 0` returned undefined unconditionally, which is right for an
 * implicit best-effort cache — those drop `cacheRead` to zero as propagation
 * noise and self-heal — and exactly wrong for an explicit, prefix-controlled one.
 * There, reading nothing AND writing nothing means the markers were sent and had
 * no effect: nothing is cached for the next turn either, so the same full-rate
 * cost recurs until something changes. That is the shape of every prompt-cache
 * defect shipped so far, and it was the one state the UI never showed.
 */
describe("a cache the provider ignored entirely", () => {
	const warm = usage({ cacheRead: 50_000, input: 200 });
	const ignored = usage({ input: 50_000 });

	it("stays silent on an implicit cache, where a zero-write turn is noise", () => {
		expect(detectCacheInvalidation(warm, ignored)).toBeUndefined();
		expect(detectCacheInvalidation(warm, ignored, undefined, { explicitCache: false })).toBeUndefined();
	});

	it("flags a rejection on an explicit cache, counting what was re-read", () => {
		const invalidation = detectCacheInvalidation(warm, ignored, undefined, { explicitCache: true });
		expect(invalidation).toEqual({ reprocessedTokens: 50_000, rejected: true });
	});

	it("carries the cause through when the session recorded one", () => {
		const invalidation = detectCacheInvalidation(warm, ignored, "model-change", { explicitCache: true });
		expect(invalidation).toEqual({ reprocessedTokens: 50_000, rejected: true, cause: "model-change" });
	});

	/** The other exemptions still apply: an explicit cache does not license
	 *  flagging a turn that reused the prefix, or a trivially small prompt. */
	it("keeps every existing exemption", () => {
		expect(
			detectCacheInvalidation(warm, usage({ cacheRead: 40_000, input: 10 }), undefined, { explicitCache: true }),
		).toBeUndefined();
		expect(detectCacheInvalidation(warm, usage({ input: 100 }), undefined, { explicitCache: true })).toBeUndefined();
		expect(detectCacheInvalidation(undefined, ignored, undefined, { explicitCache: true })).toBeUndefined();
		// A predecessor that only WROTE has not proven the cache was ever live.
		expect(
			detectCacheInvalidation(usage({ cacheWrite: 50_000 }), ignored, undefined, { explicitCache: true }),
		).toBeUndefined();
	});

	/**
	 * The marker must not call this a "miss". A miss re-reads the prompt once and
	 * works again next turn; a rejection recurs every turn. Naming them the same
	 * thing tells the operator to shrug at both.
	 */
	it("reads as a rejection, not a miss", () => {
		const lines = new CacheInvalidationMarkerComponent({
			reprocessedTokens: 50_999,
			rejected: true,
			cause: "model-change",
		}).render(80);
		const text = Bun.stripANSI(lines[1] ?? "");

		expect(text).toContain("cache rejected");
		expect(text).not.toContain("cache miss");
		expect(text).toContain("51K tokens");
		expect(text).toContain("model-change");
	});

	/** A plain miss keeps its existing wording, so this change cannot rename the
	 *  common case out from under anyone reading transcripts. */
	it("leaves the ordinary miss wording untouched", () => {
		const text = Bun.stripANSI(
			new CacheInvalidationMarkerComponent({ reprocessedTokens: 50_999 }).render(80)[1] ?? "",
		);
		expect(text).toContain("cache miss");
		expect(text).not.toContain("rejected");
	});
});

describe("usesExplicitPromptCache", () => {
	/** Anthropic and Bedrock always report cache writes, so the write signal is
	 *  authoritative there and a zero-write turn is provable. */
	it("recognises the always-explicit wire formats", () => {
		expect(usesExplicitPromptCache("anthropic-messages", "claude-sonnet-4-5")).toBe(true);
		expect(usesExplicitPromptCache("bedrock-converse-stream", "anthropic.claude-sonnet-4-5")).toBe(true);
	});

	/**
	 * OpenAI is explicit only from the generation that accepts breakpoints, and the
	 * answer comes from the same catalog predicate the request builder uses to
	 * decide whether to SEND one. Restating the version test here would let the two
	 * drift, and a drift in this direction flags healthy turns.
	 */
	it("defers to the catalog for OpenAI generations", () => {
		expect(usesExplicitPromptCache("openai-responses", "gpt-5.6")).toBe(true);
		expect(usesExplicitPromptCache("openai-responses", "gpt-4o")).toBe(false);
	});

	/** Implicit caches must stay out, or their routine propagation noise becomes a
	 *  stream of false rejections. */
	it("excludes implicit caches and unknown shapes", () => {
		expect(usesExplicitPromptCache("google-generative-ai", "gemini-3-pro")).toBe(false);
		expect(usesExplicitPromptCache(undefined, undefined)).toBe(false);
		expect(usesExplicitPromptCache("openai-responses", undefined)).toBe(false);
	});
});
