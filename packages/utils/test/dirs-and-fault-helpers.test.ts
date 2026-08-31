import { describe, expect, it } from "bun:test";
import {
	AGENT_DIR_ENV_KEYS,
	CONFIG_DIR_ENV_KEYS,
	DIR_LOCATION_ENV_KEYS,
	DIR_OVERRIDE_ENV_KEYS,
	PROFILE_ENV_KEYS,
	SANDBOX_MARKER_ENV_KEY,
	XDG_BASE_ENV_KEYS,
} from "../src/dir-env-keys";
import {
	APP_ALIAS,
	APP_NAME,
	CHANGELOG_URL,
	CONFIG_DIR_NAME,
	changelogUrlForVersion,
	DEFAULT_PROFILE_DIR_NAME,
	isUsableXdgBase,
	MIN_BUN_VERSION,
	normalizeProfileName,
	PROFILE_NAME_RE,
	PROFILES_DIR_NAME,
	resolveProfileEnv,
	SITE_URL,
	VERSION,
	WINDOWS_RESERVED_BASENAME_RE,
} from "../src/dirs-helpers";
import { bestEffort, optionalResult } from "../src/discarded-fault";

describe("normalizeProfileName", () => {
	it("returns undefined for undefined", () => {
		expect(normalizeProfileName(undefined)).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(normalizeProfileName("")).toBeUndefined();
	});

	it("returns undefined for whitespace-only string", () => {
		expect(normalizeProfileName("   ")).toBeUndefined();
	});

	it("returns undefined for 'default'", () => {
		expect(normalizeProfileName("default")).toBeUndefined();
	});

	it("returns trimmed name for valid profile", () => {
		expect(normalizeProfileName("work")).toBe("work");
	});

	it("trims whitespace around name", () => {
		expect(normalizeProfileName("  work  ")).toBe("work");
	});

	it("accepts alphanumeric with dots, dashes, underscores", () => {
		expect(normalizeProfileName("my.profile-1_test")).toBe("my.profile-1_test");
	});

	it("throws for '.'", () => {
		expect(() => normalizeProfileName(".")).toThrow();
	});

	it("throws for '..'", () => {
		expect(() => normalizeProfileName("..")).toThrow();
	});

	it("throws for name ending with dot", () => {
		expect(() => normalizeProfileName("work.")).toThrow();
	});

	it("throws for name starting with non-alphanumeric", () => {
		expect(() => normalizeProfileName("-work")).toThrow();
	});

	it("throws for name with spaces", () => {
		expect(() => normalizeProfileName("my work")).toThrow();
	});

	it("throws for Windows reserved name CON", () => {
		expect(() => normalizeProfileName("CON")).toThrow();
	});

	it("throws for Windows reserved name PRN", () => {
		expect(() => normalizeProfileName("PRN")).toThrow();
	});

	it("throws for Windows reserved name AUX", () => {
		expect(() => normalizeProfileName("AUX")).toThrow();
	});

	it("throws for Windows reserved name NUL", () => {
		expect(() => normalizeProfileName("NUL")).toThrow();
	});

	it("throws for Windows reserved name COM1", () => {
		expect(() => normalizeProfileName("COM1")).toThrow();
	});

	it("throws for Windows reserved name LPT0", () => {
		expect(() => normalizeProfileName("LPT0")).toThrow();
	});

	it("throws for Windows reserved name with extension", () => {
		expect(() => normalizeProfileName("CON.txt")).toThrow();
	});

	it("accepts name starting with a number", () => {
		expect(normalizeProfileName("2nd-profile")).toBe("2nd-profile");
	});

	it("accepts single character name", () => {
		expect(normalizeProfileName("a")).toBe("a");
	});
});

describe("resolveProfileEnv", () => {
	it("delegates to normalizeProfileName", () => {
		expect(resolveProfileEnv("work")).toBe("work");
		expect(resolveProfileEnv(undefined)).toBeUndefined();
		expect(resolveProfileEnv("default")).toBeUndefined();
	});

	it("trims whitespace", () => {
		expect(resolveProfileEnv("  work  ")).toBe("work");
	});

	it("throws for invalid names", () => {
		expect(() => resolveProfileEnv("CON")).toThrow();
	});
});

describe("isUsableXdgBase", () => {
	it("returns true for absolute path", () => {
		expect(isUsableXdgBase("XDG_CONFIG_HOME", "/home/user/.config")).toBe(true);
	});

	it("returns false for relative path", () => {
		expect(isUsableXdgBase("XDG_CONFIG_HOME", "relative/path")).toBe(false);
	});

	it("returns true for root path", () => {
		expect(isUsableXdgBase("XDG_CONFIG_HOME", "/")).toBe(true);
	});

	it("returns false for empty string", () => {
		expect(isUsableXdgBase("XDG_CONFIG_HOME", "")).toBe(false);
	});

	it("returns false for ./relative path", () => {
		expect(isUsableXdgBase("XDG_CONFIG_HOME", "./config")).toBe(false);
	});

	it("returns false for ../relative path", () => {
		expect(isUsableXdgBase("XDG_CONFIG_HOME", "../config")).toBe(false);
	});
});

describe("changelogUrlForVersion", () => {
	it("returns changelog URL with version anchor", () => {
		expect(changelogUrlForVersion("1.2.3")).toBe("https://veyyon.dev/changelog#v1-2-3");
	});

	it("handles version with v prefix", () => {
		expect(changelogUrlForVersion("v1.0.0")).toBe("https://veyyon.dev/changelog#v1-0-0");
	});

	it("handles empty version", () => {
		expect(changelogUrlForVersion("")).toBe("https://veyyon.dev/changelog#v");
	});

	it("replaces dots with dashes in anchor", () => {
		expect(changelogUrlForVersion("2.3.4")).toContain("#v2-3-4");
	});
});

describe("constants", () => {
	it("APP_NAME is a non-empty string", () => {
		expect(typeof APP_NAME).toBe("string");
		expect(APP_NAME.length).toBeGreaterThan(0);
	});

	it("APP_ALIAS is 'vey'", () => {
		expect(APP_ALIAS).toBe("vey");
	});

	it("SITE_URL is veyyon.dev", () => {
		expect(SITE_URL).toBe("https://veyyon.dev");
	});

	it("CHANGELOG_URL is veyyon.dev/changelog", () => {
		expect(CHANGELOG_URL).toBe("https://veyyon.dev/changelog");
	});

	it("CONFIG_DIR_NAME is .veyyon", () => {
		expect(CONFIG_DIR_NAME).toBe(".veyyon");
	});

	it("DEFAULT_PROFILE_DIR_NAME is 'default'", () => {
		expect(DEFAULT_PROFILE_DIR_NAME).toBe("default");
	});

	it("PROFILES_DIR_NAME is 'profiles'", () => {
		expect(PROFILES_DIR_NAME).toBe("profiles");
	});

	it("VERSION is a non-empty string", () => {
		expect(typeof VERSION).toBe("string");
		expect(VERSION.length).toBeGreaterThan(0);
	});

	it("MIN_BUN_VERSION is a non-empty string", () => {
		expect(typeof MIN_BUN_VERSION).toBe("string");
		expect(MIN_BUN_VERSION.length).toBeGreaterThan(0);
	});

	it("PROFILE_NAME_RE matches valid names", () => {
		expect(PROFILE_NAME_RE.test("work")).toBe(true);
		expect(PROFILE_NAME_RE.test("my-profile")).toBe(true);
		expect(PROFILE_NAME_RE.test("profile1")).toBe(true);
	});

	it("PROFILE_NAME_RE rejects invalid names", () => {
		expect(PROFILE_NAME_RE.test("-work")).toBe(false);
		expect(PROFILE_NAME_RE.test("")).toBe(false);
		expect(PROFILE_NAME_RE.test("my work")).toBe(false);
	});

	it("WINDOWS_RESERVED_BASENAME_RE matches reserved names", () => {
		expect(WINDOWS_RESERVED_BASENAME_RE.test("CON")).toBe(true);
		expect(WINDOWS_RESERVED_BASENAME_RE.test("PRN")).toBe(true);
		expect(WINDOWS_RESERVED_BASENAME_RE.test("COM1")).toBe(true);
		expect(WINDOWS_RESERVED_BASENAME_RE.test("LPT0")).toBe(true);
	});

	it("WINDOWS_RESERVED_BASENAME_RE does not match normal names", () => {
		expect(WINDOWS_RESERVED_BASENAME_RE.test("work")).toBe(false);
		expect(WINDOWS_RESERVED_BASENAME_RE.test("config")).toBe(false);
	});
});

describe("dir-env-keys constants", () => {
	it("AGENT_DIR_ENV_KEYS contains VEYYON_CODING_AGENT_DIR", () => {
		expect(AGENT_DIR_ENV_KEYS).toContain("VEYYON_CODING_AGENT_DIR");
	});

	it("CONFIG_DIR_ENV_KEYS contains VEYYON_CONFIG_DIR", () => {
		expect(CONFIG_DIR_ENV_KEYS).toContain("VEYYON_CONFIG_DIR");
	});

	it("PROFILE_ENV_KEYS contains VEYYON_PROFILE", () => {
		expect(PROFILE_ENV_KEYS).toContain("VEYYON_PROFILE");
	});

	it("SANDBOX_MARKER_ENV_KEY is VEYYON_TEST_SANDBOX", () => {
		expect(SANDBOX_MARKER_ENV_KEY).toBe("VEYYON_TEST_SANDBOX");
	});

	it("XDG_BASE_ENV_KEYS contains XDG_CONFIG_HOME", () => {
		expect(XDG_BASE_ENV_KEYS).toContain("XDG_CONFIG_HOME");
	});

	it("DIR_OVERRIDE_ENV_KEYS is union of agent, profile, config keys", () => {
		expect(DIR_OVERRIDE_ENV_KEYS).toEqual([...AGENT_DIR_ENV_KEYS, ...PROFILE_ENV_KEYS, ...CONFIG_DIR_ENV_KEYS]);
	});

	it("DIR_LOCATION_ENV_KEYS is union of agent, config, xdg keys", () => {
		expect(DIR_LOCATION_ENV_KEYS).toEqual([...AGENT_DIR_ENV_KEYS, ...CONFIG_DIR_ENV_KEYS, ...XDG_BASE_ENV_KEYS]);
	});
});

describe("bestEffort", () => {
	it("completes when promise resolves", async () => {
		await bestEffort(Promise.resolve("ok"), "test");
		// If we get here, the test passes
		expect(true).toBe(true);
	});

	it("completes when promise rejects", async () => {
		await bestEffort(Promise.reject(new Error("fail")), "test");
		// If we get here, the rejection was swallowed
		expect(true).toBe(true);
	});

	it("completes for promise resolving to undefined", async () => {
		await bestEffort(Promise.resolve(undefined), "test");
		expect(true).toBe(true);
	});
});

describe("optionalResult", () => {
	it("returns the value when promise resolves", async () => {
		expect(await optionalResult(Promise.resolve(42), "test")).toBe(42);
	});

	it("returns undefined when promise rejects", async () => {
		expect(await optionalResult(Promise.reject(new Error("fail")), "test")).toBeUndefined();
	});

	it("returns the value for complex objects", async () => {
		const obj = { a: 1, b: "hello" };
		expect(await optionalResult(Promise.resolve(obj), "test")).toEqual(obj);
	});

	it("returns undefined when promise rejects with non-Error", async () => {
		expect(await optionalResult(Promise.reject("string error"), "test")).toBeUndefined();
	});

	it("returns string value when promise resolves", async () => {
		expect(await optionalResult(Promise.resolve("hello"), "test")).toBe("hello");
	});
});
