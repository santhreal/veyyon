/**
 * The on-disk cache contract: content-keyed path derivation, the listing
 * signature, atomic read/write, and immutable resolution. These tests use a real
 * temporary directory because the whole point of the module is its filesystem
 * behavior (atomic rename, ENOENT vs malformed, immutability of an existing
 * entry). Each test cleans up after itself.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cacheDictPath,
	listingSignature,
	readDictFile,
	resolveProjectCache,
	writeDictFileAtomic,
} from "../src/cache.js";
import { ArgotParseError } from "../src/parse.js";

const roots: string[] = [];

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "argot-cache-"));
	roots.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(roots.map(dir => rm(dir, { recursive: true, force: true })));
});

const PATH = "packages/coding-agent/src/database/connection.ts";
const OTHER = "packages/coding-agent/src/server/routes.ts";
const THIRD = "packages/coding-agent/src/config/settings.ts";

describe("cacheDictPath", () => {
	test("names an entry by project id and content signature", () => {
		// The signature is in the filename so distinct repository states never
		// overwrite one another under the same project directory.
		expect(cacheDictPath("/state/argot", "abc123", "deadbeef")).toBe("/state/argot/abc123/deadbeef.dict");
	});
});

describe("listingSignature", () => {
	test("is stable for the same listing and independent of order", () => {
		// Two agents listing the same tree in different orders must agree, or they
		// would key different cache entries for one identical state.
		const a = listingSignature([{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }]);
		const b = listingSignature([{ path: "c.ts" }, { path: "a.ts" }, { path: "b.ts" }]);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{32}$/);
	});

	test("changes when a file is added, removed, or renamed", () => {
		const base = listingSignature([{ path: "a.ts" }, { path: "b.ts" }]);
		expect(listingSignature([{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }])).not.toBe(base);
		expect(listingSignature([{ path: "a.ts" }])).not.toBe(base);
		expect(listingSignature([{ path: "a.ts" }, { path: "renamed.ts" }])).not.toBe(base);
	});

	test("changes when a file's contents change but its path does not", () => {
		// A non-git project has no HEAD, so an edit must move the signature or a
		// stale cache would be served after the tree changed under a fixed listing.
		const before = listingSignature([{ path: "a.ts", content: "const x = 1;" }]);
		const after = listingSignature([{ path: "a.ts", content: "const x = 2;" }]);
		expect(after).not.toBe(before);
	});

	test("ignores content when none is supplied, keying on paths alone", () => {
		const withoutContent = listingSignature([{ path: "a.ts" }, { path: "b.ts" }]);
		const same = listingSignature([{ path: "b.ts" }, { path: "a.ts" }]);
		expect(same).toBe(withoutContent);
	});
});

describe("readDictFile", () => {
	test("returns undefined when the file does not exist", async () => {
		const dir = await scratch();
		expect(await readDictFile(join(dir, "nope", "sig.dict"))).toBeUndefined();
	});

	test("parses a present, valid dictionary", async () => {
		const dir = await scratch();
		const path = join(dir, "sig.dict");
		await writeFile(path, 'version = 1\nsigil = "§"\n\n[handles]\ndbconn = "packages/x/y.ts"\n', "utf8");
		const vocab = await readDictFile(path);
		expect(vocab?.sigil).toBe("§");
		expect(vocab?.handles.get("dbconn")).toBe("packages/x/y.ts");
	});

	test("throws on a malformed dictionary rather than discarding it", async () => {
		const dir = await scratch();
		const path = join(dir, "sig.dict");
		await writeFile(path, "this is not valid toml at = = =", "utf8");
		await expect(readDictFile(path)).rejects.toBeInstanceOf(ArgotParseError);
	});
});

describe("writeDictFileAtomic", () => {
	test("creates the parent directory and writes the content", async () => {
		const dir = await scratch();
		const path = join(dir, "deep", "nested", "sig.dict");
		await writeDictFileAtomic(path, "hello");
		expect(await readFile(path, "utf8")).toBe("hello");
	});

	test("overwrites an existing file in place", async () => {
		const dir = await scratch();
		const path = join(dir, "sig.dict");
		await writeDictFileAtomic(path, "first");
		await writeDictFileAtomic(path, "second");
		expect(await readFile(path, "utf8")).toBe("second");
	});

	test("leaves no temp files behind", async () => {
		const dir = await scratch();
		const path = join(dir, "sig.dict");
		await writeDictFileAtomic(path, "content");
		const entries = await readdir(dir);
		expect(entries).toEqual(["sig.dict"]);
	});
});

describe("resolveProjectCache", () => {
	test("generates and writes an entry on a miss, then re-reads to the same vocabulary", async () => {
		const dir = await scratch();
		const result = await resolveProjectCache({
			baseDir: dir,
			cacheId: "proj",
			contentSig: "sig1",
			files: [{ path: PATH }, { path: OTHER }],
		});
		expect(result.hit).toBe(false);
		expect(result.vocab.handles.size).toBeGreaterThan(0);
		const reread = await readDictFile(result.path);
		expect([...(reread?.handles.entries() ?? [])].sort()).toEqual([...result.vocab.handles.entries()].sort());
	});

	test("uses short deterministic mnemonic names by default (bare stem when unique)", async () => {
		// The cache defaults to the mnemonic scheme, not the old content-addressed one.
		// The token win only exists when a handle is shorter than the string it
		// replaces, so a uniquely-stemmed path must get the BARE stem — no hash suffix.
		// Regression guard for ARG-NAME-BREVITY: the content scheme minted
		// `connec_pk4xfv18` (a fixed 8-char hash on every handle), nearly as long as a
		// short expansion, which drove the live bench's net-token delta positive.
		const dir = await scratch();
		const result = await resolveProjectCache({
			baseDir: dir,
			cacheId: "proj",
			contentSig: "sig1",
			files: [{ path: PATH }],
		});
		const handle = [...result.vocab.handles.entries()].find(([, expansion]) => expansion === PATH);
		// PATH ends in `.../connection.ts`; nameStem truncates the last segment to 6
		// chars → `connec`. Unique here, so the name is exactly the bare stem.
		expect(handle?.[0]).toBe("connec");
	});

	test("collliding stems get distinct, minimal, deterministic disambiguators", async () => {
		// Two DIFFERENT expansions whose 6-char stems collide (both truncate to
		// `featur`) must still get distinct names, and the disambiguator must be a
		// short hash suffix (not the whole 8-char content hash), assigned as a pure
		// function of the expansion set so it is identical on every regeneration.
		const dir = await scratch();
		const files = [{ path: "src/feature-alpha.ts" }, { path: "src/feature-omega.ts" }];
		const result = await resolveProjectCache({ baseDir: dir, cacheId: "proj", contentSig: "sigF", files });
		const names = [...result.vocab.handles.entries()]
			.filter(([, expansion]) => expansion.startsWith("src/feature-"))
			.map(([name]) => name);
		expect(names.length).toBe(2);
		expect(new Set(names).size).toBe(2); // distinct
		for (const name of names) {
			expect(name.startsWith("featur")).toBe(true);
			// stem (6) + a short hash prefix; never the fixed 8-char content hash.
			expect(name.length).toBeLessThanOrEqual("featur".length + 4);
		}
	});

	test("an existing entry is immutable: the same signature never regenerates", async () => {
		// The signature is the key. A second resolve at the same signature must read
		// the stored entry verbatim, even if the caller passes a different listing,
		// because an existing entry is never overwritten. This is what removes the
		// write contention the old mutable+monotonic cache had.
		const dir = await scratch();
		const first = await resolveProjectCache({
			baseDir: dir,
			cacheId: "proj",
			contentSig: "sig1",
			files: [{ path: PATH }],
		});
		expect(first.hit).toBe(false);

		const second = await resolveProjectCache({
			baseDir: dir,
			cacheId: "proj",
			contentSig: "sig1",
			files: [{ path: PATH }, { path: OTHER }, { path: THIRD }],
		});
		expect(second.hit).toBe(true);
		expect([...second.vocab.handles.entries()].sort()).toEqual([...first.vocab.handles.entries()].sort());
	});

	test("distinct signatures are independent entries that coexist on disk", async () => {
		// Two repository states (two commits, two worktrees) key different entries,
		// so they never contend and both remain available.
		const dir = await scratch();
		const a = await resolveProjectCache({
			baseDir: dir,
			cacheId: "proj",
			contentSig: "sigA",
			files: [{ path: PATH }],
		});
		const b = await resolveProjectCache({
			baseDir: dir,
			cacheId: "proj",
			contentSig: "sigB",
			files: [{ path: PATH }, { path: OTHER }, { path: THIRD }],
		});
		expect(a.path).not.toBe(b.path);
		const entries = (await readdir(join(dir, "proj"))).sort();
		expect(entries).toEqual(["sigA.dict", "sigB.dict"]);
		// Reading sigA back still yields its own smaller vocabulary, unmodified.
		expect((await readDictFile(a.path))?.handles.size).toBe(a.vocab.handles.size);
	});

	test("concurrent generation of one entry is race-safe and byte-identical", async () => {
		// Deterministic mnemonic names are a pure function of the expansion set (bare
		// stem when unique, else a hash-derived suffix), so two generations of the same
		// state produce the same names and the same text; the atomic rename makes the
		// racing writes harmless. This is the property that lets the immutable cache use
		// short names WITHOUT the content scheme's coordination-free-but-long hashes.
		const dir = await scratch();
		const files = [{ path: PATH }, { path: OTHER }, { path: THIRD }];
		const [x, y] = await Promise.all([
			resolveProjectCache({ baseDir: dir, cacheId: "proj", contentSig: "sig1", files }),
			resolveProjectCache({ baseDir: dir, cacheId: "proj", contentSig: "sig1", files }),
		]);
		expect([...x.vocab.handles.entries()].sort()).toEqual([...y.vocab.handles.entries()].sort());
		const onDisk = await readFile(x.path, "utf8");
		expect(onDisk.length).toBeGreaterThan(0);
	});

	test("a corrupt entry surfaces loudly instead of being silently rebuilt", async () => {
		const dir = await scratch();
		const path = cacheDictPath(dir, "proj", "sig1");
		await writeDictFileAtomic(path, "garbage = = =");
		await expect(
			resolveProjectCache({ baseDir: dir, cacheId: "proj", contentSig: "sig1", files: [{ path: PATH }] }),
		).rejects.toBeInstanceOf(ArgotParseError);
	});

	test("writes nothing when there is nothing worth a handle", async () => {
		const dir = await scratch();
		const result = await resolveProjectCache({
			baseDir: dir,
			cacheId: "proj",
			contentSig: "sig1",
			files: [{ path: "a.ts" }],
			options: { minExpansionLength: 100 },
		});
		expect([...result.vocab.handles.entries()]).toEqual([]);
		// No file was written, so a subsequent read still finds nothing.
		expect(await readDictFile(result.path)).toBeUndefined();
	});
});
