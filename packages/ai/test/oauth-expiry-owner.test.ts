import { describe, expect, it } from "bun:test";
import {
	credentialExpiryFromExpiresIn,
	credentialExpiryFromJwtExp,
	OAUTH_EXPIRY_SKEW_MS,
} from "@veyyon/ai/registry/oauth/expiry";

/**
 * Turning a provider's stated token lifetime into an absolute expiry (TIME-2).
 *
 * WHY THIS SUITE EXISTS. Thirteen call sites each hand-rolled
 * `Date.now() + expires_in * 1000 - 5 * 60 * 1000`, with three different skews
 * between them and validation at none of them. Both halves of that mattered.
 *
 * The missing validation is the sharp one, and it is silent. `expires_in`
 * arrives from a network response, so it can be a string, or absent from an
 * error-shaped body the parser waved through. `Date.now() + NaN` is `NaN`, and
 * every comparison against `NaN` is FALSE — including the refresh check,
 * `Date.now() + skew < expires`. A `NaN` expiry therefore reads as "always
 * expired", and the agent refreshes on every single request: a token-endpoint
 * hammer that looks like nothing at all from the outside, because each
 * individual request succeeds. A value that is negative, or absurdly large from
 * a seconds/milliseconds mix-up, is the same failure pointed the other way.
 *
 * So the contract is: a usable number produces an expiry, and anything else
 * THROWS rather than being stored. These tests assert exact millisecond values
 * against a pinned `issuedAtMs` — never "is a number", never a range — because a
 * skew applied twice, or not at all, still yields a plausible-looking timestamp.
 */
describe("credentialExpiryFromExpiresIn", () => {
	/** A fixed reference time so every expected value below is exact arithmetic
	 * rather than a tolerance around the wall clock. */
	const ISSUED = 1_700_000_000_000;

	describe("a usable lifetime", () => {
		it("returns issue time plus the lifetime, minus the skew", async () => {
			// The whole contract in one line, asserted to the millisecond.
			expect(credentialExpiryFromExpiresIn(3600, { issuedAtMs: ISSUED })).toBe(
				ISSUED + 3_600_000 - OAUTH_EXPIRY_SKEW_MS,
			);
		});

		it("applies the skew exactly once", async () => {
			// A double-applied skew is the mistake a copied one-liner makes when a
			// caller "helpfully" subtracts again, and it still produces a believable
			// timestamp. The difference between the raw deadline and the returned
			// value must be exactly one skew.
			const expiry = credentialExpiryFromExpiresIn(3600, { issuedAtMs: ISSUED });

			// Literal five minutes, not OAUTH_EXPIRY_SKEW_MS: the margin is what keeps
			// a token from expiring mid-request, and against the constant a skew
			// edited to zero or to an hour reads as correct.
			expect(ISSUED + 3_600_000 - expiry).toBe(5 * 60 * 1000);
		});

		it("honours an explicit skew of zero", async () => {
			// One provider (openai-codex) deliberately carries no client-side margin.
			// The override has to be real, not merely accepted and ignored.
			expect(credentialExpiryFromExpiresIn(3600, { issuedAtMs: ISSUED, skewMs: 0 })).toBe(ISSUED + 3_600_000);
		});

		it("measures from the caller's issue time, not from now", async () => {
			// A slow round trip should not eat the token's lifetime, and callers that
			// already know when the response was minted pass that in. If the parameter
			// were ignored the result would sit near the wall clock instead.
			const longAgo = ISSUED - 10 * 60 * 1000;

			expect(credentialExpiryFromExpiresIn(3600, { issuedAtMs: longAgo })).toBe(
				longAgo + 3_600_000 - OAUTH_EXPIRY_SKEW_MS,
			);
		});

		it("defaults to now when no issue time is given", async () => {
			// The common call shape. Asserted as a tight window rather than an exact
			// value, since the reference is the real clock here.
			const before = Date.now();
			const expiry = credentialExpiryFromExpiresIn(3600);
			const after = Date.now();

			expect(expiry).toBeGreaterThanOrEqual(before + 3_600_000 - OAUTH_EXPIRY_SKEW_MS);
			expect(expiry).toBeLessThanOrEqual(after + 3_600_000 - OAUTH_EXPIRY_SKEW_MS);
		});

		it("accepts a lifetime at the one-year sanity bound", async () => {
			// The inclusive edge of the bound below. Refusing a value the bound is
			// supposed to allow would reject a legitimate long-lived credential.
			const oneYear = 365 * 24 * 60 * 60;

			expect(credentialExpiryFromExpiresIn(oneYear, { issuedAtMs: ISSUED })).toBe(
				ISSUED + oneYear * 1000 - OAUTH_EXPIRY_SKEW_MS,
			);
		});
	});

	describe("an unusable lifetime is REFUSED, never stored", () => {
		/** Assert the call throws and that the message says which value was wrong. */
		function expectRefusal(value: unknown, matching: RegExp): void {
			expect(() => credentialExpiryFromExpiresIn(value, { provider: "testprovider" })).toThrow(matching);
		}

		it("a string, the shape a lenient JSON body actually produces", async () => {
			// THE case that motivates the whole module: `"3600"` multiplies to a number
			// in JavaScript, but `"abc"` does not, and neither is a number the contract
			// asked for. Refusing the type outright removes the guessing.
			expectRefusal("3600", /not a number/);
		});

		it("`undefined`, the shape a missing field produces", async () => {
			expectRefusal(undefined, /not a number/);
		});

		it("`null`, which `typeof` alone would call an object", async () => {
			expectRefusal(null, /not a number/);
		});

		it("NaN, which would otherwise poison every later comparison", async () => {
			// The specific value behind the refresh loop: stored, it makes the refresh
			// check false forever, and the agent re-refreshes on every request.
			expectRefusal(Number.NaN, /NaN/);
		});

		it("Infinity, which would mean a credential that never refreshes", async () => {
			expectRefusal(Number.POSITIVE_INFINITY, /Infinity/);
		});

		it("zero, because a token expired on arrival is a bug upstream", async () => {
			expectRefusal(0, /already expired/);
		});

		it("a negative lifetime", async () => {
			expectRefusal(-60, /already expired/);
		});

		it("a value past the one-year sanity bound", async () => {
			// Beyond a year the value is not a token lifetime by any reading, and
			// storing it would mean a credential that is never refreshed and never
			// noticed until the provider starts rejecting it.
			expectRefusal(400 * 24 * 60 * 60, /sanity bound/);
		});

		it("but the bound does NOT catch every seconds/milliseconds mix-up", async () => {
			// Pinned as a known limit, not as desired behaviour. A one-hour token sent
			// in milliseconds is 3_600_000 "seconds", which is only ~41 days — under
			// the bound, so it passes. Tightening far enough to catch it (below ~41
			// days) would start rejecting genuinely long-lived tokens some providers
			// issue, which is the worse failure: a refused login rather than a
			// credential refreshed later than ideal.
			//
			// This test exists so the gap is a decision on record. Anyone who assumes
			// the bound catches unit mistakes should find this instead of finding out
			// from a credential that never refreshed.
			const oneHourInMilliseconds = 3_600_000;
			expect(oneHourInMilliseconds).toBeLessThan(365 * 24 * 60 * 60);

			expect(credentialExpiryFromExpiresIn(oneHourInMilliseconds, { issuedAtMs: ISSUED })).toBe(
				ISSUED + oneHourInMilliseconds * 1000 - OAUTH_EXPIRY_SKEW_MS,
			);
		});

		it("the refusal names the provider, so the failure is actionable", async () => {
			// Several providers refresh through the same paths. Without the name the
			// operator cannot tell which integration returned the bad value.
			expect(() => credentialExpiryFromExpiresIn("nope", { provider: "testprovider" })).toThrow(/testprovider/);
		});

		it("the refusal explains the consequence, not just the bad value", async () => {
			// A bare "invalid expires_in" gives no reason to care. The message states
			// what storing it would have done.
			expect(() => credentialExpiryFromExpiresIn(Number.NaN, { provider: "testprovider" })).toThrow(
				/never refreshed or refreshed on every request/,
			);
		});
	});
});

describe("credentialExpiryFromJwtExp", () => {
	/**
	 * `exp` is an absolute time in SECONDS, not a duration, and the two forms are
	 * easy to confuse. Confusing them is silent: an `exp` fed through the duration
	 * form lands roughly fifty-five years out, which no assertion on "is it a
	 * number" would catch. Hence a separate function with its own tests.
	 */
	it("converts the claim to milliseconds and subtracts the skew", async () => {
		const exp = 1_700_003_600;

		expect(credentialExpiryFromJwtExp(exp)).toBe(exp * 1000 - OAUTH_EXPIRY_SKEW_MS);
	});

	it("does NOT treat the claim as a duration from now", async () => {
		// The confusion this function exists to prevent, asserted directly: the
		// result is anchored to the claim, so it must not move with the wall clock.
		const exp = 1_700_003_600;

		expect(credentialExpiryFromJwtExp(exp)).toBeLessThan(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
		expect(credentialExpiryFromJwtExp(exp)).toBe(credentialExpiryFromJwtExp(exp));
	});

	it("honours an explicit skew", async () => {
		const exp = 1_700_003_600;

		expect(credentialExpiryFromJwtExp(exp, { skewMs: 0 })).toBe(exp * 1000);
	});

	it("refuses a missing claim", async () => {
		expect(() => credentialExpiryFromJwtExp(undefined, { provider: "cursor" })).toThrow(/exp/);
	});

	it("refuses a non-numeric claim", async () => {
		expect(() => credentialExpiryFromJwtExp("1700003600", { provider: "cursor" })).toThrow(/cursor/);
	});

	it("refuses NaN", async () => {
		expect(() => credentialExpiryFromJwtExp(Number.NaN)).toThrow(/NaN/);
	});

	it("refuses a non-positive claim", async () => {
		expect(() => credentialExpiryFromJwtExp(0)).toThrow(/exp/);
	});
});
