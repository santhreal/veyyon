import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	aggregateVeracity,
	clampVeracity,
	isVeracity,
	VERACITY_ALLOWED,
	VERACITY_WEIGHTS,
	type Veracity,
	weightForVeracity,
} from "./veracity";

export {
	aggregateVeracity,
	clampVeracity,
	isVeracity,
	VERACITY_ALLOWED,
	VERACITY_WEIGHTS,
	type Veracity,
	weightForVeracity,
};

export const TX_DEPTH = Symbol("mnemopi.veracity.txDepth");

export type TxDatabase = Database & {
	readonly inTransaction?: boolean;
	readonly in_transaction?: boolean;
	[TX_DEPTH]?: number;
};

export interface ConsolidatedFact {
	readonly subject: string;
	readonly predicate: string;
	readonly object: string;
	readonly confidence: number;
	readonly mention_count: number;
	readonly first_seen: string | null;
	readonly last_seen: string | null;
	readonly sources: string[];
	readonly veracity: string;
	readonly superseded: boolean;
	readonly id: string | null;
}

export interface ConsolidatedFactRow {
	readonly id: string;
	readonly subject: string;
	readonly predicate: string;
	readonly object: string;
	readonly confidence: number;
	readonly mention_count: number;
	readonly first_seen: string | null;
	readonly last_seen: string | null;
	readonly sources_json: string | null;
	readonly veracity: string;
	readonly superseded_by: string | null;
}

export interface ConflictRow {
	readonly id: number;
	readonly fact_a_id: string;
	readonly fact_b_id: string;
	readonly conflict_type: string | null;
	readonly resolution: string | null;
	readonly resolved_at: string | null;
	readonly created_at: string | null;
}

export interface Conflict {
	readonly id: number;
	readonly fact_a_id: string;
	readonly fact_b_id: string;
	readonly type: string | null;
	readonly created_at: string | null;
}

export interface ConsolidationStats {
	readonly active_facts: number;
	readonly superseded_facts: number;
	readonly unresolved_conflicts: number;
	readonly avg_confidence: number;
	readonly avg_mentions: number;
}

export function sqliteInTransaction(db: Database): boolean {
	const txDb = db as TxDatabase;
	return txDb.inTransaction === true || txDb.in_transaction === true || (txDb[TX_DEPTH] ?? 0) > 0;
}

export function parseSources(raw: string | null): string[] {
	if (raw === null || raw === "") return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const out: string[] = [];
		for (const item of parsed) {
			if (typeof item === "string") out.push(item);
		}
		return out;
	} catch {
		return [];
	}
}

export function computeFactId(subject: string, predicate: string, object: string): string {
	for (const [name, value] of [
		["subject", subject],
		["predicate", predicate],
		["object", object],
	] as const) {
		if (typeof value !== "string") {
			throw new TypeError(`compute_fact_id: ${name} must be a str, got ${typeof value}`);
		}
		if (value === "") throw new RangeError(`compute_fact_id: ${name} must be non-empty`);
	}

	const chunks: Buffer[] = [];
	for (const value of [subject, predicate, object]) {
		const bytes = Buffer.from(value.normalize("NFC"), "utf8");
		chunks.push(Buffer.from(`${bytes.length}:`, "ascii"), bytes);
	}
	return `cf_${createHash("sha256").update(Buffer.concat(chunks)).digest("hex").slice(0, 24)}`;
}
