/**
 * When the install id cannot be read or written, the process says so instead of quietly becoming a
 * new install on every launch.
 *
 * WHY THIS SUITE EXISTS. `~/.veyyon/install-id` is a per-install UUID that outlives agent state, and
 * server-side dedup for grievance pushes and similar telemetry keys on it. `getInstallId` had three
 * silent paths, all of which end with the caller holding a perfectly ordinary-looking UUID:
 *
 *   1. `catch {}` around the read. A missing file is the first run and says nothing, which is right.
 *      An EXISTING file that cannot be read took the same path, so a permission bit on one file made
 *      the install forget its identity with no error anywhere.
 *   2. A file whose contents are not a UUID was UNLINKED and replaced. Replacing it means the same
 *      machine starts counting as a different install, and nothing recorded that it happened.
 *   3. When the write failed, the generated id was kept in memory with the comment "future processes
 *      will retry". They do retry, and they fail the same way, so every run of veyyon on that machine
 *      reports a different id and dedup keyed on it never dedups anything. That is a permanent,
 *      invisible degradation of a shipped feature (Law 10).
 *
 * None of the three may throw: the install id is resolved during startup and a telemetry detail must
 * not stop the tool from running. The contract is that each one is ANNOUNCED, with an errno or a byte
 * count, so the operator can act on it. `process.emitWarning` carries them rather than the logger,
 * because the logger imports this module for its own paths and importing it back would close a cycle
 * in the module that resolves every path.
 *
 * The ordinary paths are pinned as silent too. A warning on first run, or on every successful read,
 * would make the three above unreadable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { __resetInstallIdCacheForTests, getGlobalConfigRootDir, getInstallId } from "@veyyon/utils/dirs";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "./helpers/isolated-config-root";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Emitted {
	message: string;
	code: string | undefined;
}

/** Mode bits do not restrict root, and Windows does not honour them at all. */
function canRestrictAccess(): boolean {
	return process.platform !== "win32" && process.getuid?.() !== 0;
}

let isolated: IsolatedConfigRoot;
let emitted: Emitted[];
let idFile: string;

/** Only this function's warnings, so an unrelated startup warning cannot satisfy an assertion. */
function installIdWarnings(): Emitted[] {
	return emitted.filter(entry => entry.code?.startsWith("VEYYON_INSTALL_ID"));
}

beforeEach(() => {
	isolated = enterIsolatedConfigRoot("install-id-degradation", { defaultProfile: true });
	__resetInstallIdCacheForTests();
	idFile = path.join(getGlobalConfigRootDir(), "install-id");
	fs.mkdirSync(getGlobalConfigRootDir(), { recursive: true });
	emitted = [];
	vi.spyOn(process, "emitWarning").mockImplementation(((warning: string | Error, options?: unknown) => {
		const code = typeof options === "object" && options !== null ? (options as { code?: string }).code : undefined;
		emitted.push({ message: typeof warning === "string" ? warning : warning.message, code });
	}) as typeof process.emitWarning);
});

afterEach(() => {
	vi.restoreAllMocks();
	__resetInstallIdCacheForTests();
	isolated.restore();
});

describe("getInstallId on a healthy path", () => {
	it("says nothing on the first run, when the file is simply absent", () => {
		// The load-bearing silence. Every clean install takes this path exactly once, and a
		// warning here would train the reader to ignore the three below.
		expect(getInstallId()).toMatch(UUID_RE);
		expect(installIdWarnings()).toEqual([]);
	});

	it("says nothing when it reads back a valid id", () => {
		fs.writeFileSync(idFile, "11111111-2222-3333-4444-555555555555\n");

		expect(getInstallId()).toBe("11111111-2222-3333-4444-555555555555");
		expect(installIdWarnings()).toEqual([]);
	});
});

describe("getInstallId when the stored id is not a UUID", () => {
	it("announces that the install's identity is being replaced, with the byte count", () => {
		// The consequence is not local: anything that identified this install by the old value
		// sees a new install from here on, and without this warning there is no record of when
		// or why the identity changed.
		fs.writeFileSync(idFile, "not-a-uuid\n");

		const id = getInstallId();

		expect(id).toMatch(UUID_RE);
		const reported = installIdWarnings();
		expect(reported.length).toBe(1);
		expect(reported[0]?.code).toBe("VEYYON_INSTALL_ID_INVALID");
		expect(reported[0]?.message).toContain(idFile);
		// The length, not the contents: enough to tell a truncated write from a wrong format
		// without copying an unknown file's bytes into a warning.
		expect(reported[0]?.message).toContain("(10 bytes)");
		expect(reported[0]?.message).toContain("new install");
		expect(fs.readFileSync(idFile, "utf8").trim()).toBe(id);
	});

	it("replaces an empty file silently, and actually persists the new id", () => {
		// A zero-length file is what a crash between the create and the write leaves behind.
		// There is no previous identity to lose, so replacing it is not a change worth
		// reporting — but it MUST be replaced. This is the regression the suite caught: the
		// unlink was gated on `length > 0`, so an empty file was left in place, the `O_EXCL`
		// create then failed with EEXIST on every launch, and the install generated a brand new
		// id forever with nothing on disk and nothing to fix.
		fs.writeFileSync(idFile, "");

		const id = getInstallId();

		expect(id).toMatch(UUID_RE);
		expect(fs.readFileSync(idFile, "utf8").trim()).toBe(id);
		expect(installIdWarnings()).toEqual([]);
	});

	it("replaces a whitespace-only file silently, and persists the new id", () => {
		// Same failure through a different door: the value trims to nothing, so there is no
		// identity to report losing, and the file still has to go.
		fs.writeFileSync(idFile, "\n\n  \n");

		const id = getInstallId();

		expect(id).toMatch(UUID_RE);
		expect(fs.readFileSync(idFile, "utf8").trim()).toBe(id);
		expect(installIdWarnings()).toEqual([]);
	});

	it("persists across a cache reset once the bad file has been replaced", () => {
		// The proof that the replacement stuck: a second process (a cleared cache) reads the id
		// back rather than minting another one. With the old gate this returned a new UUID every
		// time, which is the shape the bug had in production.
		fs.writeFileSync(idFile, "");
		const first = getInstallId();
		__resetInstallIdCacheForTests();

		expect(getInstallId()).toBe(first);
		expect(installIdWarnings()).toEqual([]);
	});
});

describe("getInstallId when the file cannot be read", () => {
	it("announces the errno and that the identity could not be recovered", () => {
		if (!canRestrictAccess()) return;
		fs.writeFileSync(idFile, "11111111-2222-3333-4444-555555555555\n");
		fs.chmodSync(idFile, 0o000);
		try {
			const id = getInstallId();

			// Non-fatal by design: startup continues with an id, it is simply not the stored one.
			expect(id).toMatch(UUID_RE);
			expect(id).not.toBe("11111111-2222-3333-4444-555555555555");

			const reported = installIdWarnings();
			const unreadable = reported.find(entry => entry.code === "VEYYON_INSTALL_ID_UNREADABLE");
			expect(unreadable).toBeDefined();
			expect(unreadable?.message).toContain(idFile);
			expect(unreadable?.message).toContain("EACCES");
			expect(unreadable?.message).toContain("permissions");

			// And the second half of the same failure: the file still exists, so the O_EXCL
			// create fails and the new id is never persisted either. Both are reported, because
			// they are different facts — one lost the old identity, one loses every future one.
			expect(reported.map(entry => entry.code)).toEqual([
				"VEYYON_INSTALL_ID_UNREADABLE",
				"VEYYON_INSTALL_ID_NOT_PERSISTED",
			]);
		} finally {
			fs.chmodSync(idFile, 0o600);
		}
	});
});

describe("getInstallId when the id cannot be persisted", () => {
	it("announces that every future run will generate a different id", () => {
		// The worst of the three, and the least visible: nothing is wrong with this run. The
		// damage is that there is no next run that agrees with it.
		if (!canRestrictAccess()) return;
		const root = getGlobalConfigRootDir();
		fs.chmodSync(root, 0o500);
		try {
			const id = getInstallId();

			expect(id).toMatch(UUID_RE);
			expect(fs.existsSync(idFile)).toBe(false);

			const reported = installIdWarnings();
			expect(reported.length).toBe(1);
			expect(reported[0]?.code).toBe("VEYYON_INSTALL_ID_NOT_PERSISTED");
			expect(reported[0]?.message).toContain(idFile);
			expect(reported[0]?.message).toContain("EACCES");
			expect(reported[0]?.message).toContain("temporary id");
		} finally {
			fs.chmodSync(root, 0o700);
		}
	});

	it("still returns one stable id for the rest of the process", () => {
		// The reason this degrades rather than throwing: within a single run the id has to be
		// consistent, or two calls in one session would look like two installs.
		if (!canRestrictAccess()) return;
		const root = getGlobalConfigRootDir();
		fs.chmodSync(root, 0o500);
		try {
			const first = getInstallId();
			expect(getInstallId()).toBe(first);
			// Cached, so the warning is emitted once rather than on every call.
			expect(installIdWarnings().length).toBe(1);
		} finally {
			fs.chmodSync(root, 0o700);
		}
	});

	it("reports a fresh id on the next run, which is exactly what the warning predicts", () => {
		// Pins the behaviour the message describes, so the message cannot become a lie: clearing
		// the cache stands in for a new process, and the id it produces is a different one.
		if (!canRestrictAccess()) return;
		const root = getGlobalConfigRootDir();
		fs.chmodSync(root, 0o500);
		try {
			const first = getInstallId();
			__resetInstallIdCacheForTests();
			expect(getInstallId()).not.toBe(first);
		} finally {
			fs.chmodSync(root, 0o700);
		}
	});
});
