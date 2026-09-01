import { describe, expect, it } from "bun:test";
import { APP_DIRECTORY_SLUG, APP_DISPLAY_NAME } from "../src/app-identity";
import {
	AGENT_DIR_ENV_KEYS,
	CONFIG_DIR_ENV_KEYS,
	DIR_LOCATION_ENV_KEYS,
	DIR_OVERRIDE_ENV_KEYS,
	PROFILE_ENV_KEYS,
	SANDBOX_MARKER_ENV_KEY,
	XDG_BASE_ENV_KEYS,
} from "../src/dir-env-keys";

describe("app-identity", () => {
	it("APP_DIRECTORY_SLUG is lowercase 'veyyon'", () => {
		expect(APP_DIRECTORY_SLUG).toBe("veyyon");
	});
	it("APP_DISPLAY_NAME is capitalized 'Veyyon'", () => {
		expect(APP_DISPLAY_NAME).toBe("Veyyon");
	});
	it("slug and display name differ", () => {
		expect(APP_DIRECTORY_SLUG).not.toBe(APP_DISPLAY_NAME);
	});
});

describe("dir-env-keys", () => {
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
	it("XDG_BASE_ENV_KEYS contains all four XDG keys", () => {
		expect(XDG_BASE_ENV_KEYS).toContain("XDG_CONFIG_HOME");
		expect(XDG_BASE_ENV_KEYS).toContain("XDG_DATA_HOME");
		expect(XDG_BASE_ENV_KEYS).toContain("XDG_STATE_HOME");
		expect(XDG_BASE_ENV_KEYS).toContain("XDG_CACHE_HOME");
	});
	it("DIR_OVERRIDE_ENV_KEYS is union of agent, profile, config keys", () => {
		expect(DIR_OVERRIDE_ENV_KEYS).toEqual([...AGENT_DIR_ENV_KEYS, ...PROFILE_ENV_KEYS, ...CONFIG_DIR_ENV_KEYS]);
	});
	it("DIR_LOCATION_ENV_KEYS is union of agent, config, XDG keys (no profile)", () => {
		expect(DIR_LOCATION_ENV_KEYS).toEqual([...AGENT_DIR_ENV_KEYS, ...CONFIG_DIR_ENV_KEYS, ...XDG_BASE_ENV_KEYS]);
	});
	it("DIR_LOCATION_ENV_KEYS does NOT contain profile keys", () => {
		for (const key of PROFILE_ENV_KEYS) {
			expect(DIR_LOCATION_ENV_KEYS).not.toContain(key);
		}
	});
	it("DIR_OVERRIDE_ENV_KEYS contains profile keys", () => {
		for (const key of PROFILE_ENV_KEYS) {
			expect(DIR_OVERRIDE_ENV_KEYS).toContain(key);
		}
	});
	it("all key arrays are non-empty", () => {
		expect(AGENT_DIR_ENV_KEYS.length).toBeGreaterThan(0);
		expect(CONFIG_DIR_ENV_KEYS.length).toBeGreaterThan(0);
		expect(PROFILE_ENV_KEYS.length).toBeGreaterThan(0);
		expect(XDG_BASE_ENV_KEYS.length).toBeGreaterThan(0);
	});
});
