import { afterAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $which, WhichCachePolicy, whichFresh } from "../src/which";

// $which wraps Bun.which with a process-global result cache keyed by command +
// PATH/cwd. Tests use real executables in unique temp PATH dirs (unique dir =>
// distinct hashed cache key, so no cross-test cache bleed) and unique command
// names so default-option lookups (keyed on the bare name) also stay isolated.

const dirs: string[] = [];

async function binDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "which-"));
	dirs.push(dir);
	return dir;
}

async function makeExecutable(dir: string, name: string): Promise<string> {
	const full = path.join(dir, name);
	await writeFile(full, "#!/bin/sh\nexit 0\n");
	await chmod(full, 0o755);
	return full;
}

afterAll(async () => {
	await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe("$which — resolution", () => {
	it("resolves an executable found on the supplied PATH to its full path", async () => {
		const dir = await binDir();
		const name = "veyyon-which-tool-a";
		const full = await makeExecutable(dir, name);
		expect($which(name, { PATH: dir, cache: WhichCachePolicy.Bypass })).toBe(full);
	});

	it("returns null when the command is not on PATH", async () => {
		const dir = await binDir();
		expect($which("veyyon-which-absent-b", { PATH: dir, cache: WhichCachePolicy.Bypass })).toBeNull();
	});

	it("does not leak a resolution from one PATH into a different PATH (distinct cache keys)", async () => {
		const dirA = await binDir();
		const dirB = await binDir();
		const name = "veyyon-which-tool-c";
		const fullA = await makeExecutable(dirA, name);
		// Same command name, two PATHs: dirA has it, dirB does not.
		expect($which(name, { PATH: dirA, cache: WhichCachePolicy.Cached })).toBe(fullA);
		expect($which(name, { PATH: dirB, cache: WhichCachePolicy.Cached })).toBeNull();
	});
});

describe("whichFresh — uncached primitive", () => {
	it("resolves an executable directly with no caching", async () => {
		const dir = await binDir();
		const full = await makeExecutable(dir, "veyyon-which-fresh-d");
		expect(whichFresh("veyyon-which-fresh-d", { PATH: dir })).toBe(full);
	});
});

describe("$which — cache policies", () => {
	it("Cached serves a stale hit while Bypass and Fresh re-resolve after the file disappears", async () => {
		const dir = await binDir();
		const name = "veyyon-which-tool-e";
		const full = await makeExecutable(dir, name);

		// Fresh: perform the lookup and write the cache.
		expect($which(name, { PATH: dir, cache: WhichCachePolicy.Fresh })).toBe(full);

		// The binary vanishes.
		await rm(full, { force: true });

		// Cached still returns the stale path — proves the cache is consulted.
		expect($which(name, { PATH: dir, cache: WhichCachePolicy.Cached })).toBe(full);

		// Bypass ignores the cache entirely and re-resolves against the real FS.
		expect($which(name, { PATH: dir, cache: WhichCachePolicy.Bypass })).toBeNull();

		// Bypass must not have written the cache, so Cached is still the stale hit.
		expect($which(name, { PATH: dir, cache: WhichCachePolicy.Cached })).toBe(full);

		// Fresh re-resolves (now null) AND overwrites the cache.
		expect($which(name, { PATH: dir, cache: WhichCachePolicy.Fresh })).toBeNull();

		// The refreshed null is now what Cached serves.
		expect($which(name, { PATH: dir, cache: WhichCachePolicy.Cached })).toBeNull();
	});

	it("ReadOnly serves an existing cache entry but never writes one", async () => {
		const dir = await binDir();
		const name = "veyyon-which-tool-f";
		const full = await makeExecutable(dir, name);

		// ReadOnly with an empty cache: resolves live but does not persist.
		expect($which(name, { PATH: dir, cache: WhichCachePolicy.ReadOnly })).toBe(full);

		// Remove the file; because ReadOnly never wrote a cache entry, a Cached
		// lookup has nothing to serve and must re-resolve to null.
		await rm(full, { force: true });
		expect($which(name, { PATH: dir, cache: WhichCachePolicy.Cached })).toBeNull();
	});
});
