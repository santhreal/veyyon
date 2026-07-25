/**
 * The per-version native addon cache leaked one full copy per release.
 *
 * `~/.veyyon/natives/<version>/` holds the platform's addon variants, on the
 * order of 150MB. Every install and every `veyyon update` wrote a new one and
 * nothing ever removed the old, so a machine that had been through three
 * updates carried three full copies and only a complete uninstall reclaimed
 * them. An older version's cache can never be loaded again: the loader probes
 * only its own version's directory, and the addon carries a version sentinel
 * that a different release physically cannot expose. It is dead weight from the
 * moment the new one is staged.
 *
 * These tests exist because the function DELETES DIRECTORIES. Most of them are
 * about what it must refuse to touch.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pruneOldNativeCaches } from "../native/loader-state.js";

describe("pruneOldNativeCaches", () => {
	let root: string;

	/** Create a cache directory holding one addon-sized placeholder file. */
	function seedCache(name: string): string {
		const dir = path.join(root, name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "veyyon_natives.linux-x64.node"), "addon bytes");
		return dir;
	}

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-natives-prune-"));
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("removes every version except the one being kept", () => {
		const old1 = seedCache("1.0.35");
		const old2 = seedCache("1.0.36");
		const keep = seedCache("1.0.37");

		const result = pruneOldNativeCaches("1.0.37", root);

		expect(fs.existsSync(keep)).toBe(true);
		expect(fs.existsSync(old1)).toBe(false);
		expect(fs.existsSync(old2)).toBe(false);
		expect(result.removed.sort()).toEqual([old1, old2].sort());
		expect(result.failed).toEqual([]);
	});

	it("removes the cache's contents, not just the directory entry", () => {
		// The whole point is reclaiming the ~150MB inside; an rmdir that failed on
		// a non-empty directory would report success and free nothing.
		const old = seedCache("1.0.36");
		pruneOldNativeCaches("1.0.37", root);
		expect(fs.existsSync(path.join(old, "veyyon_natives.linux-x64.node"))).toBe(false);
	});

	it("keeps a prerelease cache that is the current version", () => {
		const keep = seedCache("1.1.0-rc.2");
		seedCache("1.0.37");
		pruneOldNativeCaches("1.1.0-rc.2", root);
		expect(fs.existsSync(keep)).toBe(true);
	});

	it("prunes a prerelease cache that is not the current version", () => {
		// A user who tried an rc and moved to the release keeps both otherwise.
		const stale = seedCache("1.1.0-rc.2");
		seedCache("1.1.0");
		const result = pruneOldNativeCaches("1.1.0", root);
		expect(fs.existsSync(stale)).toBe(false);
		expect(result.removed).toEqual([stale]);
	});

	it("refuses to touch anything that is not a version directory", () => {
		// This function deletes directories under a path derived from
		// $XDG_DATA_HOME, which a user may point anywhere. It removes only names
		// it can positively identify as its own.
		fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
		fs.mkdirSync(path.join(root, "1.0"), { recursive: true });
		fs.mkdirSync(path.join(root, "v1.0.36"), { recursive: true });
		fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });

		const result = pruneOldNativeCaches("1.0.37", root);

		expect(fs.existsSync(path.join(root, "sessions"))).toBe(true);
		expect(fs.existsSync(path.join(root, "1.0"))).toBe(true);
		// `v1.0.36` is not the shape versionedNativeCacheDir writes, so it was put
		// there by something else.
		expect(fs.existsSync(path.join(root, "v1.0.36"))).toBe(true);
		expect(fs.existsSync(path.join(root, ".tmp"))).toBe(true);
		expect(result.removed).toEqual([]);
	});

	it("leaves a plain file alone even when it is named like a version", () => {
		const file = path.join(root, "1.0.36");
		fs.writeFileSync(file, "not a cache");
		const result = pruneOldNativeCaches("1.0.37", root);
		expect(fs.existsSync(file)).toBe(true);
		expect(result.removed).toEqual([]);
	});

	it("does nothing, and reports nothing, when only the current version exists", () => {
		// The steady state after every boot. Reporting a reclaim here would print
		// a line on every single run.
		const keep = seedCache("1.0.37");
		const result = pruneOldNativeCaches("1.0.37", root);
		expect(fs.existsSync(keep)).toBe(true);
		expect(result).toEqual({ removed: [], failed: [] });
	});

	it("treats a missing cache root as nothing to do, not as a failure", () => {
		// A first install has no natives root yet. Reporting a failure there would
		// print an error on the one run where everything is fine.
		const result = pruneOldNativeCaches("1.0.37", path.join(root, "does-not-exist"));
		expect(result).toEqual({ removed: [], failed: [] });
	});

	it("reports a cache it cannot remove instead of throwing", () => {
		// Reclaiming disk must never fail a boot or an install. A directory whose
		// parent is read-only comes back in `failed` and is retried next upgrade.
		seedCache("1.0.36");
		fs.chmodSync(root, 0o500);
		try {
			const result = pruneOldNativeCaches("1.0.37", root);
			expect(result.removed).toEqual([]);
			expect(result.failed).toHaveLength(1);
			expect(result.failed[0]?.dir).toBe(path.join(root, "1.0.36"));
			expect(result.failed[0]?.reason.length).toBeGreaterThan(0);
		} finally {
			fs.chmodSync(root, 0o700);
		}
	});

	it("keeps pruning the rest after one directory fails", () => {
		// One stuck cache must not cost the user every other reclaim.
		seedCache("1.0.34");
		seedCache("1.0.35");
		const result = pruneOldNativeCaches("1.0.37", root);
		expect(result.removed).toHaveLength(2);
	});
});
