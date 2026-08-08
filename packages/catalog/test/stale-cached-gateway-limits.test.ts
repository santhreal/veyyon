/**
 * WHY: agent gateways (Cursor, Devin, Antigravity) used to publish a blind 200k/64k limit pair for every
 * model they proxy, whatever the proxied model's real limits were. Fixing the resolver only fixes the rows
 * discovery writes from now on. Discovery output is PERSISTED per provider in the SQLite model cache, and
 * the shipped read paths serve a cached row without re-discovering: the startup model list reads with a 24
 * hour TTL, and the refresh path deliberately keeps a stale row visible while retry backoff applies. So a
 * user who upgrades keeps being told a Cursor model holds 200k tokens, from a row written under the rule
 * the upgrade removed.
 *
 * Class closed: a persisted copy of a fixed defect is refused rather than served, and a change to what
 * discovery bakes into a cached row is a recorded decision. Every cache version below the current one is
 * enumerated at run time from the version the writer stamps, so an added version cannot skip the check,
 * and the current version is pinned by exact equality, so the next change to cached limits turns this
 * suite red until someone bumps it on purpose.
 *
 * Not covered: what a consumer does after the cache miss. That a miss sends the caller to discovery rather
 * than to bundled rows is the model manager's contract and is asserted in its own suites. This file also
 * says nothing about the bundled `models.json` rows themselves, which are generated and carry the same
 * blind pair until the generator reruns.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { captureDirOverrides, getModelDbPath, restoreDirOverrides, setAgentDir } from "@veyyon/utils";
// Relative imports, not `@veyyon/catalog/...`: the workspace `node_modules` link resolves to the primary
// checkout rather than to this worktree, so the package specifier would test someone else's source.
import {
	AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW,
	AGENT_GATEWAY_DEFAULT_MAX_TOKENS,
} from "../src/discovery/default-limits";
import { readModelCache, writeModelCache } from "../src/model-cache";
import { resolveProviderModels } from "../src/model-manager";
import { getBundledModels } from "../src/models";
import type { Api, Model } from "../src/types";

/**
 * The version the current writer stamps on a row. Bumping `CACHE_SCHEMA_VERSION` is how this repo retires
 * cached rows whose values were produced by a rule that no longer holds, and it has been used for exactly
 * that five times (the retired 222222/8888 limit sentinels were v6). The gateway limit fix needs its own
 * bump, which is what this number records.
 */
const EXPECTED_CACHE_VERSION = 10;

const TTL_MS = 24 * 60 * 60 * 1000;

/** A Cursor row exactly as the pre-fix discovery would have written it: the assumed pair, whatever the model. */
function blindCursorRow(): Model<Api> {
	const [first] = getBundledModels("cursor");
	if (!first) throw new Error("no bundled cursor rows to build a cached row from");
	return {
		...first,
		contextWindow: AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW,
		maxTokens: AGENT_GATEWAY_DEFAULT_MAX_TOKENS,
	};
}

describe("a cached gateway row from before the limits were resolved", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-stale-gateway-limits-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** Reads back the version the writer stamped, so the older versions below are derived rather than listed. */
	function stampedVersion(file = dbPath): number {
		const db = new Database(file, { create: true });
		try {
			const row = db.query<{ version: number }, []>("SELECT version FROM model_cache LIMIT 1").get();
			if (!row) throw new Error("the cache write left no row to read a version from");
			return row.version;
		} finally {
			db.close();
		}
	}

	function restampRow(version: number, file = dbPath): void {
		const db = new Database(file, { create: true });
		try {
			db.run("UPDATE model_cache SET version = ?", [version]);
		} finally {
			db.close();
		}
	}

	function rowCount(file = dbPath): number {
		const db = new Database(file, { create: true });
		try {
			const row = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM model_cache").get();
			return row?.count ?? 0;
		} finally {
			db.close();
		}
	}

	async function offlineModels(): Promise<Model<Api>[]> {
		const result = await resolveProviderModels<Api>(
			{ providerId: "cursor", staticModels: [], cacheDbPath: dbPath, cacheTtlMs: TTL_MS },
			"offline",
		);
		return result.models;
	}

	/**
	 * The control for every case below. A cached row IS served offline without asking the gateway anything,
	 * which is why the version is the only thing standing between an upgraded user and the old numbers. If
	 * this case ever fails, the refusals below are green for the wrong reason.
	 */
	it("is served when the version still matches, which is why the version has to move", async () => {
		const blind = blindCursorRow();
		writeModelCache("cursor", Date.now(), [blind], true, "", dbPath);

		const models = await offlineModels();
		expect(models.map(model => model.id)).toEqual([blind.id]);
		expect(models[0]?.contextWindow).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
	});

	/**
	 * The bump itself. Pinned by exact equality rather than a floor: a floor would let the next change to
	 * cached limits reuse this version and ship the same split between fresh and cached rows.
	 */
	it("carries the version that retires the rows written under the old rule", () => {
		writeModelCache("cursor", Date.now(), [blindCursorRow()], true, "", dbPath);
		expect(stampedVersion()).toBe(EXPECTED_CACHE_VERSION);
	});

	function stampedVersionAfterWrite(): number {
		writeModelCache("cursor", Date.now(), [blindCursorRow()], true, "", dbPath);
		return stampedVersion();
	}

	/**
	 * Every version the writer has ever stamped, derived from the current one instead of listed, so a new
	 * version cannot be added without this case covering it.
	 */
	it("is refused and deleted for every version below the current one", async () => {
		const current = stampedVersionAfterWrite();
		const older = Array.from({ length: current - 1 }, (_unused, index) => index + 1);
		expect(older.length).toBeGreaterThan(0);

		for (const version of older) {
			writeModelCache("cursor", Date.now(), [blindCursorRow()], true, "", dbPath);
			restampRow(version);

			const models = await offlineModels();
			expect(models, `version ${version} was served`).toEqual([]);
			expect(rowCount(), `version ${version} survived the read`).toBe(0);
		}
	});

	/**
	 * The case the open-time cleanup cannot answer. The shipped read path uses the SHARED database handle,
	 * which is opened once per process, so the `DELETE FROM model_cache WHERE version <> ?` that runs at open
	 * fires before any row an older writer adds later. Two veyyon versions on one machine is exactly that:
	 * the old one keeps writing rows carrying the blind limits into the same file. Only the version check on
	 * the read itself refuses those, so this case drives the shared handle and asserts the row is still on
	 * disk when the read returns nothing, which pins WHICH guard did the work.
	 */
	it("refuses a row an older writer added after this process opened the shared cache", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-stale-gateway-agent-"));
		const overrides = captureDirOverrides();
		try {
			setAgentDir(agentDir);
			const sharedPath = getModelDbPath();
			// Never write to the operator's real cache, whatever the resolver decided.
			expect(sharedPath.startsWith(agentDir)).toBe(true);

			writeModelCache("cursor", Date.now(), [blindCursorRow()], true, "");
			const current = stampedVersion(sharedPath);
			restampRow(current - 1, sharedPath);

			expect(readModelCache<Api>("cursor", TTL_MS, Date.now)).toBeNull();
			expect(rowCount(sharedPath), "the open-time delete refused it, so this case proves nothing").toBe(1);
		} finally {
			restoreDirOverrides(overrides);
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
