import { describe, expect, it } from "bun:test";
import {
	mapJsonStrings,
	MAX_JSON_TRANSFORM_DEPTH,
	MAX_JSON_TRANSFORM_NODES,
	MAX_JSON_TRANSFORM_STRING_BYTES,
	MAX_PLACEHOLDERS_PER_TEXT,
	MAX_SECRET_MATCHES_PER_TEXT,
	MAX_SECRET_VALUE_BYTES,
	SecretObfuscator,
} from "@veyyon/coding-agent/secrets/obfuscator";
import {
	isSecretPlaceholder,
	MAX_SECRET_NAME_LENGTH,
} from "@veyyon/coding-agent/secrets/placeholder";
import { compileSecretRegex } from "@veyyon/coding-agent/secrets/regex";

const KEY = new Uint8Array(32).fill(17);

describe("bounded structural regex validation", () => {
	/** Adjacent repetitions over the same language produce cubic global non-match scans. */
	it.each(["a*a*b", "a+a+b", "[a-z]*[a-z]*Z"])("rejects overlapping concatenated quantifiers in %s", pattern => {
		expect(() => compileSecretRegex(pattern)).toThrow(/concatenated variable quantifiers.*catastrophic/i);
	});

	/** Disjoint repeated atoms remain useful and do not share a backtracking partition. */
	it("retains ordinary disjoint quantified fields", () => {
		expect(compileSecretRegex("api\\s*=\\s*\\w+").exec("api = value")?.[0]).toBe("api = value");
	});

	/** Unicode-v q-string atoms consume variable-length strings hidden inside a character class. */
	it("rejects Unicode-set string disjunction atoms", () => {
		expect(() => compileSecretRegex("(?:[\\q{a|aa}])+$", "v")).toThrow(/Unicode-set string atoms.*catastrophic/i);
	});
});

describe("deterministic one-way aliases", () => {
	/** Terminal aliases are recognized before every rule on later calls, not only by same-call provenance spans. */
	it("is idempotent across calls for literal and generated regex aliases", () => {
		const literal = new SecretObfuscator(
			[{ type: "plain", content: "literal-source-secret", mode: "replace", replacement: "SAFE_ALIAS" }],
			{ placeholderKey: KEY },
		);
		const literalAlias = literal.obfuscate("literal-source-secret");
		expect(literal.obfuscate(literalAlias)).toBe(literalAlias);

		const regex = new SecretObfuscator(
			[{ type: "regex", content: "pin-[0-9]{8}", mode: "replace" }],
			{ placeholderKey: KEY },
		);
		const regexAlias = regex.obfuscate("pin-12345678");
		expect(regex.obfuscate(regexAlias)).toBe(regexAlias);
	});

	/** An alias that another rule treats as a source makes the policy order-dependent and is refused. */
	it("rejects cross-rule alias capture", () => {
		expect(
			() =>
				new SecretObfuscator(
					[
						{ type: "plain", content: "literal-source-secret", mode: "replace", replacement: "alias-12345678" },
						{ type: "regex", content: "alias-[0-9]{8}" },
					],
					{ placeholderKey: KEY },
				),
		).toThrow(/alias captured by another secret rule/i);
	});

	/** Exact sources cannot be both reversible and one-way, regardless of declaration order or source kind. */
	it("rejects conflicting exact policies independent of order", () => {
		for (const entries of [
			[
				{ type: "plain" as const, content: "conflicting-secret", mode: "obfuscate" as const },
				{ type: "plain" as const, content: "conflicting-secret", mode: "replace" as const },
			],
			[
				{ type: "plain" as const, content: "conflicting-secret", mode: "replace" as const },
				{ type: "plain" as const, content: "conflicting-secret", mode: "obfuscate" as const },
			],
			[
				{ type: "regex" as const, content: "token-[0-9]+", mode: "replace" as const },
				{ type: "regex" as const, content: "token-[0-9]+", mode: "obfuscate" as const },
			],
		]) {
			expect(() => new SecretObfuscator(entries, { placeholderKey: KEY })).toThrow(/conflicting policies/i);
		}
	});

	/** A long source is hashed into one fixed seed, then expanded to a deterministic same-length terminal alias. */
	it("preserves the linear source-plus-output work invariant for long default replacements", () => {
		const source = "s".repeat(320_000);
		const first = new SecretObfuscator([{ type: "plain", content: source, mode: "replace" }], {
			placeholderKey: KEY,
		});
		const second = new SecretObfuscator([{ type: "plain", content: source, mode: "replace" }], {
			placeholderKey: KEY,
		});
		const alias = first.obfuscate(source);
		expect(alias).toHaveLength(source.length);
		expect(alias).toBe(second.obfuscate(source));
		expect(first.obfuscate(alias)).toBe(alias);
	});

	/** Thousands of literal entries compile once into one matcher and keep longest exact replacement semantics. */
	it("registers and matches a bulk literal registry", () => {
		const entries = Array.from({ length: 2_000 }, (_, index) => ({
			type: "plain" as const,
			content: `bulk-source-secret-${index}`,
			mode: "replace" as const,
			replacement: `MASK_${index}`,
		}));
		const obfuscator = new SecretObfuscator(entries, { placeholderKey: KEY });
		expect(obfuscator.obfuscate("bulk-source-secret-1999")).toBe("MASK_1999");
	});
});

describe("expiry and key invariants", () => {
	/** NaN, infinities, fractions, and unsafe integers can never become meaningful epoch deadlines. */
	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid expiry %s",
		expiresAt => {
			expect(
				() =>
					new SecretObfuscator(
						[{ type: "plain", content: "expiring-secret-value", name: "EXPIRY_TOKEN", expiresAt }],
						{ placeholderKey: KEY },
					),
			).toThrow(/finite safe-integer/i);
		},
	);

	/** A caller cannot mutate the HMAC identity after construction through its Uint8Array reference. */
	it("snapshots the validated placeholder key", () => {
		const mutable = new Uint8Array(32).fill(23);
		const expectedKey = Uint8Array.from(mutable);
		const first = new SecretObfuscator([{ type: "regex", content: "token-[0-9]{8}" }], {
			placeholderKey: mutable,
		});
		mutable.fill(99);
		const second = new SecretObfuscator([{ type: "regex", content: "token-[0-9]{8}" }], {
			placeholderKey: expectedKey,
		});
		expect(first.obfuscate("token-12345678")).toBe(second.obfuscate("token-12345678"));
		expect(() => new SecretObfuscator([], { placeholderKey: new Uint8Array(31) })).toThrow(/exactly 32 bytes/i);
	});

	/** Expiring the newest duplicate-value name selects a surviving live forward name, not an opaque tombstone. */
	it("falls back to a surviving named mapping for a duplicate value", () => {
		let now = 0;
		const value = "duplicate-named-secret-value";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: value, name: "SURVIVOR_TOKEN", expiresAt: 20 },
				{ type: "plain", content: value, name: "EXPIRING_TOKEN", expiresAt: 10 },
			],
			{ placeholderKey: KEY, now: () => now },
		);
		expect(obfuscator.obfuscate(value)).toBe("#EXPIRING_TOKEN#");
		now = 10;
		expect(obfuscator.namedSecretNames()).toEqual(["SURVIVOR_TOKEN"]);
		expect(obfuscator.obfuscate(value)).toBe("#SURVIVOR_TOKEN#");
		expect(obfuscator.deobfuscate("#SURVIVOR_TOKEN#")).toBe(value);
	});

	/**
	 * Duplicate values retain expansion rights under every live name. A non-forward live alias must
	 * therefore be protected before a regex can reinterpret the visible name inside its token.
	 */
	it("protects every live duplicate-name placeholder across calls", () => {
		const value = "duplicate-live-alias-secret";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: value, name: "FIRST_TOKEN" },
				{ type: "plain", content: value, name: "SECOND_TOKEN" },
				{ type: "regex", content: "FIRST_TOKEN" },
			],
			{ placeholderKey: KEY },
		);
		expect(obfuscator.obfuscate("#FIRST_TOKEN#")).toBe("#FIRST_TOKEN#");
		expect(obfuscator.deobfuscate("#FIRST_TOKEN#")).toBe(value);
	});

	/** Inventory is an expiry-enforcing read, including a deadline already elapsed at construction. */
	it("sweeps immediate inventory expiry", () => {
		const expired: string[] = [];
		const obfuscator = new SecretObfuscator(
			[{ type: "plain", content: "already-expired-secret", name: "EXPIRED_TOKEN", expiresAt: 100 }],
			{ placeholderKey: KEY, now: () => 100, onExpiry: name => expired.push(name) },
		);
		expect(obfuscator.namedSecretNames()).toEqual([]);
		expect(expired).toEqual(["EXPIRED_TOKEN"]);
	});

	/** Bulk insertion indexes deadlines without changing which exact half expires at the sweep boundary. */
	it("expires a bulk registry exactly once per elapsed name", () => {
		let now = 0;
		const expired: string[] = [];
		const entries = Array.from({ length: 2_000 }, (_, index) => ({
			type: "plain" as const,
			content: `bulk-expiry-secret-value-${index}`,
			name: `TOKEN_${index.toString().padStart(5, "0")}`,
			expiresAt: index % 2 === 0 ? 10 : 20,
		}));
		const obfuscator = new SecretObfuscator(entries, {
			placeholderKey: KEY,
			now: () => now,
			onExpiry: name => expired.push(name),
		});
		now = 15;
		expect(obfuscator.namedSecretNames()).toHaveLength(1_000);
		expect(expired).toHaveLength(1_000);
		expect(new Set(expired).size).toBe(expired.length);
	});
});

describe("bounded iterative JSON string mapping", () => {
	/** Cycles fail with a controlled credential-free error instead of exhausting the JavaScript stack. */
	it("rejects cycles", () => {
		const value: Record<string, unknown> = { label: "private-cycle-value" };
		value.self = value;
		expect(() => mapJsonStrings(value, text => text)).toThrow(/cyclic JSON transformation graph/i);
		try {
			mapJsonStrings(value, text => text);
		} catch (error) {
			expect(String(error)).not.toContain("private-cycle-value");
		}
	});

	/** The documented depth is inclusive, and the next container edge is rejected without recursion. */
	it("enforces the depth boundary", () => {
		const build = (containers: number): Record<string, unknown> => {
			let current: unknown = "leaf";
			for (let index = 0; index < containers; index++) current = { child: current };
			return current as Record<string, unknown>;
		};
		expect(() => mapJsonStrings(build(MAX_JSON_TRANSFORM_DEPTH + 1), text => text)).not.toThrow();
		expect(() => mapJsonStrings(build(MAX_JSON_TRANSFORM_DEPTH + 2), text => text)).toThrow(/depth limit/i);
	});

	/** A tiny shared DAG is mapped once per allocated node and retains sharing in the changed copy. */
	it("memoizes shared DAG nodes and preserves copy-on-change identity", () => {
		let shared: unknown = { token: "secret" };
		for (let index = 0; index < 25; index++) shared = [shared, shared];
		let calls = 0;
		const mapped = mapJsonStrings(shared, text => {
			calls++;
			return text === "secret" ? "masked" : text;
		}) as unknown[];
		expect(calls).toBe(2);
		expect(mapped[0]).toBe(mapped[1]);
		expect(mapJsonStrings(shared, text => text)).toBe(shared);
	});

	/** Binary views are rejected before numeric byte keys can be listed or transformed. */
	it("rejects huge typed arrays without enumerating their bytes", () => {
		let calls = 0;
		expect(() =>
			mapJsonStrings(new Uint8Array(2_000_000), text => {
				calls++;
				return text;
			}),
		).toThrow(/non-plain object/i);
		expect(calls).toBe(0);
	});

	/** The last admissible flat array consumes exactly the node budget; one more item is preflighted away. */
	it("enforces the node boundary before a huge array walk", () => {
		const atLimit = new Array(MAX_JSON_TRANSFORM_NODES - 1).fill(null);
		expect(mapJsonStrings(atLimit, text => text)).toBe(atLimit);
		expect(() => mapJsonStrings(new Array(MAX_JSON_TRANSFORM_NODES).fill(null), text => text)).toThrow(
			/array-item limit/i,
		);
	});

	/** Cumulative string bytes are bounded independently of node shape. */
	it("enforces the cumulative string-byte boundary", () => {
		const atLimit = "a".repeat(MAX_JSON_TRANSFORM_STRING_BYTES);
		expect(mapJsonStrings(atLimit, text => text)).toBe(atLimit);
		expect(() => mapJsonStrings(`${atLimit}a`, text => text)).toThrow(/input string-byte limit/i);
	});

	/** Key rewriting cannot silently merge two source fields. */
	it("rejects mapped-key collisions", () => {
		expect(() => mapJsonStrings({ first: 1, second: 2 }, text => (text === "first" ? "second" : text))).toThrow(
			/same protected key/i,
		);
	});
});

describe("match, placeholder, and output amplification limits", () => {
	/** Match processing stops at the declared count instead of retaining a 100K replacement array. */
	it("rejects huge regex match sets", () => {
		const obfuscator = new SecretObfuscator(
			[{ type: "regex", content: "x", mode: "replace", replacement: "*" }],
			{ placeholderKey: KEY },
		);
		expect(() => obfuscator.obfuscate("x".repeat(MAX_SECRET_MATCHES_PER_TEXT + 1))).toThrow(/too many regex matches/i);
	});

	/** Placeholder count is preflighted even when each individual expansion is small. */
	it("rejects excessive placeholder counts", () => {
		const obfuscator = new SecretObfuscator(
			[{ type: "plain", content: "placeholder-count-secret", name: "COUNT_TOKEN" }],
			{ placeholderKey: KEY },
		);
		expect(() => obfuscator.deobfuscate("#COUNT_TOKEN#".repeat(MAX_PLACEHOLDERS_PER_TEXT + 1))).toThrow(
			/too many placeholders/i,
		);
	});

	/** Bounded token syntax refuses overlong bodies without granting expansion rights. */
	it("keeps overlong placeholder names inert", () => {
		const overlong = `#${"A".repeat(MAX_SECRET_NAME_LENGTH + 1)}#`;
		expect(isSecretPlaceholder(overlong)).toBe(false);
	});

	/** Expansion size is computed from mapped values before String.replace can allocate the result. */
	it("rejects placeholder output amplification", () => {
		const value = "v".repeat(MAX_SECRET_VALUE_BYTES);
		const obfuscator = new SecretObfuscator(
			[{ type: "plain", content: value, name: "LARGE_TOKEN" }],
			{ placeholderKey: KEY },
		);
		expect(() => obfuscator.deobfuscate("#LARGE_TOKEN#".repeat(17))).toThrow(/output byte limit/i);
	});

	/** One-way replacement output is also preflighted before joining amplified chunks. */
	it("rejects literal replacement output amplification", () => {
		const replacement = "A".repeat(64 * 1024);
		const obfuscator = new SecretObfuscator(
			[{ type: "plain", content: "x", mode: "replace", replacement }],
			{ placeholderKey: KEY },
		);
		expect(() => obfuscator.obfuscate("x".repeat(257))).toThrow(/output byte limit/i);
	});
});
