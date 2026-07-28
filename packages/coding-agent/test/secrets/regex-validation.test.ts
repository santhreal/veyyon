/**
 * Secret regexes are executable configuration at the final outbound confidentiality boundary.
 *
 * These tests pin the distinction between useful context and unsafe matching semantics. Consuming
 * lookarounds are valid because match[0] is still the secret; sticky or zero-width expressions are
 * not, because global scanning can stop early or discover nothing to redact. The safety checks are
 * structural and bounded rather than probe-based: executing a catastrophic expression to decide
 * whether it is catastrophic would make validation itself the denial-of-service path.
 */
import { describe, expect, it } from "bun:test";
import { compileSecretRegex } from "@veyyon/coding-agent/secrets/regex";

describe("ordinary and contextual secret regexes", () => {
	/** A normal declaration still receives global scanning and retains its requested flags. */
	it("accepts an ordinary consuming pattern", () => {
		const regex = compileSecretRegex("AKIA[0-9A-Z]{16}", "i");

		expect(regex.global).toBe(true);
		expect(regex.ignoreCase).toBe(true);
		expect("prefix akia0123456789abcdef suffix".match(regex)).toEqual(["akia0123456789abcdef"]);
	});

	/** Lookbehind and lookahead provide context while the alphanumeric body remains the exact match. */
	it("accepts a consuming secret bounded by lookaround context", () => {
		const regex = compileSecretRegex("(?<=token=)(?<credential>[A-Za-z0-9]{8,})(?=;)");
		const match = regex.exec("public token=abc123XYZ; tail");

		expect(match?.[0]).toBe("abc123XYZ");
		expect(match?.groups?.credential).toBe("abc123XYZ");
	});

	/** An alternation is ordinary when it is not itself repeated ambiguously. */
	it("accepts a non-repeated contextual alternation", () => {
		const regex = compileSecretRegex("(?<=kind=)(?:api|deploy)-[A-Za-z0-9]{8,}");

		expect(regex.exec("kind=deploy-AbCd1234")?.[0]).toBe("deploy-AbCd1234");
	});

	/** Escaped delimiters in documented literal syntax remain part of the regex source. */
	it("accepts an escaped slash in a regex literal", () => {
		const regex = compileSecretRegex("/https:\\/\\/[^\\s]+/i");

		expect(regex.exec("URL HTTPS://example.test/private")?.[0]).toBe("HTTPS://example.test/private");
	});
});

describe("literal and explicit flags", () => {
	/** The indices flag is modern but valid in the active runtime, so no static allow-list may reject it. */
	it("accepts the modern literal indices flag", () => {
		const regex = compileSecretRegex("/secret/d");

		expect(regex.hasIndices).toBe(true);
		expect(regex.global).toBe(true);
	});

	/** Unicode-set mode is likewise delegated to the runtime and remains compatible with global scanning. */
	it("accepts the modern Unicode-sets literal flag", () => {
		const regex = compileSecretRegex("/[\\p{ASCII}&&\\p{Letter}]+/v");

		expect(regex.flags).toContain("v");
		expect(regex.exec("123 Token-42")?.[0]).toBe("Token");
	});

	/** Regression: `/secret/z` used to become a raw pattern and silently match nothing useful. */
	it("refuses an unsupported literal flag instead of treating the literal as raw text", () => {
		expect(() => compileSecretRegex("/secret/z")).toThrow(/invalid or incompatible regex flags/);
	});

	/** Duplicate flags are invalid literal syntax and must not disappear during flag merging. */
	it("refuses duplicate flags within a literal", () => {
		expect(() => compileSecretRegex("/secret/ii")).toThrow(/invalid or incompatible regex flags/);
	});

	/** The separate field uses the same runtime validation as the literal suffix. */
	it("refuses an unsupported explicit flag", () => {
		expect(() => compileSecretRegex("secret", "x")).toThrow(/invalid or incompatible regex flags/);
	});
});

describe("scanning semantics", () => {
	/** Sticky matching stops at the first non-match, defeating a global scan of ordinary surrounding text. */
	it.each([
		["literal", () => compileSecretRegex("/secret/y")],
		["explicit field", () => compileSecretRegex("secret", "y")],
	])("refuses the sticky flag from the %s", (_source, compile) => {
		expect(compile).toThrow(/sticky.*incompatible with global secret scanning/i);
	});

	/** Every accepted expression must consume a value; assertions and empty repetitions do not. */
	it.each(["^$", "\\b", "(?=secret)", "a*"])("refuses zero-width-capable pattern %s", pattern => {
		expect(() => compileSecretRegex(pattern)).toThrow(/without consuming input/);
	});

	/** A lookaround is not confused with a zero-width pattern when a body still consumes the secret. */
	it("accepts assertions around a consuming body", () => {
		expect(compileSecretRegex("(?<!public-)secret-(?!demo)[A-Za-z0-9]{8}").global).toBe(true);
	});
});

describe("bounded catastrophic-backtracking defense", () => {
	/** Nested variable repetition and repeated alternation are classic exponential backtracking shapes. */
	it.each(["(a+)+$", "(?:[a-zA-Z]+)*$", "(?:a|aa)+$"])("refuses catastrophic pattern %s", pattern => {
		expect(() => compileSecretRegex(pattern)).toThrow(/catastrophic backtracking|cannot be proven safe/);
	});

	/**
	 * Whitespace literals overlap `\s`; both a space and a tab must be recognized structurally so
	 * compilation refuses the ambiguous adjacent repetitions without ever executing the pattern.
	 */
	it.each(["\\s+ +X", "\\s+\t+X"])("refuses whitespace class/literal overlap in %s", pattern => {
		expect(() => compileSecretRegex(pattern)).toThrow(/concatenated variable quantifiers/i);
	});

	/**
	 * Ignore-case changes whether differently-cased literal atoms overlap. Case-sensitive input is
	 * disjoint, while the same source under `i` is refused during compilation.
	 */
	it("accounts for ignore-case when comparing adjacent literal repetitions", () => {
		expect(() => compileSecretRegex("a+A+X")).not.toThrow();
		expect(() => compileSecretRegex("a+A+X", "i")).toThrow(/concatenated variable quantifiers/i);
	});

	/** Backreferences have non-local width and are conservatively outside the validator's safe subset. */
	it("refuses a backreference whose backtracking cannot be bounded structurally", () => {
		expect(() => compileSecretRegex("([A-Za-z]+)\\1")).toThrow(/backreferences cannot be proven safe/);
	});

	/** The source-length ceiling is inclusive: useful input at the bound remains accepted. */
	it("accepts a consuming pattern at the structural validation boundary", () => {
		expect(compileSecretRegex("a".repeat(4096)).global).toBe(true);
	});

	/** One character beyond the ceiling is refused before an unbounded configuration can be compiled or scanned. */
	it("refuses a pattern beyond the structural validation boundary", () => {
		expect(() => compileSecretRegex("a".repeat(4097))).toThrow(/4096-character bounded safety limit/);
	});
});
