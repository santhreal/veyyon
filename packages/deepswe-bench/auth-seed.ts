import { Database } from "bun:sqlite";
import * as fs from "node:fs";

export type AuthSeedDecision =
	| { readonly kind: "missing" }
	| { readonly kind: "seed"; readonly source: string; readonly legacy: boolean }
	| { readonly kind: "reseed"; readonly source: string; readonly legacy: boolean; readonly reason: "stale" }
	| {
			readonly kind: "reseed";
			readonly source: string;
			readonly legacy: boolean;
			readonly reason: "unreadable";
			readonly fault: string;
	  }
	| { readonly kind: "current"; readonly source: string; readonly legacy: boolean };

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
	if ((mtimeOf(source) ?? 0) > stagedMtime) return { kind: "reseed", source, legacy, reason: "stale" };

	const fault = faultOf(stagedPath);
	if (fault !== undefined) return { kind: "reseed", source, legacy, reason: "unreadable", fault };
	return { kind: "current", source, legacy };
}

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
