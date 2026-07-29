import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";

/**
 * `SecretObfuscator.namedSecretNames()` is the source of the credential inventory the model is
 * shown in its system prompt, so its ORDER is a contract and not an implementation detail.
 *
 * The method previously returned names in `Map` insertion order, which is the order the vault
 * happened to load them in. That is stable enough for its original caller (reconciling the live
 * runtime against the vault does not care about order) and quietly wrong for the new one: the
 * system prompt is re-rendered on every `refreshSecrets()`, and a section whose bytes reshuffle
 * between rebuilds invalidates the provider's prompt cache for no behavioral reason at all.
 *
 * These cases exist because the coverage that already exists cannot see the difference. Every
 * prior assertion is either single-element (`["SURVIVOR_TOKEN"]`), empty, or a length check, so
 * all of them pass whether or not the result is sorted. A regression here would be invisible.
 */

const KEY = new Uint8Array(32).fill(17);

/** Long enough to be obfuscatable; the values are irrelevant to ordering and must never leak. */
const VALUES = {
	zulu: "zulu-secret-value-000000",
	alpha: "alpha-secret-value-00000",
	mike: "mike-secret-value-000000",
	underscored: "underscored-value-00000",
	bare: "bare-secret-value-000000",
} as const;

describe("the credential inventory shown to the model", () => {
	/**
	 * The core contract. Names are handed in deliberately reverse-alphabetically, so an
	 * implementation that returns insertion order fails and one that sorts passes.
	 */
	it("returns names in sorted order regardless of the order they were loaded in", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", origin: "config", content: VALUES.zulu, name: "ZULU_TOKEN" },
				{ type: "plain", origin: "config", content: VALUES.mike, name: "MIKE_TOKEN" },
				{ type: "plain", origin: "config", content: VALUES.alpha, name: "ALPHA_TOKEN" },
			],
			{ placeholderKey: KEY },
		);

		expect(obfuscator.namedSecretNames()).toEqual(["ALPHA_TOKEN", "MIKE_TOKEN", "ZULU_TOKEN"]);
	});

	/**
	 * The property the prompt cache actually depends on: two reads of an unchanged runtime must be
	 * byte-identical. Asserting sortedness alone would not catch a future implementation that
	 * sorted into a fresh array each call but with a comparator reading mutable state.
	 */
	it("gives byte-identical answers across repeated reads of an unchanged runtime", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", origin: "config", content: VALUES.zulu, name: "ZULU_TOKEN" },
				{ type: "plain", origin: "config", content: VALUES.alpha, name: "ALPHA_TOKEN" },
			],
			{ placeholderKey: KEY },
		);

		expect(obfuscator.namedSecretNames().join("\n")).toBe(obfuscator.namedSecretNames().join("\n"));
	});

	/**
	 * Pins the comparator against the character set names are actually drawn from. `_` is 0x5F and
	 * sorts AFTER every uppercase letter (0x41-0x5A), so `AB_TOKEN` precedes `A_B_TOKEN`. Left
	 * unpinned, a later switch to `localeCompare` would silently reorder the inventory, since ICU
	 * collation ignores punctuation at the primary level and would flip exactly this pair.
	 */
	it("orders underscores by code unit, so a locale-aware comparator cannot silently replace it", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", origin: "config", content: VALUES.underscored, name: "A_B_TOKEN" },
				{ type: "plain", origin: "config", content: VALUES.bare, name: "AB_TOKEN" },
			],
			{ placeholderKey: KEY },
		);

		expect(obfuscator.namedSecretNames()).toEqual(["AB_TOKEN", "A_B_TOKEN"]);
	});

	/**
	 * The inventory carries names so the model can pick a credential. It must never carry the
	 * credential. Asserted against the real stored values rather than a shape check, because a
	 * leak here would put a live secret into the system prompt of every request.
	 */
	it("never returns a stored value alongside the names", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", origin: "config", content: VALUES.zulu, name: "ZULU_TOKEN" },
				{ type: "plain", origin: "config", content: VALUES.alpha, name: "ALPHA_TOKEN" },
			],
			{ placeholderKey: KEY },
		);

		const rendered = obfuscator.namedSecretNames().join("\n");
		expect(rendered).not.toContain(VALUES.zulu);
		expect(rendered).not.toContain(VALUES.alpha);
	});

	/**
	 * Unnamed secrets are protected under an opaque HMAC placeholder and have no name to show, so
	 * they must not reach the inventory. The two forms are separated by their first body character
	 * (a name starts with a letter, a value placeholder with `0`), and this is the case that proves
	 * the filter is applied rather than assumed.
	 */
	it("lists only named secrets, never the opaque value placeholders", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", origin: "config", content: VALUES.alpha, name: "ALPHA_TOKEN" },
				{ type: "plain", origin: "config", content: VALUES.mike },
			],
			{ placeholderKey: KEY },
		);

		expect(obfuscator.namedSecretNames()).toEqual(["ALPHA_TOKEN"]);
	});

	/**
	 * Sorting must not resurrect a name whose deadline has passed. `namedSecretNames` forgets
	 * expired entries before answering, and the inventory is what tells the model a credential is
	 * spendable, so an expired name appearing here would advertise a placeholder that no longer
	 * expands. Driven by the injected clock, never a real sleep.
	 */
	it("drops an expired name while keeping the survivors sorted", () => {
		let now = 0;
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", origin: "config", content: VALUES.zulu, name: "ZULU_TOKEN", expiresAt: 10 },
				{ type: "plain", origin: "config", content: VALUES.alpha, name: "ALPHA_TOKEN" },
				{ type: "plain", origin: "config", content: VALUES.mike, name: "MIKE_TOKEN" },
			],
			{ placeholderKey: KEY, now: () => now },
		);
		expect(obfuscator.namedSecretNames()).toEqual(["ALPHA_TOKEN", "MIKE_TOKEN", "ZULU_TOKEN"]);

		now = 10;

		expect(obfuscator.namedSecretNames()).toEqual(["ALPHA_TOKEN", "MIKE_TOKEN"]);
	});
});
