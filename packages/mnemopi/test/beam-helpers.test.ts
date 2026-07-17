import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import "./setup";
import {
	buildFtsQuery,
	cjkFtsTerms,
	containsSpacelessCjk,
	decodeVector,
	detectLanguage,
	encodeVector,
	ftsQueryTerms,
	inMemoryVecSearch,
	normalizeImportance,
	normalizeMetadata,
	normalizeWeights,
	recallTokens,
	workingMemoryVecSearch,
} from "@veyyon/pi-mnemopi/core/beam/helpers";
import { generateTimedId, stableMemoryId } from "@veyyon/pi-mnemopi/util/ids";

describe("beam helper ids, weights, and metadata", () => {
	it("generates unique timed ids and deterministic stable ids", () => {
		const now = new Date("2024-01-02T03:04:05.000Z");

		expect(generateTimedId("hello", now)).toHaveLength(16);
		expect(generateTimedId("hello", now)).not.toBe(generateTimedId("hello", now));
		expect(generateTimedId("hello", now)).not.toBe(generateTimedId("hello", new Date("2024-01-02T03:04:06.000Z")));
		expect(stableMemoryId("hello", "conversation")).toBe(stableMemoryId("hello", "conversation"));
		expect(stableMemoryId("hello", "conversation")).not.toBe(stableMemoryId("hello", "other"));
	});

	it("normalizes hybrid weights and clamps importance metadata inputs", () => {
		expect(normalizeWeights(2, 1, 1)).toEqual([0.5, 0.25, 0.25]);
		expect(normalizeWeights(-1, 0, 0)).toEqual([0.5, 0.3, 0.2]);
		expect(normalizeImportance(1.5)).toBe(1);
		expect(normalizeImportance(-0.1)).toBe(0);
		expect(normalizeMetadata('{"ok":true,"bad":null,"nan":null,"nested":{"n":2}}')).toEqual({
			ok: true,
			bad: null,
			nan: null,
			nested: { n: 2 },
		});
	});
});

describe("beam lexical and FTS helpers", () => {
	it("builds stopword-filtered FTS terms with query-side synonyms", () => {
		expect(recallTokens("What is my branding preference for the professional URL? 123")).toEqual([
			"branding",
			"preference",
			"professional",
			"url",
		]);
		expect(ftsQueryTerms("branding preference")).toEqual([
			'"branding"',
			'"brand"',
			'"positioning"',
			'"identity"',
			'"wording"',
			'"preference"',
			'"prefer"',
			'"prefers"',
			'"want"',
			'"wants"',
			'"reject"',
			'"rejects"',
			'"avoid"',
			'"grounded"',
		]);
		expect(buildFtsQuery('say "hello"')).toBe('"say" OR "hello"');
	});

	it("detects spaceless CJK queries and expands them into char + bigram FTS terms", () => {
		expect(containsSpacelessCjk("東京で会う")).toBe(true);
		expect(cjkFtsTerms("東京東京")).toEqual(["東", "京", '"東京"', '"京東"']);
	});
});

describe("beam temporal and language helpers", () => {
	it("detects supported languages without external dependencies", () => {
		expect(detectLanguage("Привет, это мой проект и это важно")).toBe("ru");
		expect(detectLanguage("ich bin sehr gern dabei und das ist gut")).toBe("de");
		expect(detectLanguage("recuerda que siempre usa este estilo")).toBe("es");
		expect(detectLanguage("plain English text")).toBe("en");
	});
});

describe("beam vector fallback helpers", () => {
	it("encodes, decodes, and searches episodic fallback vectors", () => {
		const db = new Database(":memory:");
		try {
			db.run("CREATE TABLE episodic_memory (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, content TEXT)");
			db.run("CREATE TABLE memory_embeddings (memory_id TEXT PRIMARY KEY, embedding_json TEXT)");
			db.query("INSERT INTO episodic_memory (id, content) VALUES (?, ?)").run("same", "same vector");
			db.query("INSERT INTO episodic_memory (id, content) VALUES (?, ?)").run("orthogonal", "orthogonal vector");
			db.query("INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?, ?)").run(
				"same",
				encodeVector([1, 0]),
			);
			db.query("INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?, ?)").run(
				"orthogonal",
				encodeVector([0, 1]),
			);

			expect(decodeVector("[1,0]")).toEqual([1, 0]);
			expect(decodeVector("[1,null]")).toBeNull();
			expect(inMemoryVecSearch(db, [1, 0], 2)).toEqual([
				{ rowid: 1, distance: 0 },
				{ rowid: 2, distance: 1 },
			]);
		} finally {
			db.close();
		}
	});

	it("searches working-memory fallback vectors and skips expired rows", () => {
		const db = new Database(":memory:");
		try {
			db.run(
				"CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT, superseded_by TEXT, valid_until TEXT)",
			);
			db.run("CREATE TABLE memory_embeddings (memory_id TEXT PRIMARY KEY, embedding_json TEXT)");
			db.query("INSERT INTO working_memory (id, content, superseded_by, valid_until) VALUES (?, ?, NULL, NULL)").run(
				"same",
				"same",
			);
			db.query("INSERT INTO working_memory (id, content, superseded_by, valid_until) VALUES (?, ?, NULL, ?)").run(
				"expired",
				"expired",
				"2024-01-01T00:00:00.000Z",
			);
			db.query("INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?, ?)").run(
				"same",
				encodeVector([1, 0]),
			);
			db.query("INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?, ?)").run(
				"expired",
				encodeVector([1, 0]),
			);

			expect(workingMemoryVecSearch(db, [1, 0], 10, new Date("2024-01-02T00:00:00.000Z"))).toEqual([
				{ id: "same", sim: 1 },
			]);
		} finally {
			db.close();
		}
	});
});
