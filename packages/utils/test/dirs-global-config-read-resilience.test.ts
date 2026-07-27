import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getSharedAuthStoreDirIfEnabled,
	readGlobalProfileSharingSafe,
	resolveGlobalProfileSharing,
} from "@veyyon/utils/dirs";

/**
 * The credential-store location is decided by `profileSharing` in the global config.
 * A user who set `profileSharing: false` keeps a PER-PROFILE store; the shared store
 * is empty for them. If a global-config read momentarily fails, the resolver must NOT
 * silently treat that as "config absent" and default to shared — that would relocate
 * the store to the empty shared dir and log the user out for that one run, then log
 * them back in the next (Law 10: no silent fallback that loses a login).
 *
 * The realistic trigger is a rebuild: several veyyon processes start at once, and a
 * transient EMFILE / EBUSY / IO error on `config.yml` is a PRESENT-but-unreadable
 * file, not an absent one. `readGlobalConfigRecord` now retries such errors and only
 * treats ENOENT as "no config here". These tests pin that a transient read failure
 * recovers the real posture instead of flipping it, that a genuinely-absent config
 * still defaults to shared, and that an explicit posture reads through unchanged.
 */
describe("Global config reads survive a transient failure without flipping the credential posture", () => {
	let tempRoot = "";
	const KEYS = [
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
		"VEYYON_PROFILE",
		"VEYYON_CODING_AGENT_DIR",
		"VEYYON_CONFIG_DIR",
	];
	const saved: Record<string, string | undefined> = {};

	function writeConfig(contents: string | undefined): string {
		const file = path.join(tempRoot, "config.yml");
		if (contents === undefined) fs.rmSync(file, { force: true });
		else fs.writeFileSync(file, contents);
		__resetDirsFromEnvForTests();
		return file;
	}

	beforeEach(() => {
		for (const key of KEYS) saved[key] = process.env[key];
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_STATE_HOME;
		delete process.env.XDG_CACHE_HOME;
		delete process.env.VEYYON_PROFILE;
		delete process.env.VEYYON_CODING_AGENT_DIR;
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-config-resilience-"));
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
		__resetDirsFromEnvForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		__resetDirsFromEnvForTests();
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	/** Fail the FIRST `failCount` reads of `configPath` with a transient error, then read for real. */
	function makeTransientReadFailure(configPath: string, failCount: number, code = "EMFILE"): { calls: () => number } {
		const real = fs.readFileSync;
		let configReads = 0;
		vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
			if (typeof p === "string" && path.resolve(p) === path.resolve(configPath)) {
				configReads += 1;
				if (configReads <= failCount) {
					const err = new Error(`${code}: emulated transient read failure, open '${p}'`) as NodeJS.ErrnoException;
					err.code = code;
					throw err;
				}
			}
			return (real as (...a: unknown[]) => unknown)(p, ...rest);
		}) as typeof fs.readFileSync);
		return { calls: () => configReads };
	}

	it("recovers the real profileSharing:false posture after a transient read failure (no flip to shared)", () => {
		const configPath = writeConfig("profileSharing: false\n");
		// Sanity: a clean read gives the isolated posture.
		expect(resolveGlobalProfileSharing()).toBe(false);
		expect(getSharedAuthStoreDirIfEnabled()).toBeUndefined();

		// Two transient EMFILE failures, then the real file — inside the retry budget.
		const probe = makeTransientReadFailure(configPath, 2);
		expect(resolveGlobalProfileSharing()).toBe(false);
		// It genuinely retried (1 fail + 1 fail + 1 success = 3 reads), not a lucky first hit.
		expect(probe.calls()).toBe(3);
		// And the store is still the per-profile one, not the empty shared dir.
		expect(getSharedAuthStoreDirIfEnabled()).toBeUndefined();
	});

	it("surfaces a PERSISTENT read failure loudly instead of silently defaulting the posture", () => {
		const configPath = writeConfig("profileSharing: false\n");
		makeTransientReadFailure(configPath, 999);
		// The strict resolver throws (the CLI surfaces it) rather than pretending the
		// file is absent and returning the shared default.
		expect(() => resolveGlobalProfileSharing()).toThrow(/could not be read/);
	});

	it("still treats a genuinely-absent config (ENOENT) as the shared default", () => {
		writeConfig(undefined); // no config.yml at all
		expect(resolveGlobalProfileSharing()).toBe(true);
		expect(getSharedAuthStoreDirIfEnabled()).toBe(path.join(tempRoot, "shared-auth"));
	});

	it("the module-load-safe reader keeps returning the isolated posture through a transient blip", () => {
		const configPath = writeConfig("profileSharing: false\n");
		makeTransientReadFailure(configPath, 1);
		// The safe variant only falls back to shared on a PERSISTENT failure; a single
		// transient error must not flip it.
		expect(readGlobalProfileSharingSafe()).toBe(false);
	});
});
