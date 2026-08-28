import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { errorMessage } from "@veyyon/utils";

/**
 * Choosing which credential store to stage into every task container.
 *
 * The runner copies the operator's `agent.db` into `assets/auth-agent.db`, which
 * is bind-mounted into all N task containers. Getting that copy wrong does not
 * fail loudly: the agent starts, cannot authenticate, and the run reports N task
 * failures that look like model or harness problems. Both ways of getting it
 * wrong had bitten real runs, so the decision lives here as a pure function with
 * its own tests rather than inline where nothing could reach it.
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
 */
export function probeCredentialStore(databasePath: string): string | undefined {
	let db: Database | undefined;
	try {
		db = new Database(databasePath, { readonly: true });
		const row = db.query("PRAGMA quick_check").get() as { quick_check?: string } | null;
		const verdict = row?.quick_check;
		return verdict === "ok" ? undefined : `PRAGMA quick_check returned ${JSON.stringify(verdict ?? null)}`;
	} catch (error) {
		return errorMessage(error);
	} finally {
		db?.close();
	}
}

/**
 * Copy a live credential store the way SQLite requires, rather than as a file.
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
