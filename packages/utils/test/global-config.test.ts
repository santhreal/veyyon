import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getGlobalConfigRootDir,
	getSharedAuthDir,
	migrateLegacyDefaultProfileLayout,
	profileEnvIsSet,
	readGlobalProfileSharingSafe,
	resolveGlobalDefaultProfile,
	resolveGlobalProfileSharing,
	resolveStartupProfile,
	writeGlobalDefaultProfile,
	writeGlobalProfileSharing,
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

	it("leaves no lock directory behind after a write", () => {
		const file = path.join(getGlobalConfigRootDir(), "config.yml");
		writeGlobalDefaultProfile("work");
		// The cross-process lock is released inside the critical section, so no
		// `.lock` directory may linger to block the next writer.
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
	});

	it("reaps a stale lock left by a dead writer and still records the profile", () => {
		const file = path.join(getGlobalConfigRootDir(), "config.yml");
		const lockPath = `${file}.lock`;
		// Simulate a crashed writer: a lock dir owned by a pid that is not alive.
		// Pid 0x7fffffff is not a running process, so the reaper clears it.
		fs.mkdirSync(getGlobalConfigRootDir(), { recursive: true });
		fs.mkdirSync(lockPath);
		fs.writeFileSync(path.join(lockPath, "info"), JSON.stringify({ pid: 0x7fffffff, timestamp: 1, token: "dead" }));

		writeGlobalDefaultProfile("work");
		expect(resolveGlobalDefaultProfile()).toBe("work");
		expect(fs.existsSync(lockPath)).toBe(false);
	});
});

describe("global profileSharing config (credential scope)", () => {
	it("defaults to shared (true) when no global config exists", () => {
		expect(resolveGlobalProfileSharing()).toBe(true);
	});

	it("defaults to shared when the key is absent from an existing config", () => {
		fs.mkdirSync(getGlobalConfigRootDir(), { recursive: true });
		fs.writeFileSync(path.join(getGlobalConfigRootDir(), "config.yml"), "defaultProfile: work\n");
		expect(resolveGlobalProfileSharing()).toBe(true);
	});

	it("writes false to isolate, reads it back, and re-sharing clears the key", () => {
		const file = writeGlobalProfileSharing(false);
		expect(file).toBe(path.join(getGlobalConfigRootDir(), "config.yml"));
		expect(fs.readFileSync(file, "utf8")).toContain("profileSharing: false");
		expect(resolveGlobalProfileSharing()).toBe(false);

		// Re-enabling sharing is the default posture, so the key is removed rather
		// than written as an explicit `true`.
		writeGlobalProfileSharing(true);
		expect(resolveGlobalProfileSharing()).toBe(true);
		expect(fs.existsSync(file)).toBe(false);
	});

	it("preserves unrelated keys when isolating and re-sharing", () => {
		writeGlobalDefaultProfile("work");
		writeGlobalProfileSharing(false);
		const file = path.join(getGlobalConfigRootDir(), "config.yml");
		let text = fs.readFileSync(file, "utf8");
		expect(text).toContain("defaultProfile: work");
		expect(text).toContain("profileSharing: false");

		writeGlobalProfileSharing(true);
		text = fs.readFileSync(file, "utf8");
		expect(text).toContain("defaultProfile: work");
		expect(text).not.toContain("profileSharing");
	});

	it("throws naming the posture when the value is not a boolean", () => {
		fs.mkdirSync(getGlobalConfigRootDir(), { recursive: true });
		fs.writeFileSync(path.join(getGlobalConfigRootDir(), "config.yml"), "profileSharing: sometimes\n");
		expect(() => resolveGlobalProfileSharing()).toThrow("must be a boolean");
	});

	it("safe reader falls back to shared on invalid YAML instead of throwing", () => {
		fs.mkdirSync(getGlobalConfigRootDir(), { recursive: true });
		fs.writeFileSync(path.join(getGlobalConfigRootDir(), "config.yml"), "profileSharing: [unclosed\n");
		expect(() => resolveGlobalProfileSharing()).toThrow();
		expect(readGlobalProfileSharingSafe()).toBe(true);
	});

	it("locates the shared auth store under the global config root, clear of legacy agent/", () => {
		const dir = getSharedAuthDir();
		expect(dir).toBe(path.join(getGlobalConfigRootDir(), "shared-auth"));
		// Must not collide with the legacy `~/.veyyon/agent` layout (which triggers
		// the legacy-migration path) or with profiles/.
		expect(path.basename(dir)).not.toBe("agent");
		expect(dir).not.toContain(`${path.sep}profiles${path.sep}`);
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

	it("resumes an interrupted migration and moves the remaining root entries", () => {
		const root = getGlobalConfigRootDir();
		const target = path.join(root, "profiles", "default");
		// Simulate a migration killed mid-loop: the marker survives, some entries
		// already landed in profiles/default, and others are still at the root.
		fs.mkdirSync(target, { recursive: true });
		fs.writeFileSync(path.join(target, ".migration-in-progress"), "");
		fs.mkdirSync(path.join(target, "logs"), { recursive: true }); // already moved
		fs.mkdirSync(path.join(root, "agent"), { recursive: true }); // not yet moved
		fs.writeFileSync(path.join(root, "stats.db"), "stats"); // not yet moved

		const result = migrateLegacyDefaultProfileLayout();
		expect(result.migrated).toBe(true);
		expect(result.movedEntries).toEqual(["agent", "stats.db"]);
		// Every entry now lives under the profile, the marker is gone, and nothing
		// is left orphaned at the root.
		expect(fs.existsSync(path.join(target, "agent"))).toBe(true);
		expect(fs.readFileSync(path.join(target, "stats.db"), "utf8")).toBe("stats");
		expect(fs.existsSync(path.join(target, "logs"))).toBe(true);
		expect(fs.existsSync(path.join(target, ".migration-in-progress"))).toBe(false);
		expect(fs.existsSync(path.join(root, "agent"))).toBe(false);
		expect(fs.existsSync(path.join(root, "stats.db"))).toBe(false);
	});

	it("resumes even after the legacy agent dir was already moved (no silent orphan)", () => {
		const root = getGlobalConfigRootDir();
		const target = path.join(root, "profiles", "default");
		// The killed run had already moved agent/ into the profile, leaving only a
		// stray sibling at the root. Without the marker this used to read as
		// "already migrated" and strand the sibling forever; the marker forces a
		// resume that sweeps it in.
		fs.mkdirSync(path.join(target, "agent"), { recursive: true });
		fs.writeFileSync(path.join(target, ".migration-in-progress"), "");
		fs.mkdirSync(path.join(root, "logs"), { recursive: true });

		const result = migrateLegacyDefaultProfileLayout();
		expect(result.migrated).toBe(true);
		expect(result.movedEntries).toEqual(["logs"]);
		expect(fs.existsSync(path.join(target, "logs"))).toBe(true);
		expect(fs.existsSync(path.join(root, "logs"))).toBe(false);
		expect(fs.existsSync(path.join(target, ".migration-in-progress"))).toBe(false);
	});
});

/**
 * Removing the last key from the global config deletes the file, and that
 * delete used to happen inside an empty `catch {}`.
 *
 * When the unlink failed, on a read-only config directory, with the file held
 * open by another process on Windows, or with an immutable bit set, the file
 * kept its previous contents and nothing was written. The key the caller had
 * just removed therefore came back on the very next read. The concrete case is
 * `writeGlobalProfileSharing(true)`, which restores the default posture by
 * DELETING the key: it reported success, and credential sharing stayed off.
 */
describe("global config cleanup when the file cannot be unlinked", () => {
	function failUnlink(code: string): () => void {
		const spy = spyOn(fs, "unlinkSync").mockImplementation(() => {
			const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
			error.code = code;
			throw error;
		});
		return () => spy.mockRestore();
	}

	it("persists the removal by emptying the file when unlink fails", () => {
		writeGlobalProfileSharing(false);
		expect(resolveGlobalProfileSharing()).toBe(false);
		const restore = failUnlink("EPERM");

		try {
			const file = writeGlobalProfileSharing(true);

			expect(fs.readFileSync(file, "utf8")).toBe("");
		} finally {
			restore();
		}
	});

	it("does not resurrect the removed value on the next read", () => {
		// The failure the user actually sees: sharing is turned back on, veyyon says
		// it worked, and the next command still runs with sharing off.
		writeGlobalProfileSharing(false);
		const restore = failUnlink("EPERM");

		try {
			writeGlobalProfileSharing(true);

			expect(resolveGlobalProfileSharing()).toBe(true);
		} finally {
			restore();
		}
	});

	it("warns with the path and the cause so the state is explainable", async () => {
		writeGlobalDefaultProfile("work");
		const restore = failUnlink("EACCES");
		const warnings: Array<{ message: string; code?: string }> = [];
		const onWarning = (warning: Error & { code?: string }) => {
			warnings.push({ message: warning.message, code: warning.code });
		};
		process.on("warning", onWarning);

		try {
			const file = writeGlobalDefaultProfile(undefined);
			// process.emitWarning delivers on the next tick, so the listener has to
			// outlive the call that triggers it.
			await Bun.sleep(0);

			const mine = warnings.find(w => w.code === "VEYYON_CONFIG_UNLINK_FAILED");
			expect(mine).toBeDefined();
			expect(mine?.message).toContain(file);
			expect(mine?.message).toContain("EACCES");
			expect(mine?.message).toContain("defaultProfile");
		} finally {
			restore();
			process.off("warning", onWarning);
		}
	});

	it("treats an already-absent file as a clean removal, with no warning", async () => {
		// ENOENT means the file is already gone, which is the outcome that was
		// wanted. Only a real failure earns a warning, or the warning stops meaning
		// anything, and nothing gets written back over a file that is not there.
		writeGlobalDefaultProfile("work");
		const restore = failUnlink("ENOENT");
		const warnings: string[] = [];
		const onWarning = (warning: Error & { code?: string }) => {
			if (warning.code === "VEYYON_CONFIG_UNLINK_FAILED") warnings.push(warning.message);
		};
		process.on("warning", onWarning);

		try {
			const file = writeGlobalDefaultProfile(undefined);
			await Bun.sleep(0);

			expect(warnings).toEqual([]);
			// The stub kept the file on disk, so this asserts the real point: the
			// ENOENT branch wrote nothing, leaving the file exactly as it was.
			expect(fs.readFileSync(file, "utf8")).toContain("work");
		} finally {
			restore();
			process.off("warning", onWarning);
		}
	});

	it("still deletes the file outright when unlink works", () => {
		// The happy path has to keep working: no empty stub left behind.
		const file = writeGlobalDefaultProfile("work");
		expect(fs.existsSync(file)).toBe(true);

		writeGlobalDefaultProfile(undefined);

		expect(fs.existsSync(file)).toBe(false);
	});

	it("leaves other keys untouched when only one of several is removed", () => {
		// The unlink path is only reached when the record empties. With a sibling key
		// present the file is rewritten normally and must keep that sibling.
		writeGlobalDefaultProfile("work");
		writeGlobalProfileSharing(false);

		writeGlobalDefaultProfile(undefined);

		expect(resolveGlobalProfileSharing()).toBe(false);
		expect(resolveGlobalDefaultProfile()).toBeUndefined();
	});
});
