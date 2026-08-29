import { Database, type SQLQueryBindings } from "bun:sqlite";
import { closeQuietly, type DatabasePath, openDatabase } from "../db";
import type {
	ContentSnapshot,
	TripleImportRow,
	TripleImportStats,
	TripleQueryOptions,
	TripleRow,
	TripleWriteOptions,
} from "./triples-helpers";
import {
	contentFromRow,
	initTriples,
	normalizeContent,
	normalizeImportBindings,
	normalizeOptions,
	resolveDefaultTripleDb,
	rowToTriple,
	sameContent,
	TRIPLE_COLUMNS,
	today,
} from "./triples-helpers";

export { defaultTripleDbPath } from "./triples-helpers";
export { initTriples, resolveDefaultTripleDb };

export class TripleStore {
	readonly dbPath: DatabasePath;
	readonly conn: Database;
	#ownsConnection: boolean;

	constructor(dbPath?: DatabasePath | Database | null) {
		if (dbPath instanceof Database) {
			this.dbPath = ":memory:";
			this.conn = dbPath;
			this.#ownsConnection = false;
			initTriples(this.conn);
			return;
		}
		this.dbPath = dbPath ?? resolveDefaultTripleDb();
		this.conn = openDatabase(this.dbPath);
		this.#ownsConnection = true;
		initTriples(this.conn);
	}

	close(): void {
		if (!this.#ownsConnection) return;
		this.#ownsConnection = false;
		closeQuietly(this.conn);
	}

	add(subject: string, predicate: string, object: string, options?: TripleWriteOptions | string | null): number {
		const normalized = normalizeOptions(options);
		const validFrom = normalized.validFrom ?? today();
		this.conn.run("UPDATE triples SET valid_until = ? WHERE subject = ? AND predicate = ? AND valid_until IS NULL", [
			validFrom,
			subject,
			predicate,
		]);
		const result = this.conn.run(
			"INSERT INTO triples (subject, predicate, object, valid_from, source, confidence) VALUES (?, ?, ?, ?, ?, ?)",
			[subject, predicate, object, validFrom, normalized.source, normalized.confidence],
		);
		return Number(result.lastInsertRowid);
	}

	query(options?: TripleQueryOptions): TripleRow[];
	query(subject?: string | null, predicate?: string | null, object?: string | null, asOf?: string | null): TripleRow[];
	query(
		optionsOrSubject?: TripleQueryOptions | string | null,
		predicate?: string | null,
		object?: string | null,
		asOf?: string | null,
	): TripleRow[] {
		const options: TripleQueryOptions =
			typeof optionsOrSubject === "object" && optionsOrSubject !== null
				? optionsOrSubject
				: { subject: optionsOrSubject, predicate, object, asOf };
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		if (options.subject) {
			conditions.push("subject = ?");
			params.push(options.subject);
		}
		if (options.predicate) {
			conditions.push("predicate = ?");
			params.push(options.predicate);
		}
		if (options.object) {
			conditions.push("object = ?");
			params.push(options.object);
		}
		const effectiveAsOf = options.asOf ?? options.as_of ?? today();
		conditions.push("valid_from <= ?");
		params.push(effectiveAsOf);
		conditions.push("(valid_until IS NULL OR valid_until > ?)");
		params.push(effectiveAsOf);
		const where = conditions.join(" AND ");
		return this.conn
			.query(`SELECT ${TRIPLE_COLUMNS} FROM triples WHERE ${where} ORDER BY valid_from DESC`)
			.all(...params)
			.map(rowToTriple);
	}

	queryByPredicate(predicate: string, object?: string | null, subject?: string | null): TripleRow[] {
		const conditions = ["predicate = ?"];
		const params: string[] = [predicate];
		if (object) {
			conditions.push("object = ?");
			params.push(object);
		}
		if (subject) {
			conditions.push("subject = ?");
			params.push(subject);
		}
		return this.conn
			.query(`SELECT ${TRIPLE_COLUMNS} FROM triples WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`)
			.all(...params)
			.map(rowToTriple);
	}
	getDistinctObjects(predicate: string): string[] {
		return this.conn
			.query("SELECT DISTINCT object FROM triples WHERE predicate = ? ORDER BY object")
			.all(predicate)
			.map(row => (row as { object: string }).object);
	}
	exportAll(): TripleRow[] {
		return this.conn.query(`SELECT ${TRIPLE_COLUMNS} FROM triples ORDER BY id`).all().map(rowToTriple);
	}
	importAll(triples: readonly TripleImportRow[], force = false): TripleImportStats {
		const stats: TripleImportStats = {
			inserted: 0,
			skipped: 0,
			overwritten: 0,
			imported_renumbered: 0,
		};
		const seen = new Set<number>();
		for (const item of triples) {
			if (item.id === undefined || item.id === null) continue;
			if (seen.has(item.id))
				throw new Error(
					`import_all: duplicate id ${item.id} in the imported batch. Deduplicate the input before calling.`,
				);
			seen.add(item.id);
		}

		this.conn.run("BEGIN IMMEDIATE");
		try {
			const existing = new Map<number, ContentSnapshot>();
			for (const row of this.conn.query(`SELECT ${TRIPLE_COLUMNS} FROM triples`).all().map(rowToTriple)) {
				existing.set(row.id, contentFromRow(row));
			}
			const explicitNoCollision: TripleImportRow[] = [];
			const noId: TripleImportRow[] = [];
			const collisions: TripleImportRow[] = [];
			for (const item of triples) {
				const id = item.id;
				if (id === undefined || id === null) noId.push(item);
				else if (existing.has(id)) collisions.push(item);
				else explicitNoCollision.push(item);
			}
			for (const item of explicitNoCollision) {
				this.#insertWithId(item, item.id as number);
				stats.inserted++;
			}
			for (const item of noId) {
				this.#insertWithoutId(item);
				stats.inserted++;
			}
			for (const item of collisions) {
				const id = item.id as number;
				if (force) {
					this.conn.run("DELETE FROM triples WHERE id = ?", [id]);
					this.#insertWithId(item, id);
					stats.overwritten++;
				} else if (sameContent(normalizeContent(item), existing.get(id) as ContentSnapshot)) {
					stats.skipped++;
				} else {
					try {
						this.#insertWithoutId(item);
						stats.imported_renumbered++;
					} catch (error) {
						if (!(error instanceof Error) || !error.message.toLowerCase().includes("constraint")) throw error;
						stats.skipped++;
					}
				}
			}
			this.conn.run("COMMIT");
			return stats;
		} catch (error) {
			try {
				this.conn.run("ROLLBACK");
			} catch {}
			throw error;
		}
	}
	#insertWithId(item: TripleImportRow, id: number): void {
		const bindings = normalizeImportBindings(item);
		const params: SQLQueryBindings[] = [
			id,
			bindings.subject,
			bindings.predicate,
			bindings.object,
			bindings.valid_from,
			bindings.valid_until,
			bindings.source,
			bindings.confidence,
			bindings.created_at,
		];
		this.conn.run(`INSERT INTO triples (${TRIPLE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, params);
	}

	#insertWithoutId(item: TripleImportRow): void {
		const bindings = normalizeImportBindings(item);
		const params: SQLQueryBindings[] = [
			bindings.subject,
			bindings.predicate,
			bindings.object,
			bindings.valid_from,
			bindings.valid_until,
			bindings.source,
			bindings.confidence,
			bindings.created_at,
		];
		this.conn.run(
			"INSERT INTO triples (subject, predicate, object, valid_from, valid_until, source, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			params,
		);
	}
}

export function addTriple(
	subject: string,
	predicate: string,
	object: string,
	options?: TripleWriteOptions & { readonly dbPath?: DatabasePath | null },
): number {
	const store = new TripleStore(options?.dbPath ?? null);
	try {
		return store.add(subject, predicate, object, options);
	} finally {
		store.close();
	}
}

export function queryTriples(options?: TripleQueryOptions & { readonly dbPath?: DatabasePath | null }): TripleRow[] {
	const store = new TripleStore(options?.dbPath ?? null);
	try {
		return store.query(options);
	} finally {
		store.close();
	}
}
