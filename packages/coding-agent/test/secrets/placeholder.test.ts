/**
 * The two placeholder forms and the structural invariant that keeps them disjoint.
 *
 * Named values use readable `#GITHUB_TOKEN#` tokens. Unnamed values use a keyed HMAC
 * token whose body begins with a digit. A vault name must begin with a letter, so one
 * token can never select two credentials.
 */
import { describe, expect, it } from "bun:test";
import {
	assertNameRuleCoversValueForm,
	buildNamePlaceholder,
	buildValuePlaceholder,
	describeInvalidSecretName,
	isValidSecretName,
	MAX_SECRET_NAME_LENGTH,
	MIN_SECRET_NAME_LENGTH,
	PENDING_PLACEHOLDER_RE,
	PLACEHOLDER_RE,
	VALUE_PLACEHOLDER_BODY_LENGTH,
	VALUE_PLACEHOLDER_HEX_LENGTH,
	VALUE_PLACEHOLDER_PREFIX,
} from "@veyyon/coding-agent/secrets/placeholder";

/**
 * Every placeholder in a string, through the shipped regex.
 *
 * `String.prototype.match` resets a global regular expression before scanning, so this
 * tests the exported matcher rather than rebuilding a test-only copy.
 */
function allPlaceholders(text: string): string[] {
	return text.match(PLACEHOLDER_RE) ?? [];
}

describe("the two placeholder forms cannot collide", () => {
	/** The value form starts with a reserved digit while every accepted vault name starts with a letter. */
	it("enforces structural separation between value and name forms", () => {
		expect(() => assertNameRuleCoversValueForm()).not.toThrow();
		const body = buildValuePlaceholder("secret-value-123", new Uint8Array(32).fill(1)).slice(1, -1);

		expect(body.startsWith(VALUE_PLACEHOLDER_PREFIX)).toBe(true);
		expect(isValidSecretName(body)).toBe(false);
	});

	/** The shortest and longest readable names remain valid after changing the opaque value width. */
	it("accepts both name-length boundaries without admitting the reserved value form", () => {
		expect(isValidSecretName("A".repeat(MIN_SECRET_NAME_LENGTH))).toBe(true);
		expect(isValidSecretName("A".repeat(MAX_SECRET_NAME_LENGTH))).toBe(true);
		expect(isValidSecretName(`${VALUE_PLACEHOLDER_PREFIX}${"A".repeat(VALUE_PLACEHOLDER_HEX_LENGTH)}`)).toBe(false);
	});
});

describe("keyed value placeholders", () => {
	/** A persisted machine key keeps transcript and provider-cache bytes stable across process restarts. */
	it("is stable for the same value and key", () => {
		const key = new Uint8Array(32).fill(2);
		expect(buildValuePlaceholder("stable-secret-value", key)).toBe(buildValuePlaceholder("stable-secret-value", key));
	});

	/** Values and machine keys both participate in the HMAC, preventing index and offline-dictionary oracles. */
	it("changes when either the value or key changes", () => {
		const key = new Uint8Array(32).fill(3);
		const token = buildValuePlaceholder("first-secret-value", key);

		expect(buildValuePlaceholder("second-secret-value", key)).not.toBe(token);
		expect(buildValuePlaceholder("first-secret-value", new Uint8Array(32).fill(4))).not.toBe(token);
	});

	/** The emitted value token is accepted by the same matcher used by deobfuscation and stream buffering. */
	it("emits the reserved prefix and complete retained HMAC width", () => {
		const token = buildValuePlaceholder("shape-secret-value", new Uint8Array(32).fill(5));

		expect(token).toHaveLength(VALUE_PLACEHOLDER_BODY_LENGTH + 2);
		expect(allPlaceholders(`before ${token} after`)).toEqual([token]);
	});
});

describe("name placeholders", () => {
	/** The name is the token, which is what lets the model choose deliberately. */
	it("wraps the name in hashes", () => {
		expect(buildNamePlaceholder("GITHUB_TOKEN")).toBe("#GITHUB_TOKEN#");
	});

	/** Names people would plausibly use are accepted. */
	it("accepts realistic names", () => {
		for (const name of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DEPLOY", "SECRET_1", "PG_PASSWORD", "TOKEN2"]) {
			expect(isValidSecretName(name)).toBe(true);
		}
	});

	/**
	 * Lowercase is refused at this layer.
	 *
	 * The vault normalises what the user types before it gets here, so this layer stays a
	 * single strict rule instead of two lenient ones that could disagree about what a name is.
	 */
	it("refuses anything that is not already normalised", () => {
		for (const name of ["github_token", "GitHub_Token", "GITHUB-TOKEN", "GITHUB TOKEN", "1TOKEN", "_TOKEN"]) {
			expect(isValidSecretName(name)).toBe(false);
		}
	});

	/** Characters that would be ambiguous inside `#...#` are refused. */
	it("refuses punctuation that would break the token", () => {
		for (const name of ["TOK#EN", "TOK EN", "TOK.EN", "TOK/EN", "TOK-EN", "TOK$EN", "TOK\nEN"]) {
			expect(isValidSecretName(name)).toBe(false);
		}
	});

	/** The length window is enforced at both ends. */
	it("enforces the length window", () => {
		expect(isValidSecretName("A".repeat(MIN_SECRET_NAME_LENGTH - 1))).toBe(false);
		expect(isValidSecretName("A".repeat(MIN_SECRET_NAME_LENGTH))).toBe(true);
		expect(isValidSecretName("A".repeat(MAX_SECRET_NAME_LENGTH))).toBe(true);
		expect(isValidSecretName("A".repeat(MAX_SECRET_NAME_LENGTH + 1))).toBe(false);
	});

	/** The refusal explains the rule, since the user cannot see the regex. */
	it("explains why a name was refused", () => {
		const message = describeInvalidSecretName("bad name!");

		expect(message).toContain("bad name!");
		expect(message).toContain(String(MIN_SECRET_NAME_LENGTH));
		expect(message).toContain(String(MAX_SECRET_NAME_LENGTH));
	});
});

describe("a placeholder cut off by a streamed chunk", () => {
	/**
	 * A partial NAME placeholder is recognised, which an index-shaped rule got wrong.
	 *
	 * THE BUG THIS LOCKS OUT. `agent-session.ts` carried its own inline `/#[A-Z0-9]{0,4}$/` to
	 * hold back a token split across chunks. That encoded a four-character body with no
	 * underscore, which was right for `#A1B2#` and silently wrong the moment names arrived:
	 * `#GITHUB_TOK` matches neither the length nor the charset, so the fragment would have been
	 * emitted to the display and the completed token never substituted as a unit. Two
	 * definitions of one shape, and only one of them was updated.
	 */
	it("matches a partial name placeholder at the end of a chunk", () => {
		for (const partial of ["#", "#G", "#GITHUB", "#GITHUB_", "#GITHUB_TOK"]) {
			const text = `Authorization: Bearer ${partial}`;
			const match = text.match(PENDING_PLACEHOLDER_RE);

			expect(match).not.toBeNull();
			expect(text.slice(match!.index)).toBe(partial);
		}
	});

	/** A partial index placeholder still matches, so the older form did not regress. */
	it("matches a partial index placeholder", () => {
		const text = "key=#A1B";

		expect(text.match(PENDING_PLACEHOLDER_RE)?.[0]).toBe("#A1B");
	});

	/** Anchored at the end: a token in the middle of a chunk is complete and left alone. */
	it("ignores a placeholder that is not at the end", () => {
		expect("#GITHUB_TOKEN# and more text".match(PENDING_PLACEHOLDER_RE)).toBeNull();
	});

	/** Text with no trailing hash is not held back, or every chunk would stall. */
	it("ignores ordinary text", () => {
		expect("just some prose".match(PENDING_PLACEHOLDER_RE)).toBeNull();
		expect("done.".match(PENDING_PLACEHOLDER_RE)).toBeNull();
	});

	/** The pending matcher is not global, because the caller reads `match.index`. */
	it("is not a global regex", () => {
		expect(PENDING_PLACEHOLDER_RE.global).toBe(false);
	});
});

describe("matching placeholders in text", () => {
	/** One expression finds both forms, because deobfuscation walks text once. */
	it("finds both forms in one pass", () => {
		const valuePlaceholder = buildValuePlaceholder("header-secret-value", new Uint8Array(32).fill(6));
		const text = `curl -H "Authorization: Bearer #GITHUB_TOKEN#" --key ${valuePlaceholder}`;

		expect(allPlaceholders(text)).toEqual(["#GITHUB_TOKEN#", valuePlaceholder]);
	});

	/** Adjacent tokens are matched separately rather than swallowed as one. */
	it("separates adjacent placeholders", () => {
		expect(allPlaceholders("#TOKEN_A##TOKEN_B#")).toEqual(["#TOKEN_A#", "#TOKEN_B#"]);
	});

	/**
	 * Ordinary prose containing a hash is not matched.
	 *
	 * The matcher runs over every message, so a false positive would rewrite text that has
	 * nothing to do with secrets. Lowercase, spaces and short bodies all fail to match.
	 */
	it("ignores text that is not a placeholder", () => {
		expect(allPlaceholders("issue #42 and #ab#")).toEqual([]);
		expect(allPlaceholders("#lowercase_name#")).toEqual([]);
		expect(allPlaceholders("# SPACED #")).toEqual([]);
		expect(allPlaceholders("a#b")).toEqual([]);
		expect(allPlaceholders("")).toEqual([]);
	});

	/** A markdown heading is not a placeholder, which is the common false positive. */
	it("ignores markdown headings", () => {
		expect(allPlaceholders("## Heading\n### Another")).toEqual([]);
	});
});
