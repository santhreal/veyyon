/**
 * WHY: every on-disk root this package can create must answer to `MNEMOPI_HOME`.
 *
 * The class: a path computed from `os.homedir()` at MODULE scope is a path nothing can
 * redirect. `config.ts` held three such constants and `core/plugins.ts` and
 * `core/cost-log.ts` held one each, so `storeBlob()` wrote
 * `~/.hermes/mnemopi/blobs/...` and `getConn()` wrote `~/.mnemopi/data/cost_log.db` in
 * the operator's real home whatever the caller did about `VEYYON_CONFIG_DIR` and
 * `MNEMOPI_DATA_DIR`. That is how `Test TS workspace fast` went red: mnemopi's own
 * `afterAll` guard listed the home before and after a suite and found a `.hermes` that
 * the suite had created and could not have prevented.
 *
 * The invariant asserted here is the choke point rather than the incident: the resolver
 * inventory is READ OFF the modules at run time, so a new root function that skips
 * `mnemopiHome()` fails on arrival instead of quietly reintroducing the leak. Two
 * behavioral cases sit beside the sweep, because a resolver returning the right string
 * proves nothing about where the writing code actually writes.
 *
 * WHAT IT DOES NOT CATCH: a root spelled inline at the write site instead of through a
 * resolver (nothing in the inventory to find), a resolver that reads the environment
 * once and caches it, and anything that writes through an absolute path a caller passed
 * in, which is the caller's business.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../src/config";
import * as sanitizer from "../src/core/content-sanitizer";
import * as costLog from "../src/core/cost-log";
import * as plugins from "../src/core/plugins";
import * as triples from "../src/core/triples";
import { useMnemopiTestEnv } from "./setup";

useMnemopiTestEnv();

/** A home no run may reach: every resolver is called with it as `HOME`. */
const FORBIDDEN_HOME = join(tmpdir(), "mnemopi-forbidden-home-that-no-resolver-may-use");

/**
 * The modules that own a home-derived path. Namespace imports rather than a name list,
 * so the inventory below is whatever the module exports today.
 */
const MODULES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
	["config", config as unknown as Record<string, unknown>],
	["content-sanitizer", sanitizer as unknown as Record<string, unknown>],
	["cost-log", costLog as unknown as Record<string, unknown>],
	["plugins", plugins as unknown as Record<string, unknown>],
	["triples", triples as unknown as Record<string, unknown>],
];

/**
 * A resolver is an exported function whose name says it answers with a location. The
 * name shape is the discovery rule, so adding `blobArchiveDir()` puts it in the sweep
 * without anyone remembering to list it.
 */
function pathResolvers(): ReadonlyArray<readonly [string, (env: Record<string, string>) => unknown]> {
	const found: Array<readonly [string, (env: Record<string, string>) => unknown]> = [];
	for (const [moduleName, namespace] of MODULES) {
		for (const [exportName, value] of Object.entries(namespace)) {
			if (typeof value !== "function") continue;
			if (!/(Home|Root|Dir|Db|Path)$/.test(exportName)) continue;
			found.push([`${moduleName}.${exportName}`, value as (env: Record<string, string>) => unknown]);
		}
	}
	return found;
}

describe("every home-derived mnemopi root", () => {
	it("has resolvers to sweep", () => {
		// The sweep below is vacuous if discovery finds nothing, which is exactly the
		// shape of failure this file exists to prevent.
		const names = pathResolvers().map(([name]) => name);
		expect(names).toContain("config.hermesRoot");
		expect(names).toContain("content-sanitizer.blobRoot");
		expect(names).toContain("cost-log.costLogDb");
		expect(names).toContain("plugins.pluginRoot");
		expect(names.length).toBeGreaterThanOrEqual(10);
	});

	it("resolves under MNEMOPI_HOME and never under the ambient home", () => {
		const home = mkdtempSync(join(tmpdir(), "mnemopi-lever-"));
		const outside: string[] = [];
		for (const [name, resolve] of pathResolvers()) {
			const resolved = resolve({ MNEMOPI_HOME: home, HOME: FORBIDDEN_HOME });
			expect(typeof resolved, `${name} must answer with a path`).toBe("string");
			if (!String(resolved).startsWith(home)) outside.push(`${name} -> ${String(resolved)}`);
		}
		expect(outside).toEqual([]);
	});

	it("falls back to HOME before the ambient user, so an isolated HOME is honored too", () => {
		// `MNEMOPI_HOME` is the explicit lever; `HOME` is the one every sandbox already
		// sets. A resolver reading `os.homedir()` directly satisfies neither.
		const resolved = String(config.hermesRoot({ HOME: FORBIDDEN_HOME }));
		expect(resolved).toBe(join(FORBIDDEN_HOME, ".hermes"));
	});
});

describe("the code that writes", () => {
	it("stores a blob under MNEMOPI_HOME rather than the ambient home", () => {
		const home = mkdtempSync(join(tmpdir(), "mnemopi-blob-"));
		const previousHome = process.env.MNEMOPI_HOME;
		const previousBlobDir = process.env.MNEMOPI_BLOB_DIR;
		process.env.MNEMOPI_HOME = home;
		// The blob-specific lever must be out of the way: the point is that the HOME
		// lever alone is enough, which it was not while the default was baked in.
		delete process.env.MNEMOPI_BLOB_DIR;
		try {
			const sha = sanitizer.storeBlob(Buffer.from("blob bytes that must not land in a real home"));
			const blob = join(home, ".hermes", "mnemopi", "blobs", sha.slice(0, 2), sha.slice(0, 4), sha);
			expect(existsSync(blob)).toBe(true);
		} finally {
			if (previousHome === undefined) delete process.env.MNEMOPI_HOME;
			else process.env.MNEMOPI_HOME = previousHome;
			if (previousBlobDir !== undefined) process.env.MNEMOPI_BLOB_DIR = previousBlobDir;
		}
	});

	it("opens the cost log under MNEMOPI_HOME rather than the ambient home", () => {
		const home = mkdtempSync(join(tmpdir(), "mnemopi-cost-"));
		const previousHome = process.env.MNEMOPI_HOME;
		process.env.MNEMOPI_HOME = home;
		try {
			costLog.initCostLog();
			expect(existsSync(join(home, ".mnemopi", "data", "cost_log.db"))).toBe(true);
			// The root name is part of the contract: the suite guard watches this exact
			// entry, and a rename would make the guard blind again.
			expect(readdirSync(home)).toContain(".mnemopi");
		} finally {
			if (previousHome === undefined) delete process.env.MNEMOPI_HOME;
			else process.env.MNEMOPI_HOME = previousHome;
		}
	});
});
