/**
 * Whether a one-hour cache entry is cheaper than a five-minute one is a property
 * of the GAPS between turns, not of the code. This scenario finds the break-even
 * instead of asserting a preference.
 *
 * WHY THIS FILE EXISTS. The reasoning that reaches for a longer TTL is "a miss
 * costs the whole prompt, so retain longer". It is incomplete in a way that is
 * invisible until it is priced: an hour of retention is bought by paying 2.0x the
 * base input price on EVERY write instead of 1.25x, on every turn, whether or not
 * the extra lifetime is ever used. A session whose turns are seconds apart pays
 * that premium 100% of the time and collects on it 0% of the time.
 *
 * This repo has been wrong on this in both directions inside one investigation:
 * first that the five-minute default was a defect (it is the cheaper policy on
 * fast turns), then that the one-hour default was (it pays for itself once enough
 * gaps exceed five minutes). Both claims were reasoned. Neither was priced. So the
 * scenario asserts the SHAPE of the trade — cheap gaps favour 5m, slow gaps favour
 * 1h, and the crossing is monotone between them — which is the thing that stays
 * true when the prices change, and it reports the crossing so a switch can be
 * argued from a number.
 *
 * WHAT THIS DOES NOT CATCH.
 *   - Rate limits and subscription quotas. On an OAuth plan the "cost" of a write
 *     is not billed in currency at all, and a policy that is more expensive in
 *     token-equivalents may still be the right one. This file prices tokens.
 *   - Anthropic refreshes an entry's lifetime when it is read, which is modelled,
 *     but not the undocumented details of how a mixed-ttl request is accounted.
 *     `normalizeCacheControlTtlOrdering` exists because that ordering matters, and
 *     a single-retention arm never exercises it.
 *
 * RED PROOFS, observed rather than predicted.
 *   - `PRICE.write1h` set equal to `PRICE.write5m`: the fast-gap row reds, since
 *     the premium is the only reason 5m wins there.
 *   - the modelled TTL for "short" raised to an hour: the slow-gap row reds, which
 *     is what says that row is about expiry and not about the price table.
 */
import { describe, expect, it } from "bun:test";
import { growingSession, LONG_RETENTION, PRICE, runArm, SHORT_RETENTION, type Step, TTL_MS } from "./harness";

const TURNS = 8;

/** A run whose turns are `gapMs` apart, the shape every row varies. */
function pacedSession(gapMs: number): Step[] {
	return growingSession({ turns: TURNS, gapMs });
}

/** What the two retention policies cost over one pacing. */
async function priceBoth(gapMs: number): Promise<{ short: number; long: number }> {
	const short = await runArm(SHORT_RETENTION, pacedSession(gapMs));
	const long = await runArm(LONG_RETENTION, pacedSession(gapMs));
	return { short: short.cost, long: long.cost };
}

describe("pricing a retention switch", () => {
	/**
	 * The agentic case, and the overwhelming majority of real turns: the next
	 * request goes out seconds after the last. Every entry is still live under
	 * either policy, so the longer TTL buys nothing and charges 1.6x for it.
	 */
	it("favours five minutes when turns are seconds apart", async () => {
		const { short, long } = await priceBoth(20_000);

		expect(short).toBeLessThan(long);
	});

	/**
	 * The opposite regime: every gap exceeds five minutes, so a five-minute entry
	 * is always dead on arrival and the whole prompt is re-written each turn.
	 */
	it("favours one hour when every gap outlives a five-minute entry", async () => {
		const { short, long } = await priceBoth(TTL_MS.short + 60_000);

		expect(long).toBeLessThan(short);
	});

	/**
	 * A gap longer than an hour is not an argument for either: both entries are
	 * gone, and the longer retention has merely charged more to store what expired.
	 * This is the row that stops "longer is safer" from being the conclusion.
	 */
	it("favours five minutes again once gaps outlive an hour", async () => {
		const { short, long } = await priceBoth(TTL_MS.long + 60_000);

		expect(short).toBeLessThan(long);
	});

	/**
	 * And the crossing itself, reported rather than assumed. Sweeping the pacing
	 * across the five-minute boundary must flip the winner exactly once: a policy
	 * question with a single crossing can be decided by measuring one number about
	 * a workload, which is what makes the switch decidable at all.
	 */
	it("crosses over exactly once as turns slow down", async () => {
		const pacings = [10_000, 60_000, 120_000, 240_000, 290_000, 330_000, 600_000, 1_800_000];
		const winners: string[] = [];
		for (const gapMs of pacings) {
			const { short, long } = await priceBoth(gapMs);
			winners.push(short <= long ? "5m" : "1h");
		}
		const flips = winners.filter((winner, index) => index > 0 && winner !== winners[index - 1]).length;

		expect(winners[0]).toBe("5m");
		expect(winners.at(-1)).toBe("1h");
		expect(flips).toBe(1);
	});

	/**
	 * The premium is the whole mechanism, so it is pinned: a future price table
	 * that makes one-hour writes free would invalidate every row above, and this is
	 * the row that says so out loud rather than letting them quietly become
	 * tautologies.
	 */
	it("prices a one-hour write above a five-minute one", () => {
		expect(PRICE.write1h).toBeGreaterThan(PRICE.write5m);
		expect(PRICE.read).toBeLessThan(PRICE.input);
	});
});
