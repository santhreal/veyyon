/**
 * The prompt cache is now checked, not just billed.
 *
 * WHY THIS SUITE EXISTS. Four cache defects shipped and were all found by
 * reading a bill: Codex Responses Lite stamped a breakpoint a model rejects with
 * `invalid_parameter`; Claude via OpenRouter failed a `startsWith("anthropic/")`
 * test under its `~anthropic/…` alias rows so no breakpoint was ever written;
 * `prompt_cache_retention: "24h"` reached generations that reject it; `/branch`
 * and `/btw` re-prefilled the whole transcript. Every one of them was silent —
 * the run worked, only the cost moved — because `cacheRead` was read to price
 * the turn and never compared against what the request had asked for.
 *
 * WHAT IS PINNED. Each verdict branch, and — the part that decides whether this
 * check survives contact with reality — each innocent explanation for a miss.
 * A check that calls a legitimate cold start or an expired window a defect gets
 * switched off within a day, so the exemptions are tested as hard as the
 * failures: first request, below the cacheable floor, expired window, prefix
 * churn, and a provider that does not report writes at all.
 *
 * The verdict is derived only from provider-reported numbers. There is no prefix
 * estimate anywhere in it, deliberately: an estimate that drifts from the real
 * tokenizer becomes a false-alarm generator.
 */
import { describe, expect, it } from "bun:test";
import {
	CACHE_TTL_MS,
	CACHE_WINDOW_GRACE,
	type CacheExpectation,
	CacheRejectedError,
	cacheWindowGraceMs,
	decideCacheEnforcement,
	describeCacheVerdict,
	isCacheHealthy,
	isEnforceableFailure,
	MIN_CACHEABLE_TOKENS,
	resolveCacheEnforcement,
	verifyCacheUsage,
} from "@veyyon/ai/cache";

/** A mid-session request on a warm key: anchors placed, window open, not first. */
function warmRequest(overrides: Partial<CacheExpectation> = {}): CacheExpectation {
	return {
		anchors: 4,
		retention: "short",
		firstRequest: false,
		msSincePreviousRequest: 30_000,
		reportsCacheWrites: true,
		...overrides,
	};
}

function usage(input: number, cacheRead: number, cacheWrite: number) {
	return { input, cacheRead, cacheWrite };
}

describe("a cache that worked", () => {
	/** The ordinary case, and the ratio the operator is shown. */
	it("reports a read with the share of the prompt it covered", () => {
		const verdict = verifyCacheUsage(warmRequest(), usage(500, 49_500, 0));
		expect(verdict).toEqual({ kind: "ok", readTokens: 49_500, totalInputTokens: 50_000, ratio: 0.99 });
		expect(isCacheHealthy(verdict)).toBe(true);
		expect(isEnforceableFailure(verdict)).toBe(false);
	});

	/** A read plus a write is still a working cache: the window rolled forward. */
	it("treats a read alongside a write as healthy", () => {
		const verdict = verifyCacheUsage(warmRequest(), usage(200, 40_000, 1_200));
		expect(verdict.kind).toBe("ok");
	});
});

describe("a miss with an innocent explanation is never a failure", () => {
	/**
	 * The first turn on a key MUST miss — there is nothing to read yet. Calling
	 * this a defect would fail the opening request of every single session.
	 */
	it("excuses the first request on a key", () => {
		const verdict = verifyCacheUsage(warmRequest({ firstRequest: true }), usage(50_000, 0, 50_000));
		expect(verdict).toEqual({ kind: "cold", reason: "first-request", writeTokens: 50_000 });
		expect(isCacheHealthy(verdict)).toBe(true);
	});

	/**
	 * Below the provider's floor nothing is cacheable, so a miss carries no
	 * information. Checked at the boundary, because an off-by-one here either
	 * fails tiny prompts or stops judging real ones.
	 */
	it("excuses a prompt under the cacheable floor, and judges one at it", () => {
		const under = verifyCacheUsage(warmRequest(), usage(MIN_CACHEABLE_TOKENS - 1, 0, 0));
		expect(under).toEqual({ kind: "cold", reason: "below-minimum", writeTokens: 0 });

		// Exactly at the floor is cacheable, so the same miss becomes a rejection.
		const at = verifyCacheUsage(warmRequest(), usage(MIN_CACHEABLE_TOKENS, 0, 0));
		expect(at.kind).toBe("rejected");
	});

	/**
	 * A gap longer than the retention window is an expiry, not a defect. This is
	 * the exemption that matters most in practice: an agent that sat waiting on a
	 * long tool call, a daemon, or a human comes back to a legitimately cold
	 * cache, and failing there would punish the user for thinking.
	 */
	it("excuses a gap longer than the retention window, per retention", () => {
		const shortGap = verifyCacheUsage(
			warmRequest({ retention: "short", msSincePreviousRequest: CACHE_TTL_MS.short + 1 }),
			usage(50_000, 0, 50_000),
		);
		expect(shortGap).toEqual({ kind: "cold", reason: "window-expired", writeTokens: 50_000 });

		// The same gap is well inside the long window, so it is NOT excused there:
		// with a write it is prefix churn, which is a different finding.
		const longRetention = verifyCacheUsage(
			warmRequest({ retention: "long", msSincePreviousRequest: CACHE_TTL_MS.short + 1 }),
			usage(50_000, 0, 50_000),
		);
		expect(longRetention.kind).toBe("invalidated");

		const longGap = verifyCacheUsage(
			warmRequest({ retention: "long", msSincePreviousRequest: CACHE_TTL_MS.long + 1 }),
			usage(50_000, 0, 50_000),
		);
		expect(longGap).toEqual({ kind: "cold", reason: "window-expired", writeTokens: 50_000 });
	});

	/**
	 * The check stops accusing BEFORE the nominal boundary, and that margin is the
	 * point rather than a rounding detail.
	 *
	 * The window belongs to the provider: it is measured on the provider's clock,
	 * Anthropic refreshes it on every cache HIT rather than every request so its
	 * start moves where no client can see, and an entry can be evicted early under
	 * load. Comparing against the nominal TTL would therefore call a real expiry a
	 * rejection near the edge — and with blocking enabled that halts a working
	 * session for something unobservable. The margin trades a missed finding, which
	 * the record still shows, for never doing that.
	 */
	it("stops accusing a fifth of the way before the nominal boundary", () => {
		const grace = cacheWindowGraceMs("short");
		expect(grace).toBe(CACHE_TTL_MS.short * CACHE_WINDOW_GRACE);
		expect(grace).toBeLessThan(CACHE_TTL_MS.short);

		// Just past the grace threshold but still WELL INSIDE the nominal five
		// minutes: excused. Before the margin existed this was a `rejected`.
		const justPastGrace = verifyCacheUsage(
			warmRequest({ retention: "short", msSincePreviousRequest: grace + 1 }),
			usage(50_000, 0, 0),
		);
		expect(justPastGrace).toEqual({ kind: "cold", reason: "window-expired", writeTokens: 0 });

		// Just inside it: still judged, so the margin cannot be widened into
		// switching the check off.
		const justInsideGrace = verifyCacheUsage(
			warmRequest({ retention: "short", msSincePreviousRequest: grace - 1 }),
			usage(50_000, 0, 0),
		);
		expect(justInsideGrace.kind).toBe("rejected");
	});

	/** The margin scales with the retention it belongs to, so a one-hour window
	 *  keeps judging for the first 48 minutes rather than the first four. */
	it("scales the margin with the retention", () => {
		expect(cacheWindowGraceMs("long")).toBe(CACHE_TTL_MS.long * CACHE_WINDOW_GRACE);
		const insideLong = verifyCacheUsage(
			warmRequest({ retention: "long", msSincePreviousRequest: cacheWindowGraceMs("short") + 1 }),
			usage(50_000, 0, 0),
		);
		expect(insideLong.kind).toBe("rejected");
	});

	/**
	 * An unknown gap must not excuse anything. Treating "I don't know how long it
	 * has been" as "it expired" would silently disable the check on every caller
	 * that does not track request times.
	 */
	it("does not excuse a miss when the gap is unknown", () => {
		const verdict = verifyCacheUsage(warmRequest({ msSincePreviousRequest: undefined }), usage(50_000, 0, 0));
		expect(verdict.kind).toBe("rejected");
	});

	/** Caching that was never asked for cannot fail. Both spellings of "off". */
	it("says nothing was requested when no anchors were placed or retention is none", () => {
		expect(verifyCacheUsage(warmRequest({ anchors: 0 }), usage(50_000, 0, 0))).toEqual({ kind: "not-requested" });
		expect(verifyCacheUsage(warmRequest({ retention: "none" }), usage(50_000, 0, 0))).toEqual({
			kind: "not-requested",
		});
		expect(isCacheHealthy({ kind: "not-requested" })).toBe(true);
	});
});

describe("the rejection this module exists to catch", () => {
	/**
	 * The exact shape of the shipped defects: markers on the wire, a large
	 * prompt, a warm key, an open window, and the provider reporting neither a
	 * read nor a write. Caching cannot behave that way when it works, so this is
	 * the one verdict that is allowed to fail a run.
	 */
	it("reports a rejection when the provider neither read nor wrote", () => {
		const verdict = verifyCacheUsage(warmRequest(), usage(67_528, 0, 0));
		expect(verdict).toEqual({ kind: "rejected", totalInputTokens: 67_528, anchors: 4 });
		expect(isCacheHealthy(verdict)).toBe(false);
		expect(isEnforceableFailure(verdict)).toBe(true);
		expect(describeCacheVerdict(verdict)).toContain("was NOT accepted");
		expect(describeCacheVerdict(verdict)).toContain("67528");
	});

	/**
	 * Prefix churn is a DIFFERENT finding and must not be conflated: the provider
	 * honoured the markers and wrote an entry, but what we asked it to cache had
	 * changed. Failing here would fire on an edited transcript or a rolled window,
	 * which is why only `rejected` is enforceable.
	 */
	it("separates prefix churn from a rejection", () => {
		const verdict = verifyCacheUsage(warmRequest(), usage(0, 0, 67_528));
		expect(verdict).toEqual({ kind: "invalidated", writeTokens: 67_528, totalInputTokens: 67_528 });
		expect(isCacheHealthy(verdict)).toBe(false);
		expect(isEnforceableFailure(verdict)).toBe(false);
		expect(describeCacheVerdict(verdict)).toContain("prefix changed");
	});
});

describe("providers that do not report cache writes", () => {
	/**
	 * OpenAI-family surfaces report `cached_tokens` and nothing about writes, so a
	 * working-but-cold turn and an ignored marker look identical. Guessing either
	 * way is wrong: a false rejection halts a healthy session, and calling it
	 * healthy hides the Codex defect. It is reported as unattributable instead.
	 */
	it("reports a miss as unverifiable rather than guessing", () => {
		const verdict = verifyCacheUsage(warmRequest({ reportsCacheWrites: false }), usage(50_000, 0, 0));
		expect(verdict).toEqual({ kind: "unverifiable", totalInputTokens: 50_000 });
		expect(isCacheHealthy(verdict)).toBe(false);
		expect(isEnforceableFailure(verdict)).toBe(false);
	});

	/**
	 * Unless the key itself vouches for the cache: a key that demonstrably read
	 * from cache before and now reads nothing IS provable without write
	 * reporting. This is what catches an OpenAI-side regression mid-session.
	 */
	it("does prove a rejection when the same key has read from cache before", () => {
		const verdict = verifyCacheUsage(
			warmRequest({ reportsCacheWrites: false, previousReadTokens: 40_000 }),
			usage(50_000, 0, 0),
		);
		expect(verdict.kind).toBe("rejected");
		expect(isEnforceableFailure(verdict)).toBe(true);
	});
});

describe("a cache that got worse", () => {
	/**
	 * Halving is the unambiguous signal that the prefix moved; small drops are
	 * ordinary turn-to-turn movement and must not be reported, or the operator
	 * learns to ignore the warning.
	 */
	it("reports a read that collapsed against the previous turn on the key", () => {
		const verdict = verifyCacheUsage(warmRequest({ previousReadTokens: 40_000 }), usage(30_000, 10_000, 0));
		expect(verdict).toEqual({
			kind: "degraded",
			readTokens: 10_000,
			previousReadTokens: 40_000,
			shortfall: 30_000,
		});
		expect(isEnforceableFailure(verdict)).toBe(false);
	});

	it("ignores an ordinary drop, and a previous turn too small to compare against", () => {
		expect(verifyCacheUsage(warmRequest({ previousReadTokens: 40_000 }), usage(500, 39_000, 0)).kind).toBe("ok");
		// A previous read at or below the floor carries no signal to compare with.
		expect(verifyCacheUsage(warmRequest({ previousReadTokens: MIN_CACHEABLE_TOKENS }), usage(500, 10, 0)).kind).toBe(
			"ok",
		);
	});
});

describe("enforcement decides what to do about a verdict", () => {
	/** `off` is silent even on a provable rejection: the operator opted out. */
	it("stays silent when enforcement is off", () => {
		const rejected = verifyCacheUsage(warmRequest(), usage(50_000, 0, 0));
		expect(decideCacheEnforcement(rejected, "off")).toEqual({ report: false, failNext: false });
	});

	/** `warn` reports every unhealthy verdict and fails on none. */
	it("reports without failing when enforcement is warn", () => {
		for (const u of [usage(50_000, 0, 0), usage(0, 0, 50_000), usage(30_000, 10_000, 0)]) {
			const verdict = verifyCacheUsage(warmRequest({ previousReadTokens: 40_000 }), u);
			expect(decideCacheEnforcement(verdict, "warn")).toEqual({ report: true, failNext: false });
		}
	});

	/**
	 * `error` fails only on the provable verdict. Pinned per verdict kind because
	 * widening this set is how the check would start halting healthy sessions.
	 */
	it("fails only on a provable rejection when enforcement is error", () => {
		const rejected = verifyCacheUsage(warmRequest(), usage(50_000, 0, 0));
		expect(decideCacheEnforcement(rejected, "error")).toEqual({ report: true, failNext: true });

		const churn = verifyCacheUsage(warmRequest(), usage(0, 0, 50_000));
		expect(decideCacheEnforcement(churn, "error")).toEqual({ report: true, failNext: false });

		const unverifiable = verifyCacheUsage(warmRequest({ reportsCacheWrites: false }), usage(50_000, 0, 0));
		expect(decideCacheEnforcement(unverifiable, "error")).toEqual({ report: true, failNext: false });

		const healthy = verifyCacheUsage(warmRequest(), usage(500, 49_500, 0));
		expect(decideCacheEnforcement(healthy, "error")).toEqual({ report: false, failNext: false });
	});

	/** The error names the surface, because every shipped defect was one surface
	 *  misbehaving while the others were fine, and says how to proceed anyway. */
	it("names the provider, the model and the way out in the failure", () => {
		const rejected = verifyCacheUsage(warmRequest(), usage(67_528, 0, 0));
		const error = new CacheRejectedError(rejected, "openai-codex", "gpt-5.6-codex");
		expect(error.name).toBe("CacheRejectedError");
		expect(error.message).toContain("openai-codex/gpt-5.6-codex");
		expect(error.message).toContain("67528");
		expect(error.message).toContain('cache.enforcement to "warn"');
		expect(error.verdict).toBe(rejected);
	});
});

describe("verdict descriptions", () => {
	/** Every branch must produce a line an operator can act on; a missing case
	 *  would surface as `undefined` in a log at the moment it mattered most. */
	it("describes every verdict kind with its numbers", () => {
		const cases = [
			verifyCacheUsage(warmRequest({ anchors: 0 }), usage(10, 0, 0)),
			verifyCacheUsage(warmRequest(), usage(500, 49_500, 0)),
			verifyCacheUsage(warmRequest({ firstRequest: true }), usage(50_000, 0, 50_000)),
			verifyCacheUsage(warmRequest(), usage(0, 0, 50_000)),
			verifyCacheUsage(warmRequest({ previousReadTokens: 40_000 }), usage(30_000, 10_000, 0)),
			verifyCacheUsage(warmRequest(), usage(50_000, 0, 0)),
			verifyCacheUsage(warmRequest({ reportsCacheWrites: false }), usage(50_000, 0, 0)),
		];
		const kinds = cases.map(verdict => verdict.kind);
		expect(kinds).toEqual(["not-requested", "ok", "cold", "invalidated", "degraded", "rejected", "unverifiable"]);
		for (const verdict of cases) {
			const line = describeCacheVerdict(verdict);
			expect(line.length).toBeGreaterThan(10);
			expect(line).not.toContain("undefined");
		}
	});
});

describe("resolving the enforcement level", () => {
	/**
	 * Reporting, not blocking, is the default. The two mistakes cost differently:
	 * a missed rejection costs money and leaves a record, a wrong rejection stops
	 * a session that was working. Since the verdict is proven against provider
	 * usage REPORTING, a provider that changes what it reports would turn a
	 * default of `error` into an outage — so blocking is opt-in.
	 */
	it("defaults to warn, so a new install never blocks", () => {
		const saved = process.env.VEYYON_CACHE_ENFORCEMENT;
		delete process.env.VEYYON_CACHE_ENFORCEMENT;
		try {
			expect(resolveCacheEnforcement()).toBe("warn");
		} finally {
			if (saved === undefined) delete process.env.VEYYON_CACHE_ENFORCEMENT;
			else process.env.VEYYON_CACHE_ENFORCEMENT = saved;
		}
	});

	/** An explicit per-request value wins over the environment, so a caller that
	 *  knows better than the machine default is not overridden by it. */
	it("prefers an explicit value over the environment", () => {
		const saved = process.env.VEYYON_CACHE_ENFORCEMENT;
		process.env.VEYYON_CACHE_ENFORCEMENT = "off";
		try {
			expect(resolveCacheEnforcement("error")).toBe("error");
		} finally {
			if (saved === undefined) delete process.env.VEYYON_CACHE_ENFORCEMENT;
			else process.env.VEYYON_CACHE_ENFORCEMENT = saved;
		}
	});

	/** A misspelled level must fall back to the safe default rather than being
	 *  read as "off", which would silently disable the check. */
	it("falls back to warn for an unrecognised value", () => {
		const saved = process.env.VEYYON_CACHE_ENFORCEMENT;
		process.env.VEYYON_CACHE_ENFORCEMENT = "block";
		try {
			expect(resolveCacheEnforcement()).toBe("warn");
		} finally {
			if (saved === undefined) delete process.env.VEYYON_CACHE_ENFORCEMENT;
			else process.env.VEYYON_CACHE_ENFORCEMENT = saved;
		}
	});
});
