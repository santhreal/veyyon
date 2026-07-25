/**
 * CACHE-4: a cache that cannot be written must degrade LOUDLY and stay CORRECT.
 *
 * The state directory can stop being writable for ordinary reasons: a read-only
 * mount, a full disk, a `sudo` run that left root-owned entries behind, a
 * container that mounts the home directory read-only. Before this row, the write
 * failure escaped `resolveProjectCache` and took the whole feature down: argot
 * could not arm at all, because saving an optimisation had failed.
 *
 * That is the wrong trade in both directions. A cache is by definition
 * disposable, so a failed WRITE must cost only speed, never correctness: the
 * dictionary was already generated in memory and is exactly the dictionary a
 * successful write would have stored. But it must also never be silent (Law 10),
 * because the visible symptom of a permanently unwritable cache is "veyyon got
 * slower", which nobody diagnoses. So the failure travels back on the result and
 * out through the harness notice sink.
 *
 * The asymmetry with the READ path is deliberate and is asserted here too: a
 * corrupt existing entry still throws (see `cache-corrupt-entry.test.ts`),
 * because there the data is untrustworthy rather than merely unsaved.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheDictPath, resolveProjectCache } from "../src/cache.js";
import { type ProjectVocabNotice, resolveProjectVocab } from "../src/project-vocab.js";

const roots: string[] = [];

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "argot-cache-unwritable-"));
	roots.push(dir);
	return dir;
}

afterAll(async () => {
	for (const dir of roots) {
		// Restore write permission first: a 0o500 directory cannot have its children
		// removed, so cleanup would fail and leak the temp tree.
		await chmod(dir, 0o700).catch(() => {});
		for (const entry of await readdir(dir).catch(() => [])) {
			await chmod(join(dir, entry), 0o700).catch(() => {});
		}
		await rm(dir, { recursive: true, force: true });
	}
});

const PATH = "packages/coding-agent/src/database/connection.ts";
const OTHER = "packages/coding-agent/src/server/routes.ts";
const FILES = [{ path: PATH }, { path: OTHER }];

/** A base directory whose project subdirectory exists but rejects new files. */
async function unwritableCacheDir(cacheId: string): Promise<string> {
	const base = await scratch();
	await mkdir(join(base, cacheId), { recursive: true });
	await chmod(join(base, cacheId), 0o500);
	return base;
}

describe("a cache directory that cannot be written", () => {
	test("still returns a complete, usable vocabulary", async () => {
		// The correctness half, stated first because it is the one that decides
		// whether the user can work at all. The handles must be the real generated
		// handles, not an empty vocabulary standing in for "we failed".
		const base = await unwritableCacheDir("proj");

		const result = await resolveProjectCache({ baseDir: base, cacheId: "proj", contentSig: "sig1", files: FILES });

		const expansions = [...result.vocab.handles.values()].sort();
		expect(expansions).toEqual([PATH, OTHER].sort());
	});

	test("returns the SAME vocabulary a writable directory would have produced", async () => {
		// The strongest form of "slower, not wrong": the degraded path is compared
		// against the healthy path over the same corpus, so a subtly different
		// dictionary (a different naming scheme, a dropped entry) fails here even
		// though the previous test would still pass.
		const writable = await scratch();
		const blocked = await unwritableCacheDir("proj");

		const healthy = await resolveProjectCache({
			baseDir: writable,
			cacheId: "proj",
			contentSig: "sig1",
			files: FILES,
		});
		const degraded = await resolveProjectCache({
			baseDir: blocked,
			cacheId: "proj",
			contentSig: "sig1",
			files: FILES,
		});

		expect([...degraded.vocab.handles.entries()].sort()).toEqual([...healthy.vocab.handles.entries()].sort());
	});

	test("does not throw, so the feature is not taken down by a failed optimisation", async () => {
		// The regression this row exists for. `writeDictFileAtomic` used to throw
		// straight out of `resolveProjectCache`, so an unwritable state directory
		// meant argot could not arm at all.
		const base = await unwritableCacheDir("proj");

		await expect(
			resolveProjectCache({ baseDir: base, cacheId: "proj", contentSig: "sig1", files: FILES }),
		).resolves.toBeDefined();
	});

	test("reports the failure rather than swallowing it", async () => {
		// Law 10. Everything above would pass just as well with a bare `catch {}`,
		// which is precisely the silent degrade that makes an unwritable cache
		// present as unexplained slowness months later.
		const base = await unwritableCacheDir("proj");

		const result = await resolveProjectCache({ baseDir: base, cacheId: "proj", contentSig: "sig1", files: FILES });

		expect(result.writeError).toBeDefined();
	});

	test("the report names the path, the cause, and the consequence", async () => {
		// An operator has to be able to act on the line without reading this file.
		// The path says which directory to fix, the errno says why, and the
		// consequence says what it costs so the line can be triaged honestly.
		const base = await unwritableCacheDir("proj");

		const result = await resolveProjectCache({ baseDir: base, cacheId: "proj", contentSig: "sig1", files: FILES });

		expect(result.writeError).toContain(cacheDictPath(base, "proj", "sig1"));
		expect(result.writeError).toContain("EACCES");
		expect(result.writeError).toContain("regenerated on every session");
	});

	test("is still reported as a MISS, not a hit", async () => {
		// `hit` means "this came from disk". A failed write must not be dressed up
		// as a hit, or cache-effectiveness measurements would read a permanently
		// broken cache as a perfectly working one.
		const base = await unwritableCacheDir("proj");

		const result = await resolveProjectCache({ baseDir: base, cacheId: "proj", contentSig: "sig1", files: FILES });

		expect(result.hit).toBe(false);
	});

	test("leaves no temp file behind in the directory it could reach", async () => {
		// The temp-then-rename write can fail at either step. Neither may leave
		// debris that a later reader mistakes for an entry.
		const base = await unwritableCacheDir("proj");

		await resolveProjectCache({ baseDir: base, cacheId: "proj", contentSig: "sig1", files: FILES });

		expect(await readdir(join(base, "proj"))).toEqual([]);
	});
});

describe("the control: a writable directory reports nothing", () => {
	test("a successful write leaves writeError unset", async () => {
		// Without this, every assertion above is satisfied by a function that reports
		// a failure unconditionally.
		const base = await scratch();

		const result = await resolveProjectCache({ baseDir: base, cacheId: "proj", contentSig: "sig1", files: FILES });

		expect(result.writeError).toBeUndefined();
		expect(await readdir(join(base, "proj"))).toEqual(["sig1.dict"]);
	});

	test("a cache HIT reports nothing either", async () => {
		// The hit path never writes, so it can have nothing to report. Guards against
		// a field that leaks a stale value from a previous resolution.
		const base = await scratch();
		await resolveProjectCache({ baseDir: base, cacheId: "proj", contentSig: "sig1", files: FILES });

		const second = await resolveProjectCache({ baseDir: base, cacheId: "proj", contentSig: "sig1", files: FILES });

		expect(second.hit).toBe(true);
		expect(second.writeError).toBeUndefined();
	});

	test("an empty corpus writes nothing and reports nothing", async () => {
		// A corpus with no path worth a handle is a normal outcome, not a failure:
		// no file is written by design, so no write can have failed.
		const base = await scratch();

		const result = await resolveProjectCache({ baseDir: base, cacheId: "proj", contentSig: "sig1", files: [] });

		expect(result.vocab.handles.size).toBe(0);
		expect(result.writeError).toBeUndefined();
	});
});

describe("the failure reaches the harness through the notice sink", () => {
	/** A non-git project: `gitHead` null sends `resolveProjectVocab` down the walk path. */
	const io = {
		gitHead: async () => null,
		listTrackedFiles: async () => null,
	};

	/** A project root argot will resolve, with enough files to yield handles. */
	async function project(): Promise<string> {
		const root = await scratch();
		await writeFile(join(root, ".argot"), "");
		await mkdir(join(root, "src", "database"), { recursive: true });
		await writeFile(join(root, "src", "database", "connection.ts"), "export const connect = () => {};\n");
		await writeFile(join(root, "src", "database", "migrations.ts"), "export const migrate = () => {};\n");
		return root;
	}

	test("an unwritable cache directory surfaces as a cache-write-failed notice", async () => {
		// The end-to-end path that matters: veyyon wires `onNotice` to its logger, so
		// this is the difference between an operator seeing a warning line and seeing
		// nothing at all. Asserting inside `cache.ts` alone would not prove the value
		// is ever read.
		const root = await project();
		const cacheDir = await scratch();
		await chmod(cacheDir, 0o500);

		const notices: ProjectVocabNotice[] = [];
		const resolved = await resolveProjectVocab({ folder: root, cacheDir, io, onNotice: n => notices.push(n) });

		expect(resolved?.vocab.handles.size).toBeGreaterThan(0);
		const failure = notices.find(notice => notice.code === "cache-write-failed");
		expect(failure?.message).toContain("could not save the generated dictionary");
	});

	test("the notice carries the entry path as structured data, not only in the prose", async () => {
		// The harness logs `data` as fields. A path that exists only inside the
		// sentence cannot be filtered or grouped on.
		const root = await project();
		const cacheDir = await scratch();
		await chmod(cacheDir, 0o500);

		const notices: ProjectVocabNotice[] = [];
		await resolveProjectVocab({ folder: root, cacheDir, io, onNotice: n => notices.push(n) });

		const failure = notices.find(notice => notice.code === "cache-write-failed");
		expect(failure?.data).toMatchObject({ path: expect.stringContaining(cacheDir) });
	});

	test("the GIT resolution path reports it too, not only the walk path", async () => {
		// There are two independent calls into the cache (HEAD-keyed and
		// listing-keyed) and each needs its own report. Writing this test is what
		// caught the walk path returning without reporting at all while the git path
		// worked, so a single end-to-end test would have declared the row done with
		// the more common branch still silent.
		const root = await project();
		const cacheDir = await scratch();
		await chmod(cacheDir, 0o500);

		const notices: ProjectVocabNotice[] = [];
		const gitIo = {
			gitHead: async () => "0".repeat(40),
			listTrackedFiles: async () => ["src/database/connection.ts", "src/database/migrations.ts"],
		};
		const resolved = await resolveProjectVocab({ folder: root, cacheDir, io: gitIo, onNotice: n => notices.push(n) });

		expect(resolved?.vocab.handles.size).toBeGreaterThan(0);
		expect(notices.map(notice => notice.code)).toContain("cache-write-failed");
	});

	test("a writable cache directory emits no cache-write-failed notice", async () => {
		// The control for the sink, matching the control for the value.
		const root = await project();
		const cacheDir = await scratch();

		const notices: ProjectVocabNotice[] = [];
		await resolveProjectVocab({ folder: root, cacheDir, io, onNotice: n => notices.push(n) });

		expect(notices.filter(notice => notice.code === "cache-write-failed")).toEqual([]);
	});
});
