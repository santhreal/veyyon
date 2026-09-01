import { describe, expect, it } from "bun:test";
import {
	describeSecretExpiry,
	MAX_PLACEHOLDERS_PER_TEXT,
	MAX_RUNTIME_SECRET_BYTES,
	MAX_RUNTIME_SECRET_VALUES,
	MAX_SECRET_ENTRIES,
	MAX_SECRET_MATCHES_PER_TEXT,
	MAX_SECRET_REGEX_ENTRIES,
	MAX_SECRET_VALUE_BYTES,
	MAX_TRANSFORMED_TEXT_BYTES,
	mayRestoreForDisplay,
	REPLACEMENT_CHARS,
	SECRET_ORIGINS,
	type SecretEntry,
	type SecretExpiryEvent,
} from "../src/secrets/obfuscator-helpers";
import {
	enforceGlobalFlag,
	MAX_FLAG_LENGTH,
	MAX_GROUP_DEPTH,
	MAX_PATTERN_LENGTH,
	splitRegexLiteral,
	validateFlags,
} from "../src/secrets/regex-helpers";

describe("regex constants", () => {
	it("MAX_PATTERN_LENGTH is 4096", () => {
		expect(MAX_PATTERN_LENGTH).toBe(4096);
	});
	it("MAX_GROUP_DEPTH is 64", () => {
		expect(MAX_GROUP_DEPTH).toBe(64);
	});
	it("MAX_FLAG_LENGTH is 16", () => {
		expect(MAX_FLAG_LENGTH).toBe(16);
	});
});

describe("enforceGlobalFlag", () => {
	it("adds g flag when missing", () => {
		expect(enforceGlobalFlag("i")).toBe("ig");
	});

	it("does not add g flag when already present", () => {
		expect(enforceGlobalFlag("gi")).toBe("gi");
	});

	it("handles empty flags", () => {
		expect(enforceGlobalFlag("")).toBe("g");
	});

	it("throws on sticky y flag", () => {
		expect(() => enforceGlobalFlag("y")).toThrow("sticky");
	});

	it("throws on y flag combined with other flags", () => {
		expect(() => enforceGlobalFlag("iy")).toThrow("sticky");
	});

	it("preserves other flags", () => {
		expect(enforceGlobalFlag("im")).toBe("img");
	});
});

describe("splitRegexLiteral", () => {
	it("parses /pattern/flags", () => {
		expect(splitRegexLiteral("/foo/gi")).toEqual({ pattern: "foo", flags: "gi" });
	});

	it("parses /pattern/ without flags", () => {
		expect(splitRegexLiteral("/foo/")).toEqual({ pattern: "foo", flags: "" });
	});

	it("returns undefined for non-slash pattern", () => {
		expect(splitRegexLiteral("foo")).toBeUndefined();
	});

	it("handles escaped slash in pattern", () => {
		expect(splitRegexLiteral("/foo\\/bar/g")).toEqual({ pattern: "foo\\/bar", flags: "g" });
	});

	it("handles empty pattern", () => {
		expect(splitRegexLiteral("//g")).toEqual({ pattern: "", flags: "g" });
	});

	it("throws on non-letter flags", () => {
		expect(() => splitRegexLiteral("/foo/123")).toThrow("ASCII letters");
	});

	it("handles pattern with no closing slash", () => {
		expect(splitRegexLiteral("/foo")).toBeUndefined();
	});

	it("handles multiple slashes in pattern", () => {
		expect(splitRegexLiteral("/a/b/c/g")).toEqual({ pattern: "a/b/c", flags: "g" });
	});
});

describe("validateFlags", () => {
	it("does not throw for valid flags", () => {
		expect(() => validateFlags("gi", "test")).not.toThrow();
	});

	it("does not throw for empty flags", () => {
		expect(() => validateFlags("", "test")).not.toThrow();
	});

	it("throws for flags too long", () => {
		expect(() => validateFlags("a".repeat(17), "test")).toThrow("too long");
	});

	it("throws for sticky flag", () => {
		expect(() => validateFlags("y", "test")).toThrow("sticky");
	});

	it("throws for invalid flags", () => {
		expect(() => validateFlags("x", "test")).toThrow("invalid");
	});

	it("includes source in error message", () => {
		expect(() => validateFlags("y", "my-source")).toThrow("my-source");
	});
});

describe("SECRET_ORIGINS", () => {
	it("contains vault, environment, and config", () => {
		expect(SECRET_ORIGINS).toContain("vault");
		expect(SECRET_ORIGINS).toContain("environment");
		expect(SECRET_ORIGINS).toContain("config");
	});
});

describe("mayRestoreForDisplay", () => {
	it("returns true for regex type with config origin", () => {
		const entry: SecretEntry = { type: "regex", content: "test", origin: "config" };
		expect(mayRestoreForDisplay(entry)).toBe(true);
	});

	it("returns false for plain type with config origin", () => {
		const entry: SecretEntry = { type: "plain", content: "test", origin: "config" };
		expect(mayRestoreForDisplay(entry)).toBe(false);
	});

	it("returns false for regex type with vault origin", () => {
		const entry: SecretEntry = { type: "regex", content: "test", origin: "vault" };
		expect(mayRestoreForDisplay(entry)).toBe(false);
	});

	it("returns false for regex type with environment origin", () => {
		const entry: SecretEntry = { type: "regex", content: "test", origin: "environment" };
		expect(mayRestoreForDisplay(entry)).toBe(false);
	});
});

describe("describeSecretExpiry", () => {
	it("describes expiry with persisted ciphertext removed", () => {
		const event: SecretExpiryEvent = { name: "MY_SECRET", persistedCiphertextRemoved: true };
		const result = describeSecretExpiry(event);
		expect(result).toContain("#MY_SECRET#");
		expect(result).toContain("expired");
		expect(result).toContain("deleted from the vault");
	});

	it("describes expiry with persisted ciphertext not yet removed", () => {
		const event: SecretExpiryEvent = { name: "API_KEY", persistedCiphertextRemoved: false };
		const result = describeSecretExpiry(event);
		expect(result).toContain("#API_KEY#");
		expect(result).toContain("has not yet been deleted");
		expect(result).toContain("vault refresh will prune");
	});

	it("includes re-store instructions", () => {
		const event: SecretExpiryEvent = { name: "TOKEN", persistedCiphertextRemoved: true };
		const result = describeSecretExpiry(event);
		expect(result).toContain("/secret from-env");
	});
});

describe("obfuscator constants", () => {
	it("REPLACEMENT_CHARS contains alphanumeric characters", () => {
		expect(REPLACEMENT_CHARS).toContain("A");
		expect(REPLACEMENT_CHARS).toContain("a");
		expect(REPLACEMENT_CHARS).toContain("0");
	});

	it("MAX_SECRET_ENTRIES is 10000", () => {
		expect(MAX_SECRET_ENTRIES).toBe(10_000);
	});

	it("MAX_SECRET_REGEX_ENTRIES is 256", () => {
		expect(MAX_SECRET_REGEX_ENTRIES).toBe(256);
	});

	it("MAX_SECRET_VALUE_BYTES is 1MB", () => {
		expect(MAX_SECRET_VALUE_BYTES).toBe(1024 * 1024);
	});

	it("MAX_TRANSFORMED_TEXT_BYTES is 16MB", () => {
		expect(MAX_TRANSFORMED_TEXT_BYTES).toBe(16 * 1024 * 1024);
	});

	it("MAX_SECRET_MATCHES_PER_TEXT is 20000", () => {
		expect(MAX_SECRET_MATCHES_PER_TEXT).toBe(20_000);
	});

	it("MAX_PLACEHOLDERS_PER_TEXT is 10000", () => {
		expect(MAX_PLACEHOLDERS_PER_TEXT).toBe(10_000);
	});

	it("MAX_RUNTIME_SECRET_VALUES is 10000", () => {
		expect(MAX_RUNTIME_SECRET_VALUES).toBe(10_000);
	});

	it("MAX_RUNTIME_SECRET_BYTES is 8MB", () => {
		expect(MAX_RUNTIME_SECRET_BYTES).toBe(8 * 1024 * 1024);
	});
});
