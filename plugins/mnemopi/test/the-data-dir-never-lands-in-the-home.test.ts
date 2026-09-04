/**
 * The mnemopi suite's DATA dir goes to a temp directory too, and the home is how we know.
 *
 * THE LEAK THIS PREVENTS. This package has TWO home-derived roots and the shared test env
 * only moved one. `enterIsolatedConfigRoot()` moves `VEYYON_CONFIG_DIR`, which decides where
 * `getFastembedCacheDir()` and the rest of the veyyon config tree land. It has no effect on
 * `dataDir()`, whose only lever is `MNEMOPI_DATA_DIR` and whose default is
 * `~/.hermes/mnemopi/data`. Every module-level facade call -- `remember`, `recall`,
 * `getContext`, `getStats`, `get` -- opens a SQLite database at `<dataDir>/mnemopi.db`, so
 * with the variable unset one call puts a `.db`, a `-wal` and a `-shm` in the operator's real
 * home and initializes the whole schema there. A 372KB schema-only `mnemopi.db` with zero
 * rows in every data table was found sitting in one real home.
 *
 * `useMnemopiTestEnv()`'s `afterAll` could not see it: it listed only `.veyyon*` entries, and
 * this root is `.hermes`. That is the same failure as the one that let 131
 * `~/.veyyon-mnemopi-profile-iso-*` directories accumulate -- isolation that is correct from
 * inside the suite and checked against the wrong question -- so the guard now lists both
 * prefixes and the env sets `MNEMOPI_DATA_DIR` alongside the config root.
 *
 * This file supplies the write that makes the guard bite. `useMnemopiTestEnv()` supplies the
 * verdict for every mnemopi file. Delete the `MNEMOPI_DATA_DIR` assignment in `setup.ts` and
 * the first case here goes red because the database lands under the home; drop `.hermes` back
 * out of `homeRootsAMnemopiRunCouldCreate()` and the second case goes red because a resolver
 * that answers with a home path is no longer refused.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { dataDir, dbPath } from "@veyyon/mnemopi/config";
import { getContext, getStats, remember } from "@veyyon/mnemopi/core/memory";
import { useMnemopiTestEnv } from "./setup";

useMnemopiTestEnv();

/** True when `candidate` is the home directory itself or anything beneath it. */
function isUnderHome(candidate: string): boolean {
	const rel = relative(homedir(), candidate);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

describe("the mnemopi data dir never lands in the home", () => {
	/**
	 * The resolver is asked where it would write BEFORE anything writes, because a path is
	 * decidable and a missing file is not: `~/.hermes/mnemopi/data` may already exist for
	 * unrelated reasons, so "nothing appeared" is a weaker statement than "the answer is not
	 * in the home".
	 */
	it("resolves its data dir and db path outside the home", () => {
		expect(isUnderHome(dataDir())).toBe(false);
		expect(isUnderHome(dbPath())).toBe(false);
		expect(dbPath()).toBe(join(dataDir(), "mnemopi.db"));
	});

	/**
	 * The write. A facade call with no explicit `dbPath` opens the default database, which is
	 * the exact call shape that put a schema-only `mnemopi.db` in a real home. The database has
	 * to exist afterwards -- otherwise this proves nothing about where writes go, only that
	 * nothing happened -- and it has to exist outside the home.
	 */
	it("creates its database outside the home when the facade is used with no explicit path", () => {
		const id = remember("a fact written by the data-dir isolation proof", { source: "test" });
		expect(typeof id).toBe("string");

		const created = dbPath();
		expect(existsSync(created)).toBe(true);
		expect(isUnderHome(created)).toBe(false);
		expect(isUnderHome(dirname(created))).toBe(false);
	});

	/** The read-shaped facade entry points open the same database, so they get the same proof. */
	it("keeps the reads out of the home as well", () => {
		expect(Array.isArray(getContext(1))).toBe(true);
		expect(getStats().database).toBe(dbPath());
		expect(isUnderHome(getStats().database)).toBe(false);
	});
});
