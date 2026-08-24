/**
 * `modelCacheStamp` decides when the registry's persisted static stage is
 * still valid, so its contract is "moves only when what a row says moves, or
 * when a verdict read from it would change": stable across repeated reads and
 * across file-mtime churn on the database or its sidecars (SQLite touches those
 * on every connection), stable when a provider is re-probed and found
 * unchanged, and different after any real content write or a freshness
 * transition. A stamp that reads mtimes, or that counts a re-verification as a
 * mutation, re-creates the every-launch miss this exists to prevent — one local
 * server provider re-probing at each start was enough to do it.
 *
 * WHAT THIS DOES NOT CATCH: whether the registry folds this stamp into its own
 * fingerprint, or reads the TTL this stamp is asked about. The static-stage
 * suite owns that.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { modelCacheStamp, writeModelCache } from "../src/model-cache";

describe("model cache stamp", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		tempDir = undefined;
	});

	it("reports unreadable for a database that cannot exist", () => {
		expect(modelCacheStamp(path.join(os.tmpdir(), `no-such-dir-${Snowflake.next()}`, "models.db"))).toBe(
			"unreadable",
		);
	});

	it("is stable across reads and mtime churn, and moves on every row-content write", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-"));
		const dbPath = path.join(tempDir, "models.db");

		const empty = modelCacheStamp(dbPath);
		expect(empty).toMatch(/^[0-9a-f]{64}$/);
		expect(modelCacheStamp(dbPath)).toBe(empty);

		writeModelCache("p-one", 100, [], true, "", dbPath);
		const oneRow = modelCacheStamp(dbPath);
		expect(oneRow).not.toBe(empty);

		for (const suffix of ["", "-wal", "-shm"]) {
			const p = dbPath + suffix;
			if (!fs.existsSync(p)) fs.writeFileSync(p, "");
			fs.utimesSync(p, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
		}
		expect(modelCacheStamp(dbPath)).toBe(oneRow);

		// A content stamp must not reduce to updated_at aggregates: a provider can
		// be rewritten within the same millisecond with different authority/data.
		writeModelCache("p-one", 100, [], false, "", dbPath);
		const sameTimestampRewrite = modelCacheStamp(dbPath);
		expect(sameTimestampRewrite).not.toBe(oneRow);

		writeModelCache("p-two", 200, [], false, "", dbPath);
		const twoRows = modelCacheStamp(dbPath);
		expect(twoRows).not.toBe(sameTimestampRewrite);

		// Revision triggers cover writers that update the table directly rather
		// than going through writeModelCache's content-fingerprint calculation.
		const db = new Database(dbPath);
		db.run("UPDATE model_cache SET authoritative = 1 WHERE provider_id = 'p-two'");
		db.close();
		expect(modelCacheStamp(dbPath)).not.toBe(twoRows);
	});

	it("distinguishes equal-revision databases that hold different row content", () => {
		// A deleted-and-recreated database restarts the mutation counter, so the
		// counter alone cannot tell one write from another write at the same
		// position. The persisted row digest is what separates them.
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-identity-"));
		const authoritative = path.join(tempDir, "authoritative.db");
		const provisional = path.join(tempDir, "provisional.db");

		writeModelCache("p-one", 100, [], true, "", authoritative);
		writeModelCache("p-one", 100, [], false, "", provisional);

		expect(modelCacheStamp(authoritative)).not.toBe(modelCacheStamp(provisional));
	});

	it("holds still when a provider is re-verified and its content has not changed", () => {
		// The refresh path rewrites a row with a new timestamp whenever it confirms
		// a catalog, which is not a change to what the row says.
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-reverify-"));
		const dbPath = path.join(tempDir, "models.db");

		writeModelCache("p-one", 100, [], true, "", dbPath);
		const verified = modelCacheStamp(dbPath, { ttlMs: 10_000, now: () => 100 });

		writeModelCache("p-one", 200, [], true, "", dbPath);
		expect(modelCacheStamp(dbPath, { ttlMs: 10_000, now: () => 200 })).toBe(verified);

		// A direct timestamp bump is the same non-event.
		const db = new Database(dbPath);
		db.run("UPDATE model_cache SET updated_at = 300 WHERE provider_id = 'p-one'");
		db.close();
		expect(modelCacheStamp(dbPath, { ttlMs: 10_000, now: () => 300 })).toBe(verified);
	});

	it("moves when a row crosses the freshness boundary it is read under", () => {
		// A consumer persists "this row was fresh and authoritative". That verdict
		// cannot outlive the TTL it came from, and no row has to move for it to
		// expire, so the boundary itself is part of the stamp.
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-ttl-"));
		const dbPath = path.join(tempDir, "models.db");
		writeModelCache("p-one", 1_000, [], true, "", dbPath);

		const fresh = modelCacheStamp(dbPath, { ttlMs: 10_000, now: () => 5_000 });
		expect(modelCacheStamp(dbPath, { ttlMs: 10_000, now: () => 9_000 })).toBe(fresh);
		expect(modelCacheStamp(dbPath, { ttlMs: 10_000, now: () => 11_001 })).not.toBe(fresh);
	});
});
