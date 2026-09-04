import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { onRequest } from "./grievances";

type BoundValue = string | number;

interface BatchResult {
	success: boolean;
}

interface StoredGrievance {
	install_id: string;
	local_id: number;
	agent_version: string;
	model: string;
	entry_version: string;
	tool: string;
	report: string;
	platform: string;
	arch: string;
	received_at: string;
}

class FakeD1Statement {
	constructor(
		readonly database: FakeD1Database,
		readonly sql: string,
		readonly values: readonly BoundValue[] = [],
	) {}

	bind(...values: BoundValue[]): FakeD1Statement {
		return new FakeD1Statement(this.database, this.sql, values);
	}
}

class FakeD1Database {
	readonly sqlite = new Database(":memory:");
	batchCalls = 0;
	readonly batchSizes: number[] = [];

	constructor() {
		const migration = readFileSync(new URL("../../migrations/0001_grievances.sql", import.meta.url), "utf8");
		this.sqlite.exec(migration);
	}

	prepare(sql: string): FakeD1Statement {
		return new FakeD1Statement(this, sql);
	}

	async batch(statements: FakeD1Statement[]): Promise<BatchResult[]> {
		this.batchCalls += 1;
		this.batchSizes.push(statements.length);
		const execute = this.sqlite.transaction((items: FakeD1Statement[]) =>
			items.map(statement => {
				if (statement.database !== this) throw new Error("Statement belongs to a different database");
				this.sqlite.query(statement.sql).run(...statement.values);
				return { success: true };
			}),
		);
		return execute(statements);
	}

	rows(): StoredGrievance[] {
		return this.sqlite
			.query<StoredGrievance, []>(
				`SELECT install_id, local_id, agent_version, model, entry_version, tool,
					report, platform, arch, received_at
				 FROM grievances ORDER BY local_id`,
			)
			.all();
	}

	close(): void {
		this.sqlite.close();
	}
}

const openDatabases: FakeD1Database[] = [];

function fakeDatabase(): FakeD1Database {
	const database = new FakeD1Database();
	openDatabases.push(database);
	return database;
}

function validPayload(): {
	agent: { name: "veyyon"; version: string };
	installId: string;
	platform: string;
	arch: string;
	entries: Array<{ id: number; model: string; version: string; tool: string; report: string }>;
} {
	return {
		agent: { name: "veyyon", version: "1.0.37" },
		installId: "11111111-2222-4333-8444-555555555555",
		platform: "linux",
		arch: "x64",
		entries: [
			{
				id: 17,
				model: "openai/gpt-5.6-sol",
				version: "1.0.36",
				tool: "read",
				report: "Quoted ‘text’, commas, and a newline\nstay byte-for-byte intact.",
			},
			{
				id: 19,
				model: "anthropic/claude-sonnet-4.5",
				version: "1.0.37",
				tool: "browser",
				report: "The response contained 日本語 and <script>literal text</script>.",
			},
		],
	};
}

function post(database: FakeD1Database, payload: unknown, contentType = "application/json; charset=utf-8"): Promise<Response> {
	return onRequest({
		request: new Request("https://veyyon.dev/api/grievances", {
			method: "POST",
			headers: { "content-type": contentType },
			body: JSON.stringify(payload),
		}),
		env: { GRIEVANCES_DB: database },
	});
}

function postRaw(database: FakeD1Database, body: string, contentType = "application/json"): Promise<Response> {
	return onRequest({
		request: new Request("https://veyyon.dev/api/grievances", {
			method: "POST",
			headers: { "content-type": contentType },
			body,
		}),
		env: { GRIEVANCES_DB: database },
	});
}

afterEach(() => {
	for (const database of openDatabases.splice(0)) database.close();
});

describe("POST /api/grievances", () => {
	/** Protects the ingestion contract: one D1 batch stores every validated field exactly and timestamps it on the server. */
	test("accepts and persists a valid batch", async () => {
		const database = fakeDatabase();
		const payload = validPayload();
		const before = Date.now();
		const response = await post(database, payload);
		const after = Date.now();

		expect(response.status).toBe(202);
		expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ accepted: 2 });
		expect(database.batchCalls).toBe(1);
		expect(database.batchSizes).toEqual([2]);

		const rows = database.rows();
		expect(rows).toHaveLength(2);
		for (let index = 0; index < rows.length; index += 1) {
			const row = rows[index];
			const entry = payload.entries[index];
			expect(row).toMatchObject({
				install_id: payload.installId,
				local_id: entry.id,
				agent_version: payload.agent.version,
				model: entry.model,
				entry_version: entry.version,
				tool: entry.tool,
				report: entry.report,
				platform: payload.platform,
				arch: payload.arch,
			});
			const receivedAt = Date.parse(row.received_at);
			expect(Number.isNaN(receivedAt)).toBe(false);
			expect(receivedAt).toBeGreaterThanOrEqual(before);
			expect(receivedAt).toBeLessThanOrEqual(after);
		}
		expect(rows[0]?.received_at).toBe(rows[1]?.received_at);
	});

	/** Prevents retries from becoming errors or duplicate rows after the client misses an earlier acknowledgement. */
	test("returns 202 and remains idempotent for duplicate install and local ids", async () => {
		const database = fakeDatabase();
		const payload = validPayload();

		const first = await post(database, payload);
		const duplicate = await post(database, payload);

		expect(first.status).toBe(202);
		expect(duplicate.status).toBe(202);
		expect(await duplicate.json()).toEqual({ accepted: 2 });
		expect(database.batchCalls).toBe(2);
		expect(database.batchSizes).toEqual([2, 2]);
		expect(database.rows()).toHaveLength(2);
	});

	/** Prevents malformed JSON and non-JSON uploads from reaching the persistence boundary. */
	test("rejects malformed bodies and the wrong content type", async () => {
		const database = fakeDatabase();

		const malformed = await postRaw(database, "{not-json");
		const wrongType = await post(database, validPayload(), "text/plain");
		const empty = await postRaw(database, "");

		expect(malformed.status).toBe(400);
		expect(wrongType.status).toBe(415);
		expect(empty.status).toBe(400);
		expect(database.batchCalls).toBe(0);
	});

	/** Prevents oversized streaming bodies from being buffered or written even when their JSON shape is irrelevant. */
	test("rejects a body beyond the byte limit", async () => {
		const database = fakeDatabase();
		const response = await postRaw(database, `{"padding":"${"x".repeat(256 * 1024)}"}`);

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "Request body is too large" });
		expect(database.batchCalls).toBe(0);
	});

	/** Prevents coercion, prototype-shaped extras, unbounded fields, and invalid batch cardinality from crossing into SQL. */
	test("rejects adversarial shapes, values, and entry counts", async () => {
		const database = fakeDatabase();
		const base = validPayload();
		const tooManyEntries = Array.from({ length: 51 }, (_, index) => ({ ...base.entries[0], id: index + 1 }));
		const cases: unknown[] = [
			{ ...base, entries: [] },
			{ ...base, entries: tooManyEntries },
			{ ...base, installId: "not-a-uuid" },
			{ ...base, agent: { name: "other", version: "1.0.37" } },
			{ ...base, entries: [{ ...base.entries[0], id: 1.5 }] },
			{ ...base, entries: [{ ...base.entries[0], id: "17" }] },
			{ ...base, entries: [{ ...base.entries[0], report: "x".repeat(4097) }] },
			{ ...base, entries: [{ ...base.entries[0], report: "contains\0nul" }] },
			{ ...base, entries: [[base.entries[0]]] },
			{ ...base, unexpected: true },
			{ ...base, entries: [{ ...base.entries[0], __proto__: null, unexpected: true }] },
		];

		for (const candidate of cases) {
			const response = await post(database, candidate);
			expect(response.status).toBe(422);
			expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		}
		expect(database.batchCalls).toBe(0);
	});

	/** Prevents accidental exposure of the collector on read or other unsupported HTTP methods. */
	test("rejects non-POST methods with an Allow header", async () => {
		const database = fakeDatabase();
		const response = await onRequest({
			request: new Request("https://veyyon.dev/api/grievances", { method: "GET" }),
			env: { GRIEVANCES_DB: database },
		});

		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
		expect(await response.json()).toEqual({ error: "Method not allowed" });
		expect(database.batchCalls).toBe(0);
	});
});
