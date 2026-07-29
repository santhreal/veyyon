import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { buildValuePlaceholder } from "@veyyon/coding-agent/secrets/placeholder";
import { canObfuscatePlainValue, MIN_OBFUSCATABLE_LENGTH } from "@veyyon/coding-agent/secrets/policy";
import { compileSecretRegex } from "@veyyon/coding-agent/secrets/regex";

const KEY = new Uint8Array(32).fill(41);

describe("concatenated variable-width alternations", () => {
	it("refuses the compact exponential backtracking construction", () => {
		const pattern = `${"(?:a|aa)".repeat(28)}$`;

		expect(() => compileSecretRegex(pattern)).toThrow(
			/concatenated variable-width alternations.*catastrophic backtracking/,
		);
	});

	it("accepts one unquantified contextual variable-width alternation", () => {
		const regex = compileSecretRegex("(?<=kind=)(?:api|deploy)-[A-Za-z0-9]{8,}");

		expect(regex.exec("kind=deploy-AbCd1234")?.[0]).toBe("deploy-AbCd1234");
	});

	it("draws the safety boundary between one and two variable-width decisions", () => {
		expect(() => compileSecretRegex("(?:a|aa)b")).not.toThrow();
		expect(() => compileSecretRegex("(?:a|aa)(?:b|bb)")).toThrow(/concatenated variable-width alternations/);
	});

	it("keeps concatenated fixed-width disjoint choices available", () => {
		const regex = compileSecretRegex("(?:a|b)(?:c|d)(?:e|f)$");

		expect(regex.test("ace")).toBe(true);
		regex.lastIndex = 0;
		expect(regex.test("bdf")).toBe(true);
	});
});

describe("documented slash-literal parsing", () => {
	it("accepts valid literal flags and a raw leading slash with no closing delimiter", () => {
		expect(compileSecretRegex("/secret/i").test("SECRET")).toBe(true);
		expect(compileSecretRegex("/path").test("/path")).toBe(true);
	});

	it.each(["/secret/i ", "/secret/i1", "/secret/i-"])(
		"refuses malformed literal flag suffix %s instead of compiling it as raw text",
		pattern => {
			expect(() => compileSecretRegex(pattern)).toThrow(/literal flags must contain only ASCII letters/);
		},
	);

	it("preserves an escaped slash inside a valid literal", () => {
		const regex = compileSecretRegex("/https:\\/\\/[^\\s]+/i");

		expect(regex.exec("URL HTTPS://example.test/private")?.[0]).toBe("HTTPS://example.test/private");
	});
});

describe("well-formed UTF-16 placeholder inputs", () => {
	it("accepts BMP text and complete surrogate pairs", () => {
		expect(buildValuePlaceholder("plain-secret-value", KEY)).toMatch(/^#0[A-F0-9]{24}#$/);
		expect(buildValuePlaceholder("🔐-secret-value", KEY)).toMatch(/^#0[A-F0-9]{24}#$/);
	});

	it.each(["\uD800", "\uDC00", "\uD800A", "\uD800\uD801"])(
		"refuses ill-formed UTF-16 %p before deriving a placeholder",
		value => {
			expect(() => buildValuePlaceholder(value, KEY)).toThrow(/ill-formed UTF-16/);
		},
	);

	it("does not echo an ill-formed secret into the refusal", () => {
		const marker = "RAW_SECRET_MARKER";
		const value = `\uD800${marker}`;
		let message = "";
		try {
			buildValuePlaceholder(value, KEY);
		} catch (error) {
			message = String(error);
		}

		expect(message).toContain("ill-formed UTF-16");
		expect(message).not.toContain(marker);
	});

	it("fails closed when a non-Unicode regex splits an astral character", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", origin: "config", content: ".", minLength: 1 }], {
			placeholderKey: KEY,
		});

		expect(() => obfuscator.obfuscate("🔐")).toThrow(/ill-formed UTF-16/);
	});
});

describe("plain-secret length uses Unicode code points", () => {
	it("accepts exactly eight astral characters and rejects seven", () => {
		expect(canObfuscatePlainValue("🔐".repeat(MIN_OBFUSCATABLE_LENGTH))).toBe(true);
		expect(canObfuscatePlainValue("🔐".repeat(MIN_OBFUSCATABLE_LENGTH - 1))).toBe(false);
	});

	it("counts mixed BMP and astral text by code point", () => {
		expect(canObfuscatePlainValue(`${"a".repeat(7)}🔐`)).toBe(true);
		expect(canObfuscatePlainValue(`${"a".repeat(6)}🔐`)).toBe(false);
	});

	it("matches the regex floor's code-point rather than grapheme convention", () => {
		const fourGraphemesAndEightCodePoints = "e\u0301".repeat(4);

		expect(canObfuscatePlainValue(fourGraphemesAndEightCodePoints)).toBe(true);
	});

	it("rejects four astral characters instead of accepting their eight UTF-16 units", () => {
		const secret = "🔐".repeat(4);
		const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: secret }], {
			placeholderKey: KEY,
		});

		expect(obfuscator.hasSecrets()).toBe(false);
		expect(obfuscator.rejections()).toHaveLength(1);
		expect(obfuscator.rejections()[0]?.length).toBe(4);
		expect(obfuscator.obfuscate(secret)).toBe(secret);
	});

	/** Runtime additions report the same code-point count used by the acceptance predicate. */
	it("reports rejected runtime values in Unicode code points", () => {
		const obfuscator = new SecretObfuscator([], { placeholderKey: KEY });

		expect(() => obfuscator.addNamedSecret("ASTRAL_TOKEN", "🔐".repeat(4))).toThrow("the value is 4 characters");
	});
});
