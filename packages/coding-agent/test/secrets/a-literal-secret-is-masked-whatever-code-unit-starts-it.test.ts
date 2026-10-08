/**
 * A literal secret is masked at every occurrence, whatever code unit starts it.
 *
 * WHY THIS SUITE EXISTS. The literal matcher steps its root state through a 256-entry table for a
 * code unit below 256 and through a map for every other code unit, and it skips the scan when no
 * literal is configured. A literal that starts on the wrong side of that split, a failure
 * transition that falls back to the root on a code unit the table does not hold, or a skip that
 * fires for a configured trie would send the credential to the provider in the clear.
 *
 * The class it closes: a configured literal left unmasked because of the code unit it starts
 * with, the code unit a failure transition lands on, or where in the text it sits. Every case
 * asserts the exact masked text and the round trip back, so a literal masked at the wrong span
 * fails as well as one left in the clear.
 *
 * WHAT IT DOES NOT CATCH: literals longer than 256 code units scan by `indexOf` rather than the
 * trie, and only one case here reaches that path.
 */

import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";

const PLACEHOLDER_KEY = new Uint8Array(32).fill(29);

/** First code units on both sides of the root table's 256-entry limit, and a surrogate lead. */
const FIRST_UNITS: ReadonlyArray<readonly [string, string]> = [
	["ASCII", "a"],
	["LATIN_ONE", "\u00e9"],
	["LAST_TABLE", "\u00ff"],
	["FIRST_MAPPED", "\u0100"],
	["HAN", "\u65e5"],
	["EMOJI", "\u{1f600}"],
];

function obfuscatorFor(secrets: ReadonlyArray<readonly [string, string]>): SecretObfuscator {
	return new SecretObfuscator(
		secrets.map(([name, content]) => ({
			type: "plain" as const,
			origin: "config" as const,
			content,
			mode: "obfuscate" as const,
			name,
		})),
		{ placeholderKey: PLACEHOLDER_KEY },
	);
}

/** The text a correct matcher emits: every occurrence of each literal replaced by its placeholder. */
function masked(text: string, secrets: ReadonlyArray<readonly [string, string]>): string {
	let out = text;
	for (const [name, content] of secrets) out = out.replaceAll(content, `#${name}#`);
	return out;
}

describe("a literal secret", () => {
	for (const [label, first] of FIRST_UNITS) {
		const name = `SECRET_${label}`;
		const literal = `${first}token-body-${label.toLowerCase()}`;
		const texts = [
			literal,
			`${literal} trails`,
			`leads ${literal}`,
			`before ${literal} after`,
			`${literal}${literal}`,
			// A partial prefix first, so the scan fails out of the literal's path and restarts on its first unit.
			`${literal.slice(0, 5)}${literal}`,
			`${first}${first}${literal}`,
		];

		it(`starting with ${label} is masked at every occurrence and restored`, () => {
			const obfuscator = obfuscatorFor([[name, literal]]);
			for (const text of texts) {
				const outbound = obfuscator.obfuscate(text);
				expect(outbound).toBe(masked(text, [[name, literal]]));
				expect(obfuscator.deobfuscate(outbound)).toBe(text);
			}
		});
	}

	/**
	 * Every first unit configured at once. One trie holds root transitions on both sides of the
	 * table limit, so a literal routed to the table and one routed to the map share a scan.
	 */
	it("is masked beside literals starting on the other side of the root table", () => {
		const secrets = FIRST_UNITS.map(
			([label, first]) => [`MIXED_${label}`, `${first}mixed-secret-${label.toLowerCase()}`] as const,
		);
		const obfuscator = obfuscatorFor(secrets);
		const text = secrets.map(([, content], index) => `${index}:${content}`).join(" | ");
		const outbound = obfuscator.obfuscate(text);
		expect(outbound).toBe(masked(text, secrets));
		expect(obfuscator.deobfuscate(outbound)).toBe(text);
	});

	/**
	 * A failure transition that lands inside another literal whose path starts on a code unit the
	 * table does not hold: the scan follows the first literal through `xx日本語-token-`, fails on
	 * the `t` of `two`, and must continue in the second literal's path at `本語-token-`.
	 */
	it("is found through a failure transition into a literal starting past the table", () => {
		const secrets = [
			["FAIL_FROM", "xx\u65e5\u672c\u8a9e-token-one"],
			["FAIL_INTO", "\u672c\u8a9e-token-two-zz"],
		] as const;
		const obfuscator = obfuscatorFor(secrets);
		const text = "xx\u65e5\u672c\u8a9e-token-two-zz";
		expect(obfuscator.obfuscate(text)).toBe("xx\u65e5#FAIL_INTO#");
	});

	/** The same through the table: a failure transition back into a prefix of a literal starting on an ASCII unit. */
	it("is found through a failure transition into a literal starting in the table", () => {
		const secrets = [["REPEATED_PREFIX", "abcabd-token-long"]] as const;
		const obfuscator = obfuscatorFor(secrets);
		expect(obfuscator.obfuscate("abcabcabd-token-long")).toBe("abc#REPEATED_PREFIX#");
	});

	/** A literal past the trie's length limit, which the matcher finds by `indexOf`. */
	it("longer than the trie limit is masked at every occurrence", () => {
		const literal = `\u0100${"long-secret-".repeat(30)}`;
		const obfuscator = obfuscatorFor([["LONG_LITERAL", literal]]);
		const text = `start ${literal} middle ${literal} end`;
		const outbound = obfuscator.obfuscate(text);
		expect(outbound).toBe("start #LONG_LITERAL# middle #LONG_LITERAL# end");
		expect(obfuscator.deobfuscate(outbound)).toBe(text);
	});
});
