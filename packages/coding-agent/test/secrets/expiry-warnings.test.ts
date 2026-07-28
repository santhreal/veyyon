/**
 * Warning the operator before a credential's lifetime runs out.
 *
 * WHY THIS SUITE EXISTS. Every entry expires, and expiry DELETES the value, so a warning is the
 * only thing standing between "my token lasted a day as I asked" and "the deploy failed and I do
 * not know why". The feature had every part except the part that matters: `WARN_AT_FRACTIONS` was
 * defined, `warningThresholdCrossed` was implemented and tested, and `expiryWarnings` existed with
 * NO PRODUCTION CONSUMER at all. Nothing was ever raised.
 *
 * Worse, `expiryWarnings` compared against an inline `0.9` while `WARN_AT_FRACTIONS` said
 * `[0.5, 0.9]`, so there were two owners of "when do we warn" and they disagreed: the halfway
 * warning could not fire even once something did start calling it. This suite pins the single
 * owner, both thresholds, and the fact that a warning names the action that prevents the loss.
 */
import { describe, expect, it } from "bun:test";
import { expiryWarnings } from "@veyyon/coding-agent/secrets/secret-command";
import { type ScopedVaultEntry, WARN_AT_FRACTIONS } from "@veyyon/coding-agent/secrets/vault";

const DAY = 24 * 60 * 60 * 1000;
const CREATED = 1_000_000;

function entry(overrides?: Partial<ScopedVaultEntry>): ScopedVaultEntry {
	return {
		name: "GITHUB_TOKEN",
		value: "ghp_something_long_enough",
		createdAt: CREATED,
		expiresAt: CREATED + DAY,
		scope: "profile",
		...overrides,
	};
}

describe("when a warning is raised", () => {
	/** Nothing early in a lifetime: a warning at 10% would be noise for the other 90%. */
	it("says nothing early in the lifetime", () => {
		expect(expiryWarnings([entry()], CREATED + DAY * 0.1)).toEqual([]);
		expect(expiryWarnings([entry()], CREATED + DAY * 0.49)).toEqual([]);
	});

	/**
	 * THE HALFWAY WARNING, which the inline `0.9` made unreachable.
	 *
	 * `WARN_AT_FRACTIONS` has listed 0.5 the whole time. This is the assertion that the list is now
	 * actually the thing being consulted.
	 */
	it("warns at the halfway point", () => {
		const warnings = expiryWarnings([entry()], CREATED + DAY * 0.5);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("over halfway");
	});

	/** And again, more urgently, near the end. */
	it("warns more urgently near expiry", () => {
		const warnings = expiryWarnings([entry()], CREATED + DAY * 0.9);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("expires soon");
		expect(warnings[0]).not.toContain("halfway");
	});

	/** One owner: every fraction in the list is reachable, so adding one needs no second edit. */
	it("has a warning for every declared threshold", () => {
		for (const fraction of WARN_AT_FRACTIONS) {
			expect(expiryWarnings([entry()], CREATED + DAY * fraction)).toHaveLength(1);
		}
	});

	/** A secret that never expires is never warned about, because there is nothing to warn of. */
	it("says nothing about a secret that never expires", () => {
		expect(expiryWarnings([entry({ expiresAt: null })], Number.MAX_SAFE_INTEGER)).toEqual([]);
	});

	/**
	 * FRACTIONAL, so one rule serves every lifetime.
	 *
	 * An absolute rule such as "24 hours left" is useless for a one-day secret and far too late for
	 * a 90-day one. A 90-day secret is warned about at day 45, not on day 89.
	 */
	it("scales to a long lifetime", () => {
		const long = entry({ expiresAt: CREATED + 90 * DAY });

		expect(expiryWarnings([long], CREATED + 44 * DAY)).toEqual([]);
		expect(expiryWarnings([long], CREATED + 45 * DAY)[0]).toContain("over halfway");
		expect(expiryWarnings([long], CREATED + 81 * DAY)[0]).toContain("expires soon");
	});
});

describe("what a warning says", () => {
	/** The placeholder, so the operator knows which credential without guessing. */
	it("names the placeholder", () => {
		expect(expiryWarnings([entry({ name: "DEPLOY_KEY" })], CREATED + DAY * 0.95)[0]).toContain("#DEPLOY_KEY#");
	});

	/** How long is left, so the urgency is concrete. */
	it("says how long is left", () => {
		expect(expiryWarnings([entry()], CREATED + DAY * 0.9)[0]).toContain("2h left");
	});

	/**
	 * The remedy, with the actual command.
	 *
	 * A warning you cannot act on is noise. Expiry deletes the value, so the action has to be taken
	 * BEFORE it happens, which means the warning is the only place to put it.
	 */
	it("names the command that prevents the loss", () => {
		const warning = expiryWarnings([entry({ name: "DEPLOY_KEY" })], CREATED + DAY * 0.95)[0];

		expect(warning).toContain("/secret extend DEPLOY_KEY --ttl 7d");
		expect(warning).toContain("will be deleted");
	});

	/** No part of the value, ever, in a message written to a visible surface. */
	it("never includes the value", () => {
		const warning = expiryWarnings([entry({ value: "ghp_theActualCredential" })], CREATED + DAY * 0.95)[0];

		expect(warning).not.toContain("ghp_");
	});
});

describe("several secrets at once", () => {
	/** Only the ones that crossed a threshold, so the list stays worth reading. */
	it("warns about the ones that crossed a threshold and no others", () => {
		const warnings = expiryWarnings(
			[
				entry({ name: "FRESH_TOKEN", expiresAt: CREATED + 10 * DAY }),
				entry({ name: "OLD_TOKEN", expiresAt: CREATED + DAY }),
				entry({ name: "FOREVER_KEY", expiresAt: null }),
			],
			CREATED + DAY * 0.95,
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("#OLD_TOKEN#");
	});

	/** One line per secret, so two expiring secrets are two warnings rather than one merged one. */
	it("gives one warning per secret", () => {
		const warnings = expiryWarnings(
			[entry({ name: "TOKEN_ONE" }), entry({ name: "TOKEN_TWO" })],
			CREATED + DAY * 0.95,
		);

		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("#TOKEN_ONE#");
		expect(warnings[1]).toContain("#TOKEN_TWO#");
	});

	/** An empty vault produces nothing, so a session with no secrets is silent. */
	it("says nothing for an empty vault", () => {
		expect(expiryWarnings([], CREATED)).toEqual([]);
	});
});
