import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	findShadowedGlobalConfigFiles,
	getGlobalConfigFilePath,
	getGlobalConfigRootDir,
	readGlobalOnboardingVersionSafe,
	readLegacyProfileSetupVersion,
	resolveGlobalDefaultProfile,
	resolveGlobalProfileSharing,
	writeGlobalOnboardingVersion,
} from "@veyyon/utils/dirs";
import { Snowflake } from "@veyyon/utils/snowflake";

let tempRoot = "";
let originalConfigDir: string | undefined;
let originalProfileEnv: string | undefined;

beforeEach(() => {
	originalConfigDir = process.env.VEYYON_CONFIG_DIR;
	originalProfileEnv = process.env.VEYYON_PROFILE;
	delete process.env.VEYYON_PROFILE;
	tempRoot = path.join(os.tmpdir(), `veyyon-global-durability-${Snowflake.next()}`);
	fs.mkdirSync(tempRoot, { recursive: true });
	// Flip the config-dir basename so the global config root lands in the temp tree
	// (same technique as global-config.test.ts and install-id.test.ts).
	process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
});

afterEach(() => {
	if (originalConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
	else process.env.VEYYON_CONFIG_DIR = originalConfigDir;
	if (originalProfileEnv === undefined) delete process.env.VEYYON_PROFILE;
	else process.env.VEYYON_PROFILE = originalProfileEnv;
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Absolute path of one global-config filename inside the isolated root. */
function globalConfig(filename: string): string {
	return path.join(getGlobalConfigRootDir(), filename);
}

function writeGlobalConfig(filename: string, body: string): string {
	const file = globalConfig(filename);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
	return file;
}

/** Fail the first `failCount` reads of `target` with `code`, then read for real. */
function failReadsOf(target: string, failCount: number, code: string): () => void {
	const real = fs.readFileSync;
	let reads = 0;
	const spy = spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
		if (typeof p === "string" && path.resolve(p) === path.resolve(target)) {
			reads += 1;
			if (reads <= failCount) {
				const error = new Error(`${code}: emulated read failure, open '${p}'`) as NodeJS.ErrnoException;
				error.code = code;
				throw error;
			}
		}
		return (real as (...args: unknown[]) => unknown)(p, ...rest);
	}) as typeof fs.readFileSync);
	return () => {
		spy.mockRestore();
	};
}

/**
 * The global config writer used to swallow EVERY read error: `try { text =
 * readFileSync(candidate) } catch { continue; }`. Only ENOENT means "no config
 * here"; EACCES, EMFILE under fd pressure while several rebuilt processes start
 * at once, EIO or an NFS blip all mean the file is PRESENT and momentarily
 * unreadable. Swallowing those left `existing` empty, and the read-modify-write
 * then emitted a file holding ONLY the key being mutated, destroying
 * `defaultProfile`, `profileSharing`, `onboardingVersion` and the auth-broker
 * token in one silent write.
 */
describe("a global config write cannot shrink the file it failed to read", () => {
	const ORIGINAL = [
		"# which profile a bare `vey` opens",
		"defaultProfile: work",
		"profileSharing: false",
		"onboardingVersion: 4",
		"auth:",
		"  broker:",
		"    token: broker-token-value",
		"",
	].join("\n");

	it("aborts the mutation and leaves every byte of the config in place", () => {
		const file = writeGlobalConfig("config.yml", ORIGINAL);
		const restore = failReadsOf(file, Number.MAX_SAFE_INTEGER, "EACCES");

		try {
			expect(() => writeGlobalOnboardingVersion(9)).toThrow(/could not be read/);
		} finally {
			restore();
		}

		// Byte for byte, comment and nested auth token included. The old writer left
		// exactly "onboardingVersion: 9\n" here.
		expect(fs.readFileSync(file, "utf8")).toBe(ORIGINAL);
	});

	it("names the file it refused to write, and releases the lock it took", () => {
		const file = writeGlobalConfig("config.yml", ORIGINAL);
		const restore = failReadsOf(file, Number.MAX_SAFE_INTEGER, "EIO");

		try {
			expect(() => writeGlobalOnboardingVersion(9)).toThrow(file);
		} finally {
			restore();
		}

		// A failed mutation that leaves its lock behind would block every later write
		// for the stale window, turning one transient error into a lasting outage.
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
	});

	it("still rides out a transient read failure rather than aborting on the first blip", () => {
		// The abort must not be trigger-happy: the writer shares the reader's bounded
		// retry, so an EMFILE blip inside the budget completes the write normally.
		const file = writeGlobalConfig("config.yml", "defaultProfile: work\n");
		const restore = failReadsOf(file, 2, "EMFILE");

		try {
			writeGlobalOnboardingVersion(9);
		} finally {
			restore();
		}

		expect(fs.readFileSync(file, "utf8")).toBe("defaultProfile: work\nonboardingVersion: 9\n");
	});
});

/**
 * `readGlobalConfigRecord` returned `{}` both for "no file exists" and for "a
 * file exists but is not a YAML mapping", so a ZERO-BYTE `config.yml` was
 * indistinguishable from a fresh install and re-ran the full setup wizard on a
 * machine onboarded years earlier. The state is reachable from veyyon's own
 * behavior: `mutateGlobalConfigKey` writes an empty file on purpose when it
 * cannot unlink a config it has just emptied.
 */
describe("an unusable global config is not a fresh install", () => {
	it("reports a zero-byte config as unreadable", () => {
		const file = writeGlobalConfig("config.yml", "");
		expect(fs.statSync(file).size).toBe(0);

		expect(readGlobalOnboardingVersionSafe()).toStrictEqual({ version: undefined, unreadable: true });
	});

	it("reports a config that parses to a scalar as unreadable", () => {
		writeGlobalConfig("config.yml", "just-a-string\n");

		expect(readGlobalOnboardingVersionSafe()).toStrictEqual({ version: undefined, unreadable: true });
	});

	it("reports a config that parses to a sequence as unreadable", () => {
		writeGlobalConfig("config.yml", "- one\n- two\n");

		expect(readGlobalOnboardingVersionSafe()).toStrictEqual({ version: undefined, unreadable: true });
	});

	it("reports a genuinely missing config as absent, so a real first install still onboards", () => {
		expect(fs.existsSync(globalConfig("config.yml"))).toBe(false);
		expect(fs.existsSync(globalConfig("config.yaml"))).toBe(false);

		expect(readGlobalOnboardingVersionSafe()).toStrictEqual({ version: undefined, unreadable: false });
	});

	it("reads a recorded generation back unchanged", () => {
		writeGlobalConfig("config.yml", "onboardingVersion: 4\n");

		expect(readGlobalOnboardingVersionSafe()).toStrictEqual({ version: 4, unreadable: false });
	});

	it("keeps the safe default for the readers whose fallback is safe either way", () => {
		// The asymmetry is deliberate: an unusable file carries no keys, and defaulting
		// `profileSharing` or `defaultProfile` is harmless where re-onboarding is not.
		writeGlobalConfig("config.yml", "");

		expect(resolveGlobalProfileSharing()).toBe(true);
		expect(resolveGlobalDefaultProfile()).toBeUndefined();
	});
});

/**
 * The reader returned at the first candidate it could read, whatever that file
 * held, so an empty `config.yml` shadowed a fully populated `config.yaml`
 * permanently: no error, no effect, and every symptom pointing at the setting the
 * user changed rather than at the file they changed it in.
 */
describe("a present-but-unusable config does not shadow a usable one", () => {
	const USABLE = "defaultProfile: work\nonboardingVersion: 7\n";

	it("reads the populated config.yaml past an empty config.yml", () => {
		writeGlobalConfig("config.yml", "");
		writeGlobalConfig("config.yaml", USABLE);

		expect(resolveGlobalDefaultProfile()).toBe("work");
		expect(readGlobalOnboardingVersionSafe()).toStrictEqual({ version: 7, unreadable: false });
		expect(getGlobalConfigFilePath()).toBe(globalConfig("config.yaml"));
	});

	it("reports the empty file as the ignored one, not the file being read", () => {
		writeGlobalConfig("config.yml", "");
		writeGlobalConfig("config.yaml", USABLE);

		expect(findShadowedGlobalConfigFiles(getGlobalConfigRootDir())).toEqual([
			{ ignored: globalConfig("config.yml"), using: globalConfig("config.yaml") },
		]);
	});

	it("writes into the same file it reads, so the write cannot be ignored", () => {
		// A writer that kept targeting config.yml while the reader used config.yaml
		// would report success and change nothing observable.
		writeGlobalConfig("config.yml", "");
		writeGlobalConfig("config.yaml", USABLE);

		expect(writeGlobalOnboardingVersion(8)).toBe(globalConfig("config.yaml"));
		expect(fs.readFileSync(globalConfig("config.yaml"), "utf8")).toBe("defaultProfile: work\nonboardingVersion: 8\n");
		expect(fs.readFileSync(globalConfig("config.yml"), "utf8")).toBe("");
		expect(readGlobalOnboardingVersionSafe()).toStrictEqual({ version: 8, unreadable: false });
	});

	it("still lets a usable config.yml win outright over config.yaml", () => {
		// The precedence itself must not move: the first name wins when it is usable,
		// and the two files are never merged.
		writeGlobalConfig("config.yml", "onboardingVersion: 1\n");
		writeGlobalConfig("config.yaml", "onboardingVersion: 2\n");

		expect(readGlobalOnboardingVersionSafe()).toStrictEqual({ version: 1, unreadable: false });
		expect(getGlobalConfigFilePath()).toBe(globalConfig("config.yml"));
		expect(findShadowedGlobalConfigFiles(getGlobalConfigRootDir())).toEqual([
			{ ignored: globalConfig("config.yaml"), using: globalConfig("config.yml") },
		]);
	});

	it("falls back to the first present file when neither candidate is usable", () => {
		writeGlobalConfig("config.yml", "");
		writeGlobalConfig("config.yaml", "- also-unusable\n");

		expect(getGlobalConfigFilePath()).toBe(globalConfig("config.yml"));
		expect(readGlobalOnboardingVersionSafe()).toStrictEqual({ version: undefined, unreadable: true });
	});

	it("names the canonical config.yml when nothing exists yet", () => {
		expect(getGlobalConfigFilePath()).toBe(globalConfig("config.yml"));
	});
});

/**
 * Onboarding is something a human does once per MACHINE, but the promotion that
 * fills in the global `onboardingVersion` read the retired per-profile
 * `setupVersion` through the settings layer, which resolves the ACTIVE profile
 * only. On the reporting user's disk the record sat in
 * `profiles/work/agent/config.yml` while `profiles/oss-work` had no config file
 * at all, so launching `--profile oss-work` first found nothing, declared a fresh
 * install, and ran the full wizard on a machine onboarded years earlier.
 */
describe("readLegacyProfileSetupVersion scans every profile, not the active one", () => {
	function writeProfileConfig(profile: string, filename: string, body: string): string {
		const file = path.join(getGlobalConfigRootDir(), "profiles", profile, "agent", filename);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, body);
		return file;
	}

	it("finds nothing when no profiles directory exists at all", () => {
		expect(readLegacyProfileSetupVersion()).toStrictEqual({ version: undefined, unreadable: false });
	});

	it("finds nothing when a profile has a config that records no setupVersion", () => {
		writeProfileConfig("work", "config.yml", "theme: dark\n");

		expect(readLegacyProfileSetupVersion()).toStrictEqual({ version: undefined, unreadable: false });
	});

	it("reads the one profile that records a setupVersion", () => {
		writeProfileConfig("work", "config.yml", "setupVersion: 1\n");

		expect(readLegacyProfileSetupVersion()).toStrictEqual({ version: 1, unreadable: false });
	});

	it("returns the maximum when a non-default profile holds the highest value", () => {
		// The reporting user's exact layout: the record lives in a named profile, the
		// default profile holds an older generation, and the profile being launched has
		// no config file whatsoever.
		writeGlobalConfig("config.yml", "defaultProfile: oss-work\n");
		writeProfileConfig("default", "config.yml", "setupVersion: 1\n");
		writeProfileConfig("work", "config.yml", "setupVersion: 4\n");
		writeProfileConfig("veybot", "config.yml", "setupVersion: 2\n");
		fs.mkdirSync(path.join(getGlobalConfigRootDir(), "profiles", "oss-work", "agent"), { recursive: true });

		expect(readLegacyProfileSetupVersion()).toStrictEqual({ version: 4, unreadable: false });
	});

	it("honours the config.yaml spelling with the same precedence as the global config", () => {
		writeProfileConfig("work", "config.yaml", "setupVersion: 3\n");
		writeProfileConfig("other", "config.yml", "setupVersion: 5\n");
		writeProfileConfig("other", "config.yaml", "setupVersion: 99\n");

		// config.yml wins inside `other`, so 99 is the shadowed file and never counts.
		expect(readLegacyProfileSetupVersion()).toStrictEqual({ version: 5, unreadable: false });
	});

	it("reports unreadable for a profile whose config does not parse, instead of skipping it", () => {
		writeProfileConfig("work", "config.yml", "setupVersion: [1\n");

		expect(readLegacyProfileSetupVersion()).toStrictEqual({ version: undefined, unreadable: true });
	});

	it("keeps the versions it did read while flagging the profile it could not", () => {
		writeProfileConfig("work", "config.yml", "setupVersion: 2\n");
		writeProfileConfig("broken", "config.yml", "setupVersion: [1\n");

		expect(readLegacyProfileSetupVersion()).toStrictEqual({ version: 2, unreadable: true });
	});

	it("flags a profile whose config exists but holds no mapping", () => {
		writeProfileConfig("work", "config.yml", "");

		expect(readLegacyProfileSetupVersion()).toStrictEqual({ version: undefined, unreadable: true });
	});

	it("flags a profile whose setupVersion is present but not a number", () => {
		// The profile clearly has something to say about onboarding and it could not be
		// understood. Silently ignoring it is the same "declare a fresh install" bug one
		// level down.
		writeProfileConfig("work", "config.yml", "setupVersion: one\n");

		expect(readLegacyProfileSetupVersion()).toStrictEqual({ version: undefined, unreadable: true });
	});

	it("flags a profile whose config is present but unreadable", () => {
		const file = writeProfileConfig("work", "config.yml", "setupVersion: 3\n");
		const restore = failReadsOf(file, Number.MAX_SAFE_INTEGER, "EACCES");

		try {
			expect(readLegacyProfileSetupVersion()).toStrictEqual({ version: undefined, unreadable: true });
		} finally {
			restore();
		}
	});
});
