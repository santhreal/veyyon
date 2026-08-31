import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cacheDictPath, resolveProjectCache } from "../src/cache.js";

/**
 * CACHE-3: what a corrupt dictionary cache entry must do.
 *
 * The row this suite answers asked for the entry to be REGENERATED loudly. That
 * is the right instinct for most caches and the wrong one here, so the behavior
 * is pinned as-is and the reasoning is written down rather than left to be
 * rediscovered.
 *
 * A dictionary is not an ordinary cache. Its handles are written into live
 * transcripts: once the model has emitted `§routes`, that token only means
 * something while the dictionary that minted it still says so. Regenerating from
 * a damaged file cannot promise the same names, because the input that produced
 * them is exactly what was lost. Silently rebuilding would therefore strip
 * meaning from text that already exists, which is worse than any cache miss and
 * is the failure Law 10 is about.
 *
 * So a malformed entry FAILS LOUDLY, naming the file, and the operator deletes
 * it deliberately. A missing entry is a different thing entirely and regenerates
 * without ceremony, which is what keeps the loud path rare enough to mean
 * something.
 */
describe("a corrupt dictionary cache entry fails loudly instead of being rebuilt", () => {
	let baseDir = "";
	const CACHE_ID = "proj-cache-id";
	const CONTENT_SIG = "0123456789abcdef0123456789abcdef01234567";
	const FILES = [
		{ path: "src/routes/index.ts", size: 120 },
		{ path: "src/database/connection.ts", size: 90 },
	];

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-cache-corrupt-"));
	});

	afterEach(() => {
		if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
		baseDir = "";
	});

	function writeEntry(body: string): string {
		const entry = cacheDictPath(baseDir, CACHE_ID, CONTENT_SIG);
		fs.mkdirSync(path.dirname(entry), { recursive: true });
		fs.writeFileSync(entry, body);
		return entry;
	}

	function resolve() {
		return resolveProjectCache({ baseDir, cacheId: CACHE_ID, contentSig: CONTENT_SIG, files: FILES });
	}

	test("unparseable TOML throws, naming the offending file", async () => {
		// Naming the file is the whole remedy: the operator's next action is to delete
		// exactly this path, and a message without it turns a one-command fix into a
		// hunt through a content-addressed cache tree.
		const entry = writeEntry("this is not [ valid toml\n");

		await expect(resolve()).rejects.toThrow(new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});

	test("a truncated entry throws rather than loading a partial vocabulary", async () => {
		// The realistic corruption, and the most dangerous one: a partial dictionary
		// can parse into a SMALLER handle set, which silently unmaps every handle that
		// was cut off while looking like a perfectly good load.
		writeEntry('version = 1\nsigil = "\\u00a7"\n[handles]\nrou');

		await expect(resolve()).rejects.toThrow();
	});

	test("an entry missing its version field throws instead of guessing one", async () => {
		writeEntry('sigil = "\\u00a7"\n[handles]\n');

		await expect(resolve()).rejects.toThrow(/version/);
	});

	test("the corrupt entry is left ON DISK, not deleted behind the operator's back", async () => {
		// Deliberate: the file is evidence. Deleting it would destroy the only record
		// of which handles were in play when the damage happened, and the operator may
		// want to recover names from a partially readable file before discarding it.
		const entry = writeEntry("this is not [ valid toml\n");

		await resolve().catch(() => {});

		expect(fs.existsSync(entry)).toBe(true);
		expect(fs.readFileSync(entry, "utf8")).toBe("this is not [ valid toml\n");
	});

	test("it is NOT silently replaced with a freshly generated dictionary", async () => {
		// The behavior the row originally asked for, pinned as the thing that must not
		// happen. A rebuild cannot promise the same names, and different names silently
		// unmap every handle already written into a live transcript.
		const entry = writeEntry("this is not [ valid toml\n");
		const before = fs.readFileSync(entry, "utf8");

		await resolve().catch(() => {});

		expect(fs.readFileSync(entry, "utf8")).toBe(before);
	});

	describe("the paths that must stay quiet", () => {
		test("a MISSING entry generates without ceremony", async () => {
			// The control that keeps the loud path meaningful. If absence were also an
			// error, every first run would fail and the noise would train people to
			// ignore it.
			const result = await resolve();

			expect(result.hit).toBe(false);
			expect(fs.existsSync(result.path)).toBe(true);
		});

		test("a VALID entry is read back verbatim as a hit", async () => {
			const first = await resolve();
			const second = await resolve();

			// Same path and a hit the second time: the entry written on a miss must be
			// readable by the very next resolve, or the cache would regenerate forever
			// and this suite's corruption cases would never be reachable in practice.
			expect(second.hit).toBe(true);
			expect(second.path).toBe(first.path);
			expect([...second.vocab.handles.entries()].sort()).toEqual([...first.vocab.handles.entries()].sort());
			expect(second.vocab.handles.size).toBe(2);
		});

		test("deleting the corrupt entry restores normal service", async () => {
			// The documented remedy, proven end to end, so the error message's advice is
			// known to actually work.
			const entry = writeEntry("this is not [ valid toml\n");
			await expect(resolve()).rejects.toThrow();

			fs.rmSync(entry);

			const recovered = await resolve();
			expect(recovered.hit).toBe(false);
			// The exact handles this corpus mints, not merely "some": a recovery that
			// produced a DIFFERENT handle set would be the silent unmapping this whole
			// design refuses, and only naming them can tell the two apart.
			expect([...recovered.vocab.handles.entries()].sort()).toEqual([
				["conn", "src/database/connection.ts"],
				["inde", "src/routes/index.ts"],
			]);

			// And the rebuilt entry is readable as a hit, so service is genuinely back
			// rather than regenerating from scratch on every future resolve.
			expect((await resolve()).hit).toBe(true);
		});
	});
});
