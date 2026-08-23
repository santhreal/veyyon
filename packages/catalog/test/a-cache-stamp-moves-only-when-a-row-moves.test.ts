/**
 * `modelCacheStamp` decides when the registry's persisted static stage is
 * still valid, so its contract is "moves only when a row moves": stable
 * across repeated reads and across file-mtime churn on the database or its
 * sidecars (SQLite touches those on every connection), and different after
 * any real row write. A stamp that reads mtimes re-creates the every-launch
 * miss this exists to prevent.
 */

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

	it("is stable across reads and mtime churn, and moves on a row write", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-"));
		const dbPath = path.join(tempDir, "models.db");

		const empty = modelCacheStamp(dbPath);
		expect(empty).toBe("0:0:0");
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

		writeModelCache("p-two", 200, [], false, "", dbPath);
		expect(modelCacheStamp(dbPath)).not.toBe(oneRow);
	});
});
