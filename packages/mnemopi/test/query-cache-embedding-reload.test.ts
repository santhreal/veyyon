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
});
