import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryCache } from "@veyyon/mnemopi/core/query-cache";

// Coherence lock for the unified embedding codec on the query-cache persistence path.
// The load path no longer hand-parses the embedding column (it used an unchecked
// `JSON.parse(...) as number[]`); it now decodes through the shared validated codec.
// So a corrupt or legacy embedding blob decodes to null and is dropped from the vector
// tier instead of being cast to a bogus value, while the cached results stay served,
// and a valid embedding round-trips through sqlite back into the vector tier.

describe("query cache embedding reload", () => {
	const dirs: string[] = [];
	const caches: QueryCache[] = [];

	afterEach(() => {
		for (const c of caches.splice(0)) c.close();
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function tempDbPath(): string {
		const dir = mkdtempSync(join(tmpdir(), "mnemopi-qcache-"));
		dirs.push(dir);
		return join(dir, "cache.db");
	}

	it("keeps serving the cached results when the persisted embedding is corrupt", () => {
		const dbPath = tempDbPath();
		const results = [{ id: 1, text: "hello answer" }];

		const writer = new QueryCache({ dbPath });
		caches.push(writer);
		writer.put("hello world", results, [0.1, 0.2, 0.3]);
		writer.close();
		caches.splice(caches.indexOf(writer), 1);

		// Corrupt only the embedding blob, leaving results_json intact.
		const raw = new Database(dbPath);
		raw.run("UPDATE query_cache SET embedding_json = 'not-json-garbage'");
		raw.close();

		const reader = new QueryCache({ dbPath });
		caches.push(reader);
		expect(reader.get("hello world")).toEqual(results);
	});

	it("still serves the vector tier when the persisted embedding is valid", () => {
		const dbPath = tempDbPath();
		const results = [{ id: 7, text: "vector answer" }];

		const writer = new QueryCache({ dbPath });
		caches.push(writer);
		writer.put("the quick brown fox", results, [1, 0, 0]);
		writer.close();
		caches.splice(caches.indexOf(writer), 1);

		const reader = new QueryCache({ dbPath });
		caches.push(reader);
		// A near-identical query embedding resolves through the reloaded vector tier.
		expect(reader.get("a totally different phrase", [1, 0, 0])).toEqual(results);
	});

	/**
	 * Why: reload must preserve the persisted insertion time; resetting it to process
	 * startup revives expired answers every time the application restarts.
	 */
	it("drops an entry that expired before the persistent cache was reopened", () => {
		const dbPath = tempDbPath();
		const writer = new QueryCache({ dbPath, ttlSeconds: 60 });
		caches.push(writer);
		writer.put("expired persistent query", [{ id: 9 }], [1]);
		writer.close();
		caches.splice(caches.indexOf(writer), 1);

		const raw = new Database(dbPath);
		raw.run("UPDATE query_cache SET created_at = datetime('now', '-2 hours')");
		raw.close();

		const reader = new QueryCache({ dbPath, ttlSeconds: 60 });
		caches.push(reader);
		expect(reader.get("expired persistent query")).toBeNull();
		expect(reader.stats().size).toBe(0);

		const verification = new Database(dbPath);
		expect(verification.query("SELECT COUNT(*) AS count FROM query_cache").get()).toEqual({ count: 0 });
		verification.close();
	});

	/**
	 * Why: a smaller cache limit on restart must evict persisted least-recent entries
	 * immediately instead of exceeding the configured bound until a future write.
	 */
	it("enforces the configured size while reloading persisted entries", () => {
		const dbPath = tempDbPath();
		const writer = new QueryCache({ dbPath, maxSize: 10 });
		caches.push(writer);
		writer.put("alpha oldest", [{ id: 1 }], [1, 0]);
		writer.put("beta middle", [{ id: 2 }], [0, 1]);
		writer.put("gamma newest", [{ id: 3 }], [1, 1]);
		writer.close();
		caches.splice(caches.indexOf(writer), 1);

		const raw = new Database(dbPath);
		raw.run(`
			UPDATE query_cache
			SET
				created_at = datetime('now', '-5 minutes'),
				last_hit = CASE normalized
					WHEN 'beta middle' THEN datetime('now', '-3 minutes')
					WHEN 'gamma newest' THEN datetime('now', '-2 minutes')
					ELSE datetime('now', '-1 minute')
				END
		`);
		raw.close();

		const reader = new QueryCache({ dbPath, maxSize: 2 });
		caches.push(reader);
		expect(reader.stats().size).toBe(2);
		expect(reader.get("alpha oldest")).toEqual([{ id: 1 }]);
		expect(reader.get("beta middle")).toBeNull();
		expect(reader.get("gamma newest")).toEqual([{ id: 3 }]);
	});

	/**
	 * Why: syntactically valid JSON with the wrong result shape must be treated as
	 * corruption, not installed as a cache hit whose returned value looks like a miss.
	 */
	it("ignores and removes a persisted non-array result payload", () => {
		const dbPath = tempDbPath();
		const writer = new QueryCache({ dbPath });
		caches.push(writer);
		writer.put("malformed results", [{ id: 4 }], [1]);
		writer.close();
		caches.splice(caches.indexOf(writer), 1);

		const raw = new Database(dbPath);
		raw.run("UPDATE query_cache SET results_json = 'null'");
		raw.close();

		const reader = new QueryCache({ dbPath });
		caches.push(reader);
		expect(reader.get("malformed results")).toBeNull();
		expect(reader.stats()).toMatchObject({ hits: 0, misses: 1, size: 0 });
	});
});
