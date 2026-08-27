/**
 * WHY: a gateway status the transport classifier calls transient reached
 * `parseRateLimitReason`, matched no branch, and came back `UNKNOWN` — whose
 * backoff is the conservative long park.
 *
 * `HTTP 502 Bad Gateway` and `HTTP 504 Gateway Timeout` say what `500` says: an
 * upstream broke or timed out, and the next attempt reaches a peer that may not
 * have. `SERVER_ERROR_STATUS_PATTERN` listed `500` alone, so the other two fell
 * through every branch to `UNKNOWN`. `#noteRetryFallbackCooldown` in
 * `agent-session.ts` reads that reason and suppressed the failing selector for
 * five minutes, and `calculateRateLimitBackoffMs`'s own default is thirty — a
 * blip that clears in seconds parked the model instead.
 *
 * THE CLASS is the third instance of one mistake: a status the product already
 * decided is transient, read here by a rule that enumerates statuses by hand and
 * missed some. The first was `lower.includes("503")` firing inside `5030 credits
 * remaining`; the second was the llama.cpp explanation gated on a provider id.
 * Every one was a second, narrower copy of a judgement made somewhere else.
 *
 * It closes by DERIVING the sweep from the owner of that judgement rather than
 * restating it: `TRANSIENT_TRANSPORT_PATTERN` in `domains/network.ts` is the one
 * list of statuses the product calls transient, and every status in it must get a
 * named, bounded reason here. Adding `598` there and nowhere else turns this red.
 *
 * WHAT THIS DOES NOT CATCH. It sweeps statuses, not prose: a transient phrase
 * ("upstream connect error") that reaches `parseRateLimitReason` with no number
 * still returns `UNKNOWN`, which is the deliberate answer for a body the rules
 * cannot read. Nor does it fix the two owners of what `UNKNOWN` costs —
 * `calculateRateLimitBackoffMs` says thirty minutes and the selector-cooldown
 * call site overrides it to five; both are still reachable and are recorded here
 * as the bound, not endorsed.
 */
import { describe, expect, it } from "bun:test";
import { TRANSIENT_TRANSPORT_PATTERN } from "@veyyon/ai/error/domains/network";
import { calculateRateLimitBackoffMs, parseRateLimitReason } from "@veyyon/ai/error/rate-limit";

/**
 * The statuses the transport classifier calls transient, read off the pattern that owns them.
 *
 * The pattern spells them as one boundary-guarded alternation, `(?:429|500|502|503|504)`, which is
 * the only run of three-digit alternatives in it. Extracting rather than restating is the point: a
 * status added there is swept here without anyone remembering to.
 */
function transientStatusesFromOwner(): number[] {
	const alternation = /\(\?:((?:\d{3})(?:\|\d{3})+)\)/.exec(TRANSIENT_TRANSPORT_PATTERN.source);
	if (!alternation) throw new Error("TRANSIENT_TRANSPORT_PATTERN no longer spells its statuses as one alternation");
	return alternation[1].split("|").map(Number);
}

/** The reason a body the rules could not read at all comes back as. */
const UNREADABLE = "UNKNOWN";

/** Longest wait a single transient status may cost before it stops being a retry. */
const BOUND_MS = 90_000;

/**
 * The one transient status that is allowed to come back unreadable, and why.
 *
 * A bare 429 does not say whether the allowance is spent or the request merely arrived too fast, and
 * the quota family answers it as a wall for exactly that reason — see `classifyBareStatus` in
 * `flags.ts` and `isOpaqueStatusBody` here. The conservative park is the right cost for a wall, so
 * 429 opts out. Pinned by exact equality: a second status going unreadable is a defect, not a row
 * to add here without saying why.
 */
const OPAQUE_BY_DESIGN = [429];

describe("every transient status costs a bounded wait, not a conservative park", () => {
	const statuses = transientStatusesFromOwner();

	it("reads the status list off the pattern that owns it", () => {
		// A sweep over nothing passes silently, so the extraction is asserted before it is used.
		expect(statuses.length).toBeGreaterThanOrEqual(5);
		expect(statuses).toContain(502);
		expect(statuses).toContain(504);
	});

	it("leaves exactly the statuses that carry no meaning of their own unreadable", () => {
		const unreadable = statuses.filter(s => parseRateLimitReason(`HTTP ${s}: upstream failure`) === UNREADABLE);

		expect(unreadable).toEqual(OPAQUE_BY_DESIGN);
	});

	for (const status of statuses.filter(s => !OPAQUE_BY_DESIGN.includes(s))) {
		it(`names a bounded reason for a bare HTTP ${status}`, () => {
			const reason = parseRateLimitReason(`HTTP ${status}: upstream failure`);

			expect(reason).not.toBe(UNREADABLE);
			expect(calculateRateLimitBackoffMs(reason)).toBeLessThanOrEqual(BOUND_MS);
		});
	}

	it("puts the gateway statuses in the same bucket as 500, which makes the same claim", () => {
		expect(parseRateLimitReason("HTTP 502 Bad Gateway")).toBe("SERVER_ERROR");
		expect(parseRateLimitReason("HTTP 504 Gateway Timeout")).toBe("SERVER_ERROR");
		expect(parseRateLimitReason("500 upstream failure")).toBe("SERVER_ERROR");
	});

	/**
	 * The mistake this class is made of, in its original form. Widening the alternation must not
	 * widen it into digits that are somebody else's number, which is how `5030 credits remaining`
	 * became a capacity backoff instead of a credential rotation.
	 */
	it("reads a gateway status named in prose, not one buried in a longer number", () => {
		expect(parseRateLimitReason("request id 5021 failed")).toBe(UNREADABLE);
		expect(parseRateLimitReason("request id 15020 failed")).toBe(UNREADABLE);
		expect(parseRateLimitReason("consumed 5040 tokens")).toBe(UNREADABLE);
		expect(parseRateLimitReason("request id 25040 failed")).toBe(UNREADABLE);
	});

	/**
	 * The opposite error. A quota wall named alongside a gateway status is still a quota wall: the
	 * long park is correct there, and routing it to a twenty-second retry would hammer a spent
	 * credential. Branch order is what decides it, so it is pinned.
	 */
	it("keeps a quota wall a quota wall when the body also names a gateway status", () => {
		expect(parseRateLimitReason("HTTP 502: usage limit reached for this account")).toBe("QUOTA_EXHAUSTED");
		expect(parseRateLimitReason("HTTP 504: insufficient balance")).toBe("QUOTA_EXHAUSTED");
	});
});
