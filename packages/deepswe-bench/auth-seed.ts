import { Database } from "bun:sqlite";
import * as fs from "node:fs";

/**
 * Choosing which credential store to stage into every task container.
 *
 * The runner copies the operator's `agent.db` into `assets/auth-agent.db`, which
 * is bind-mounted into all N task containers. Getting that copy wrong does not
 * fail loudly: the agent starts, cannot authenticate, and the run reports N task
 * failures that look like model or harness problems. Both ways of getting it
 * wrong had bitten real runs, so the decision lives here as a pure function with
 * its own tests rather than inline in `run.ts` where nothing could reach it.
 *
 * The two failure modes:
 *
 *   1. PICKING A PRE-MOVE STORE. Logins used to live under
 *      `profiles/<name>/shared-auth`; they now live in the machine-wide
 *      `~/.veyyon/shared-auth` (`getSharedAuthDir`). The old files commonly
 *      survive as stale leftovers, so a candidate list that tried them first
 *      staged credentials that expired long ago while a live store sat unread.
 *
 *   2. FREEZING ONE SNAPSHOT. The staged copy was written once and then reused
 *      forever if the file merely existed. OAuth access tokens rotate, so from
 *      the first refresh onward every container received a token the provider
 *      had already retired.
 *
 *   3. TRUSTING MTIME ALONE. Being newer than the live store is not the same as
 *      being readable. A run on 2026-07-25 staged a torn copy, and every run
 *      after it saw a staged file with a newer timestamp, kept it, and died on
 *      `database disk image is malformed` again. One bad write was enough to
 *      wedge the bench permanently, and the only way out was knowing to delete
 *      an asset by hand. The staged copy is now opened and checked before it is
 *      believed, so a corrupt one costs a re-seed instead of the whole run.
 */

/** What the runner should do about `assets/auth-agent.db`, and why. */
export type AuthSeedDecision =
	/** No candidate store exists. The run cannot authenticate; fail before launching containers. */
	| { readonly kind: "missing" }
	/** No staged copy yet: copy `source`. */
	| { readonly kind: "seed"; readonly source: string; readonly legacy: boolean }
	/** The staged copy predates `source`, so it may hold a rotated-out token: copy again. */
	| { readonly kind: "reseed"; readonly source: string; readonly legacy: boolean; readonly reason: "stale" }
	/**
	 * The staged copy is new enough but does not open as a database: copy again,
	 * and carry the fault so the caller can print what was actually wrong rather
	 * than re-seeding for no stated reason.
	 */
	| {
			readonly kind: "reseed";
			readonly source: string;
			readonly legacy: boolean;
			readonly reason: "unreadable";
			readonly fault: string;
	  }
	/** The staged copy is at least as new as `source` and opens cleanly: leave it alone. */
	| { readonly kind: "current"; readonly source: string; readonly legacy: boolean };

/**
 * Pick a store and decide whether the staged copy needs rewriting.
 *
 * `sources` is ordered most-canonical first; the first that exists wins, and
 * `legacy` is true whenever that is not the first entry, so the caller can say so
 * out loud instead of silently running on pre-move credentials.
 *
 * `mtimeOf` returns undefined for a path that does not exist, which is how both
 * "no store at all" and "nothing staged yet" are expressed.
 *
 * Ties re-use the staged copy. Equal mtimes mean the file has not been touched
 * since it was staged, and copying on equality would rewrite the asset on every
 * run for no change.
 *
 * `faultOf` reports why the staged copy cannot be used, or undefined if it is
 * fine. It is consulted only when the timestamps say to keep the staged file,
 * which is the one path where a bad copy could otherwise survive forever; a
 * decision to re-seed does not need it, since the copy is about to be replaced.
 * Pass `probeCredentialStore` in production. It is a parameter so the decision
 * stays a pure function with tests that need no real database.
 */
export function decideAuthSeed(
	sources: readonly string[],
	stagedPath: string,
	mtimeOf: (p: string) => number | undefined,
	faultOf: (p: string) => string | undefined,
): AuthSeedDecision {
	let source: string | undefined;
	let legacy = false;
	for (let i = 0; i < sources.length; i++) {
		const candidate = sources[i] as string;
		if (mtimeOf(candidate) !== undefined) {
			source = candidate;
			legacy = i > 0;
			break;
		}
	}
	if (source === undefined) return { kind: "missing" };

	const stagedMtime = mtimeOf(stagedPath);
	if (stagedMtime === undefined) return { kind: "seed", source, legacy };
	// `source` exists, so its mtime is defined; the ?? 0 keeps the types honest
	// without inventing a branch that cannot happen.
	if ((mtimeOf(source) ?? 0) > stagedMtime) return { kind: "reseed", source, legacy, reason: "stale" };

	const fault = faultOf(stagedPath);
	if (fault !== undefined) return { kind: "reseed", source, legacy, reason: "unreadable", fault };
	return { kind: "current", source, legacy };
}

/**
 * Report why a staged credential store cannot be used, or undefined if it can.
 *
 * Existing and being non-empty says nothing: the file this exists to catch was
 * 716,800 bytes and had a newer timestamp than the live store. `PRAGMA
 * quick_check` reads the pages and reports structural damage, which is the
 * same check that later fails deep inside `AuthStorage` as an uncaught
 * `SQLiteError` after the runner has already built a binary and started
 * arranging containers.
 *
 * The message is returned rather than logged so the caller decides how loud to
 * be, and rather than thrown so a damaged file is a re-seed rather than an
 * abort. Every non-`ok` outcome is a fault: `quick_check` says exactly `ok` on
 * a healthy database and lists the problems otherwise.
 */
export function probeCredentialStore(databasePath: string): string | undefined {
	let db: Database | undefined;
	try {
		db = new Database(databasePath, { readonly: true });
		const row = db.query("PRAGMA quick_check").get() as { quick_check?: string } | null;
		const verdict = row?.quick_check;
		return verdict === "ok" ? undefined : `PRAGMA quick_check returned ${JSON.stringify(verdict ?? null)}`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	} finally {
		db?.close();
	}
}

/**
 * Copy a live credential store the way SQLite requires, rather than as a file.
 *
 * The store runs in WAL mode, so `agent.db` on its own is not the database: a
 * committed row can live only in `agent.db-wal` until a checkpoint folds it
 * back, and the main file is rewritten in place while other processes are
 * writing. Copying just that one file therefore captures whatever the writer
 * happened to have flushed at that instant, which is usually fine and
 * occasionally a torn page.
 *
 * That is a race, so it fails at random and destroys a whole run when it does:
 * a bench start on 2026-07-25 died on `database disk image is malformed` from
 * the staged copy, while `PRAGMA integrity_check` on the live store said `ok`
 * and a second copy taken a minute later was clean. An intermittent failure
 * that reads as credential corruption is worse than a loud one, because the
 * obvious next move is to go looking at the operator's login.
 *
 * `VACUUM INTO` takes a read transaction and writes a fresh, fully checkpointed
 * database, so the result reflects one consistent point in time including
 * anything still sitting in the WAL, and it needs no write access to the
 * source. The destination must not exist, and its sidecars are cleared too so a
 * previous run's `-wal` can never be read alongside a newer snapshot.
 */
export function snapshotCredentialStore(source: string, destination: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		fs.rmSync(`${destination}${suffix}`, { force: true });
	}
	const db = new Database(source, { readonly: true });
	try {
		db.run("VACUUM INTO ?", [destination]);
	} finally {
		db.close();
	}
}
