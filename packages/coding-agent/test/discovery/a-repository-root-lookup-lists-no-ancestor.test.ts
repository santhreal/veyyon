/**
 * Finding the repository root checks each ancestor of the start directory for a `.git` entry and
 * lists no ancestor.
 *
 * WHY THIS SUITE EXISTS. `findRepoRoot` and `walkUp` answered "does this directory hold `.git`" by
 * reading the whole directory with `readdir` and searching the entries. Every capability load calls
 * `findRepoRoot(cwd)`, so a session start listed each directory from the working directory up to the
 * repository root, or up to `/` outside a repository, held every listing for the life of the process,
 * and listed them again for each concurrent load. A working directory under a 1,700-entry directory
 * held 3,669 objects and 259 KiB after twenty concurrent lookups; a home directory outside any
 * repository held 185 KiB.
 *
 * THE CLASS, NOT THE INCIDENT. The defect is any lookup of one named entry that lists the directory
 * it looks in. The sweep loads every registered capability, and the legacy prompt-file scan, from a
 * working directory three levels below a repository root and from one outside any repository, with
 * every ancestor holding sibling entries, and records every directory a `readdir` call lists. No
 * directory on the path from the working directory to `/` may appear, so a capability or provider
 * that lists an ancestor to find one name goes red, including one registered later. The bound test
 * pins the cost of the lookup: concurrent lookups from one directory share one walk of one `lstat`
 * per ancestor, and an invalidation starts one new walk.
 *
 * WHAT IT DOES NOT CATCH. A listing made through a native scanner (`Bun.Glob`, the native walker) or
 * through `opendir` is not recorded. A provider that lists a directory below the working directory,
 * or a profile or home configuration directory, is outside the class and is not flagged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import "@veyyon/coding-agent/discovery";
import {
	captureRegistryForTests,
	initializeWithSettings,
	listCapabilities,
	loadCapability,
	type RegistrySnapshot,
	restoreRegistryForTests,
} from "@veyyon/coding-agent/discovery/capability";
import { clearCache, findRepoRoot, invalidate, walkUp } from "@veyyon/coding-agent/discovery/capability/fs";
import { findLegacyPromptFiles } from "@veyyon/coding-agent/legacy-system-prompt-files";
import { type ContextScopeFixture, useContextScopeFixture } from "../helpers/context-scope-fixture";

const fixture = useContextScopeFixture("repo-root-lookup-");

/** Sibling entries written into every ancestor, so a listing of one is not free. */
const SIBLINGS = 40;

interface Tree {
	f: ContextScopeFixture;
	/** Three levels below the repository root. */
	cwd: string;
	/** Every directory from `cwd` up to and including the filesystem root. */
	ancestors: string[];
}

function tree(): Tree {
	const f = fixture("lookup");
	const cwd = path.join(f.repoRoot, "pkg", "a", "b");
	fs.mkdirSync(cwd, { recursive: true });
	const ancestors: string[] = [];
	for (let dir = cwd; ; dir = path.dirname(dir)) {
		ancestors.push(dir);
		if (path.dirname(dir) === dir) break;
	}
	for (const dir of ancestors.slice(0, ancestors.indexOf(f.home) + 1)) {
		for (let k = 0; k < SIBLINGS; k++) fs.writeFileSync(path.join(dir, `sibling-${k}.txt`), "");
	}
	return { f, cwd, ancestors };
}

/** Directories listed by `readdir` while `run` executes, in call order. */
async function listedDuring(run: () => Promise<void>): Promise<string[]> {
	const listed: string[] = [];
	const record = (dir: fs.PathLike) => listed.push(path.resolve(String(dir)));
	const readdir = fs.promises.readdir;
	const readdirSync = fs.readdirSync;
	const readdirModule = fsp.readdir;
	vi.spyOn(fs.promises, "readdir").mockImplementation(((dir: fs.PathLike, options?: unknown) => {
		record(dir);
		return Reflect.apply(readdir, fs.promises, [dir, options]);
	}) as typeof fs.promises.readdir);
	vi.spyOn(fs, "readdirSync").mockImplementation(((dir: fs.PathLike, options?: unknown) => {
		record(dir);
		return Reflect.apply(readdirSync, fs, [dir, options]);
	}) as typeof fs.readdirSync);
	vi.spyOn(fsp, "readdir").mockImplementation(((dir: fs.PathLike, options?: unknown) => {
		record(dir);
		return Reflect.apply(readdirModule, fsp, [dir, options]);
	}) as typeof fsp.readdir);
	try {
		await run();
	} finally {
		vi.restoreAllMocks();
	}
	return listed;
}

describe("a repository root lookup lists no ancestor", () => {
	let registrySnapshot: RegistrySnapshot | undefined;

	beforeEach(() => {
		registrySnapshot = captureRegistryForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (registrySnapshot) restoreRegistryForTests(registrySnapshot);
		registrySnapshot = undefined;
	});

	for (const inRepository of [true, false]) {
		it(`lists no ancestor of a working directory ${inRepository ? "inside" : "outside"} a repository, for any capability`, async () => {
			const { f, cwd, ancestors } = tree();
			if (!inRepository) fs.rmSync(path.join(f.repoRoot, ".git"), { recursive: true });
			initializeWithSettings(
				await Settings.loadReadOnly({ cwd, overrides: { "discovery.importForeignConfig": true } }),
			);
			f.resetCaches();

			const capabilities = listCapabilities();
			const listed = await listedDuring(async () => {
				for (const id of capabilities) {
					await loadCapability(id, { cwd, agentDir: f.agentDir, includeDisabled: true, includeInvalid: true });
				}
				await findLegacyPromptFiles({ cwd, home: f.home, agentDir: f.agentDir });
			});

			expect(capabilities.length).toBeGreaterThan(0);
			expect(await findRepoRoot(cwd)).toBe(inRepository ? f.repoRoot : null);
			expect(listed.filter(dir => ancestors.includes(dir))).toEqual([]);
		});
	}
});

describe("a repository root lookup", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		clearCache();
	});

	it("finds the nearest ancestor holding .git as a directory, a file or a link", async () => {
		const { f, cwd } = tree();
		const inner = path.join(f.repoRoot, "pkg");
		expect(await findRepoRoot(cwd)).toBe(f.repoRoot);

		fs.writeFileSync(path.join(inner, ".git"), "gitdir: ../.git/worktrees/pkg\n");
		clearCache();
		expect(await findRepoRoot(cwd)).toBe(inner);

		fs.rmSync(path.join(inner, ".git"));
		fs.symlinkSync(path.join(f.repoRoot, ".git"), path.join(inner, "a", ".git"));
		clearCache();
		expect(await findRepoRoot(cwd)).toBe(path.join(inner, "a"));
		expect(await findRepoRoot(f.repoRoot)).toBe(f.repoRoot);
	});

	it("walks up to a file or a directory of the name, as asked, past a link and without listing", async () => {
		const { f, cwd, ancestors } = tree();
		fs.symlinkSync(path.join(f.repoRoot, "pkg"), path.join(cwd, "marker"));
		fs.mkdirSync(path.join(f.repoRoot, "pkg", "a", "marker"));
		fs.writeFileSync(path.join(f.repoRoot, "marker"), "");

		const found: Array<string | null> = [];
		const listed = await listedDuring(async () => {
			found.push(await walkUp(cwd, "marker"));
			found.push(await walkUp(cwd, "marker", { dir: false }));
			found.push(await walkUp(cwd, "marker", { file: false }));
			found.push(await walkUp(cwd, "no-such-entry-anywhere"));
		});

		expect(found).toEqual([
			path.join(f.repoRoot, "pkg", "a", "marker"),
			path.join(f.repoRoot, "marker"),
			path.join(f.repoRoot, "pkg", "a", "marker"),
			null,
		]);
		expect(listed.filter(dir => ancestors.includes(dir))).toEqual([]);
	});

	it("shares one walk of one lstat per ancestor between concurrent lookups until invalidated", async () => {
		const { f, cwd } = tree();
		const lstat = fs.promises.lstat;
		const probed: string[] = [];
		vi.spyOn(fs.promises, "lstat").mockImplementation(((target: fs.PathLike, options?: unknown) => {
			probed.push(String(target));
			return Reflect.apply(lstat, fs.promises, [target, options]);
		}) as typeof fs.promises.lstat);
		const walk = ["pkg/a/b", "pkg/a", "pkg", ""].map(rel => path.join(f.repoRoot, rel, ".git"));

		const first = await Promise.all(Array.from({ length: 20 }, () => findRepoRoot(cwd)));
		expect(first).toEqual(Array.from({ length: 20 }, () => f.repoRoot));
		expect(probed).toEqual(walk);

		fs.mkdirSync(path.join(f.repoRoot, "pkg", ".git"));
		expect(await findRepoRoot(cwd)).toBe(f.repoRoot);
		expect(probed).toEqual(walk);

		invalidate(path.join(f.repoRoot, "pkg", ".git"));
		expect(await findRepoRoot(cwd)).toBe(path.join(f.repoRoot, "pkg"));
		expect(probed).toEqual([...walk, ...walk.slice(0, 3)]);
	});
});
