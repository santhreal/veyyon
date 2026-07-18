import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getGlobalConfigRootDir,
	migrateLegacyDefaultProfileLayout,
	profileEnvIsSet,
	resolveGlobalDefaultProfile,
	resolveStartupProfile,
	writeGlobalDefaultProfile,
} from "@veyyon/utils/dirs";
import { Snowflake } from "@veyyon/utils/snowflake";

const PROFILE_ENV_KEYS = ["VEYYON_PROFILE"] as const;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

let tempRoot = "";
let originalConfigDir: string | undefined;
const originalProfileEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	originalConfigDir = process.env.VEYYON_CONFIG_DIR;
	for (const key of PROFILE_ENV_KEYS) {
		originalProfileEnv[key] = process.env[key];
		delete process.env[key];
	}
	tempRoot = path.join(os.tmpdir(), `veyyon-global-config-${Snowflake.next()}`);
	fs.mkdirSync(tempRoot, { recursive: true });
	// Flip the config-dir basename so the global config root lands in the temp
	// tree (same technique as install-id.test.ts).
	process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
});

afterEach(() => {
	restoreEnv("VEYYON_CONFIG_DIR", originalConfigDir);
	for (const key of PROFILE_ENV_KEYS) {
		restoreEnv(key, originalProfileEnv[key]);
	}
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("global defaultProfile config", () => {
	it("returns undefined when no global config exists", () => {
		expect(resolveGlobalDefaultProfile()).toBeUndefined();
	});

	it("writes, reads back, and clears defaultProfile", () => {
		const file = writeGlobalDefaultProfile("work");
		expect(file).toBe(path.join(getGlobalConfigRootDir(), "config.yml"));
		expect(fs.readFileSync(file, "utf8")).toContain("defaultProfile: work");
		expect(resolveGlobalDefaultProfile()).toBe("work");

		writeGlobalDefaultProfile(undefined);
		expect(resolveGlobalDefaultProfile()).toBeUndefined();
		// The file held only defaultProfile, so clearing removes it entirely.
		expect(fs.existsSync(file)).toBe(false);
	});

	it("preserves unrelated keys when setting and clearing", () => {
		const file = path.join(getGlobalConfigRootDir(), "config.yml");
		fs.writeFileSync(file, "someOtherKey: keep-me\n");
		writeGlobalDefaultProfile("work");
		expect(fs.readFileSync(file, "utf8")).toContain("someOtherKey: keep-me");
		writeGlobalDefaultProfile(undefined);
		const text = fs.readFileSync(file, "utf8");
		expect(text).toContain("someOtherKey: keep-me");
		expect(text).not.toContain("defaultProfile");
	});

	it('treats "default" as clearing the override', () => {
		writeGlobalDefaultProfile("work");
		writeGlobalDefaultProfile("default");
		expect(resolveGlobalDefaultProfile()).toBeUndefined();
	});

	it("throws a file-naming error on invalid YAML", () => {
		const file = path.join(getGlobalConfigRootDir(), "config.yml");
		fs.writeFileSync(file, "defaultProfile: [unclosed\n");
		expect(() => resolveGlobalDefaultProfile()).toThrow(file);
	});

	it("throws when defaultProfile is not a string", () => {
		const file = path.join(getGlobalConfigRootDir(), "config.yml");
		fs.writeFileSync(file, "defaultProfile: 42\n");
		expect(() => resolveGlobalDefaultProfile()).toThrow("must be a string");
	});

	it("throws on an invalid profile name", () => {
		const file = path.join(getGlobalConfigRootDir(), "config.yml");
		fs.writeFileSync(file, "defaultProfile: 'bad/name'\n");
		expect(() => resolveGlobalDefaultProfile()).toThrow(file);
	});
});

describe("startup profile resolution", () => {
	it("uses the global defaultProfile when no profile env var is set", () => {
		writeGlobalDefaultProfile("work");
		expect(profileEnvIsSet()).toBe(false);
		expect(resolveStartupProfile()).toBe("work");
	});

	it("lets a profile env var beat the global defaultProfile", () => {
		writeGlobalDefaultProfile("work");
		process.env.VEYYON_PROFILE = "other";
		expect(resolveStartupProfile()).toBe("other");
	});

	it("forces the default profile past the global setting when the env var is explicitly empty", () => {
		writeGlobalDefaultProfile("work");
		process.env.VEYYON_PROFILE = "";
		expect(profileEnvIsSet()).toBe(true);
		expect(resolveStartupProfile()).toBeUndefined();
	});

	it("resolves to the default profile when nothing is set", () => {
		expect(resolveStartupProfile()).toBeUndefined();
	});
});

describe("migrateLegacyDefaultProfileLayout", () => {
	it("is a no-op on a fresh or already-migrated root", () => {
		const result = migrateLegacyDefaultProfileLayout();
		expect(result.migrated).toBe(false);
		expect(result.movedEntries).toEqual([]);
	});

	it("moves every non-global root entry into profiles/default", () => {
		const root = getGlobalConfigRootDir();
		fs.mkdirSync(path.join(root, "agent"), { recursive: true });
		fs.writeFileSync(path.join(root, "agent", "agent.db"), "db");
		fs.mkdirSync(path.join(root, "logs"), { recursive: true });
		fs.writeFileSync(path.join(root, "stats.db"), "stats");
		// Global entries that must stay put:
		fs.writeFileSync(path.join(root, "install-id"), "11111111-2222-3333-4444-555555555555\n");
		fs.writeFileSync(path.join(root, "config.yml"), "defaultProfile: work\n");

		const result = migrateLegacyDefaultProfileLayout();
		expect(result.migrated).toBe(true);
		expect(result.movedEntries).toEqual(["agent", "logs", "stats.db"]);
		expect(result.targetDir).toBe(path.join(root, "profiles", "default"));

		expect(fs.readFileSync(path.join(result.targetDir, "agent", "agent.db"), "utf8")).toBe("db");
		expect(fs.existsSync(path.join(result.targetDir, "logs"))).toBe(true);
		expect(fs.readFileSync(path.join(result.targetDir, "stats.db"), "utf8")).toBe("stats");
		// Global state stays at the root and never moves into the profile.
		expect(fs.readFileSync(path.join(root, "install-id"), "utf8")).toContain("1111");
		expect(fs.readFileSync(path.join(root, "config.yml"), "utf8")).toContain("defaultProfile: work");
		expect(fs.existsSync(path.join(root, "agent"))).toBe(false);
		expect(fs.existsSync(path.join(root, "logs"))).toBe(false);
		expect(fs.existsSync(path.join(result.targetDir, "install-id"))).toBe(false);
	});

	it("fails closed when both layouts exist, naming both directories", () => {
		const root = getGlobalConfigRootDir();
		fs.mkdirSync(path.join(root, "agent"), { recursive: true });
		fs.mkdirSync(path.join(root, "profiles", "default"), { recursive: true });
		let error: Error | undefined;
		try {
			migrateLegacyDefaultProfileLayout();
		} catch (thrown) {
			error = thrown as Error;
		}
		expect(error?.message).toContain(path.join(root, "agent"));
		expect(error?.message).toContain(path.join(root, "profiles", "default"));
	});

	it("leaves named profiles untouched under profiles/", () => {
		const root = getGlobalConfigRootDir();
		fs.mkdirSync(path.join(root, "agent"), { recursive: true });
		fs.mkdirSync(path.join(root, "profiles", "work", "agent"), { recursive: true });
		const result = migrateLegacyDefaultProfileLayout();
		expect(result.migrated).toBe(true);
		expect(fs.existsSync(path.join(root, "profiles", "work", "agent"))).toBe(true);
		expect(fs.existsSync(path.join(root, "profiles", "default", "agent"))).toBe(true);
	});
});
