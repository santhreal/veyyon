import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { recallEnhanced } from "@veyyon/mnemopi/core/beam/recall";
import { initBeam } from "@veyyon/mnemopi/core/beam/schema";
import {
	exportToDict,
	forgetWorking,
	get,
	getContext,
	getGlobalWorkingStats,
	getWorkingStats,
	importFromDict,
	invalidate,
	remember,
	rememberBatch,
	scratchpadClear,
	scratchpadRead,
	scratchpadWrite,
	updateWorking,
} from "@veyyon/mnemopi/core/beam/store";
import type { BeamEvent, BeamMemoryState } from "@veyyon/mnemopi/core/beam/types";
import { EpisodicGraph } from "@veyyon/mnemopi/core/episodic-graph";
import { openDatabase } from "@veyyon/mnemopi/db";
import { logger } from "@veyyon/utils";

interface RecordedAnnotation {
	memoryId: string;
	kind: string;
	value: string;
}

const states: BeamMemoryState[] = [];

function makeState(
	sessionId = "session-a",
	events: BeamEvent[] = [],
	annotations: BeamMemoryState["annotations"] = null,
): BeamMemoryState {
	const db = openDatabase(":memory:");
	initBeam(db);
	const state: BeamMemoryState = {
		db,
		dbPath: ":memory:",
		sessionId,
		authorId: "author-a",
		authorType: "user",
		channelId: "channel-a",
		useCloud: false,
		eventEmitter: event => {
			events.push(event);
		},
		pluginManager: {
			emit: event => {
				events.push({ ...event, type: `plugin:${event.type}` });
			},
		},
		annotations,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
		},
	};
	states.push(state);
	return state;
}

afterEach(() => {
	while (states.length > 0) states.pop()?.db.close();
});

describe("beam store free functions", () => {
	it("remembers one item, deduplicates exact content, emits events, and keeps FTS in sync", () => {
		const events: BeamEvent[] = [];
		const beam = makeState("session-a", events);

		const id = remember(beam, "User prefers terse answers", {
			source: "conversation",
			importance: 0.8,
			metadata: { topic: "style" },
			veracity: "stated",
		});
		const duplicate = remember(beam, "User prefers terse answers", {
			importance: 0.9,
			veracity: "unknown",
		});

		expect(duplicate).toBe(id);
		expect(events.map(event => event.type)).toEqual([
			"MEMORY_ADDED",
			"plugin:MEMORY_ADDED",
			"MEMORY_UPDATED",
			"plugin:MEMORY_UPDATED",
		]);
		const row = get(beam, id);
		expect(row?.memory_store).toBe("working");
		expect(row?.content).toBe("User prefers terse answers");
		expect(row?.importance).toBe(0.9);
		expect(row?.veracity).toBe("stated");

		const ftsRows = beam.db.prepare("SELECT id FROM fts_working WHERE fts_working MATCH ?").all("terse") as {
			id: string;
		}[];
		expect(ftsRows.map(row => row.id)).toEqual([id]);
	});

	it("batch remembers items and returns context ordered by global scope, importance, then recency", () => {
		const beam = makeState();
		// Timestamps must stay inside the 24h working-memory TTL or trimWorkingMemory
		// drops them, so anchor them to "now" rather than a fixed (and eventually
		// stale) calendar date. Order: low-priority oldest, global, high newest.
		const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
		const ids = rememberBatch(
			beam,
			[
				{ content: "Local low priority", importance: 0.1, timestamp: minutesAgo(3) },
				{
					content: "Global rule always include",
					importance: 0.2,
					scope: "global",
					timestamp: minutesAgo(2),
				},
				{ content: "Local high priority", importance: 0.9, timestamp: minutesAgo(1) },
			],
			{ veracity: "imported" },
		);
		expect(rememberBatch).toBe(rememberBatch);

		expect(ids).toHaveLength(3);
		expect(getContext(beam, 3).map(row => row.content)).toEqual([
			"Global rule always include",
			"Local high priority",
			"Local low priority",
		]);
		expect(getWorkingStats(beam)).toMatchObject({ total: 3, count: 3 });
		expect(getGlobalWorkingStats(beam)).toMatchObject({ total: 3, count: 3 });
	});

	it("schedules background fact extraction for batch items that opt in with extract:true", () => {
		const beam = makeState();
		// Only the second item opts into extraction, so the per-item guard takes its
		// true arm for that id and its false arm for the first — both rows still store.
		const ids = rememberBatch(beam, [
			{ content: "Batch item without extraction" },
			{ content: "Batch item that wants fact extraction", extract: true },
		]);

		expect(ids).toHaveLength(2);
		expect(get(beam, ids[0] as string)?.content).toBe("Batch item without extraction");
		expect(get(beam, ids[1] as string)?.content).toBe("Batch item that wants fact extraction");
		// Without an LLM the scheduled extraction is a best-effort no-op, so both rows
		// remain the only working memories and the batch does not throw.
		expect(getWorkingStats(beam)).toMatchObject({ total: 2, count: 2 });
	});

	it("updates, invalidates, gets episodic fallback, forgets with authorized annotation cascade, and reports scoped stats", () => {
		const beam = makeState();
		const id = remember(beam, "Old wording", { importance: 0.2 });
		beam.db.prepare("INSERT INTO annotations (memory_id, kind, value) VALUES (?, 'mentions', 'Alice')").run(id);
		beam.db
			.prepare(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, metadata_json, veracity) VALUES (?, ?, 'sleep', ?, ?, 0.7, '{}', 'unknown')",
			)
			.run("episodic-1", "Episodic fallback", "2026-05-30T00:00:00.000Z", beam.sessionId);

		expect(updateWorking(beam, id, "New wording", 0.6)).toBe(true);
		expect(get(beam, id)?.content).toBe("New wording");
		expect(
			(
				beam.db.prepare("SELECT id FROM fts_working WHERE fts_working MATCH ?").all("New") as {
					id: string;
				}[]
			).map(row => row.id),
		).toEqual([id]);
		expect(get(beam, "episodic-1")?.memory_store).toBe("episodic");
		expect(getWorkingStats(beam, "author-a", "user", "channel-a")).toMatchObject({ total: 1 });
		expect(invalidate(beam, id, "replacement-1")).toBe(true);
		expect(getContext(beam, 10).some(row => row.id === id)).toBe(false);
		expect(forgetWorking(beam, id)).toBe(true);
		expect(get(beam, id)).toBeNull();
		expect(beam.db.prepare("SELECT COUNT(*) AS count FROM annotations WHERE memory_id = ?").get(id)).toEqual({
			count: 0,
		});
		expect(forgetWorking(beam, id)).toBe(false);
	});

	it("keeps scratchpad scoped to the active session", () => {
		const first = makeState("session-a");
		const second = makeState("session-b");
		const firstId = scratchpadWrite(first, "draft note");
		scratchpadWrite(second, "other session note");

		expect(firstId).toHaveLength(16);
		expect(scratchpadRead(first).map(row => row.content)).toEqual(["draft note"]);
		scratchpadClear(first);
		expect(scratchpadRead(first)).toEqual([]);
		expect(scratchpadRead(second).map(row => row.content)).toEqual(["other session note"]);
	});

	it("exports and imports working memory, episodic memory, scratchpad, and consolidation log idempotently", () => {
		const source = makeState("source-session");
		const id = remember(source, "Exported working memory", { veracity: "tool", importance: 0.75 });
		scratchpadWrite(source, "portable scratch");
		source.db
			.prepare(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, metadata_json, summary_of) VALUES ('episode-1', 'Exported episode', 'sleep', '2026-05-30T00:00:00.000Z', 'source-session', 0.6, '{}', ?)",
			)
			.run(id);
		source.db
			.prepare(
				"INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES ('source-session', 1, 'Exported', '2026-05-30T00:00:00.000Z')",
			)
			.run();

		const exported = exportToDict(source);
		expect(exported.working_memory as unknown[]).toHaveLength(1);
		expect(exported.scratchpad as unknown[]).toHaveLength(1);

		const dest = makeState("dest-session");
		expect(importFromDict(dest, exported)).toEqual({
			working_memory: { inserted: 1, skipped: 0, overwritten: 0 },
			episodic_memory: { inserted: 1, skipped: 0, overwritten: 0, embeddings_inserted: 0 },
			scratchpad: { inserted: 1, updated: 0 },
			consolidation_log: { inserted: 1 },
		});
		expect(importFromDict(dest, exported)).toMatchObject({
			working_memory: { inserted: 0, skipped: 1, overwritten: 0 },
			episodic_memory: { inserted: 0, skipped: 1, overwritten: 0 },
			scratchpad: { inserted: 0, updated: 1 },
			consolidation_log: { inserted: 1 },
		});
		expect(importFromDict(dest, exported, true)).toMatchObject({
			working_memory: { inserted: 0, skipped: 0, overwritten: 1 },
			episodic_memory: { inserted: 0, skipped: 0, overwritten: 1 },
		});
		expect(get(dest, id)?.content).toBe("Exported working memory");
		expect(dest.db.prepare("SELECT COUNT(*) AS count FROM scratchpad").get()).toEqual({ count: 1 });
		expect(scratchpadRead(dest).map(row => row.content)).toEqual([]);
	});
});

describe("fact-id read path (issue #4725)", () => {
	function insertFact(
		beam: BeamMemoryState,
		factId: string,
		sessionId: string,
		subject: string,
		predicate: string,
		object: string,
		confidence = 0.9,
	): void {
		beam.db
			.prepare(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(factId, sessionId, subject, predicate, object, "2026-05-30T00:00:00.000Z", confidence);
	}

	it("resolves an id surfaced by fact recall to a read-only fact row", async () => {
		const beam = makeState();
		insertFact(beam, "fact-postgres", beam.sessionId, "service", "uses", "postgres database", 0.91);

		const results = await recallEnhanced(beam, "postgres", 5, { includeFacts: true });
		const surfaced = results.find(result => result.source === "facts");
		expect(surfaced?.id).toBe("fact-postgres");

		// memory://<id> reads and memory_edit both resolve ids via get(); a
		// surfaced fact id must not be a dead end.
		const row = get(beam, "fact-postgres");
		expect(row).toMatchObject({
			id: "fact-postgres",
			content: "service uses postgres database",
			source: "facts",
			importance: 0.91,
			session_id: beam.sessionId,
			memory_store: "fact",
		});
		expect(JSON.parse(String(row?.metadata))).toMatchObject({
			subject: "service",
			predicate: "uses",
			object: "postgres database",
		});
	});

	it("keeps fact reads session-scoped like fact recall, honoring explicit global scope", () => {
		const beam = makeState();
		insertFact(beam, "fact-other", "session-other", "service", "uses", "postgres database");
		expect(get(beam, "fact-other")).toBeNull();

		beam.db.run("ALTER TABLE facts ADD COLUMN scope TEXT DEFAULT 'session'");
		beam.db.run("UPDATE facts SET scope = 'global' WHERE fact_id = 'fact-other'");
		expect(get(beam, "fact-other")?.memory_store).toBe("fact");
	});

	it("keeps working rows first on id collision and never deletes facts via forgetWorking", () => {
		const beam = makeState();
		insertFact(beam, "shared-id", beam.sessionId, "service", "uses", "postgres database");
		const workingId = remember(beam, "working row shadowing a fact id");
		beam.db.prepare("UPDATE working_memory SET id = ? WHERE id = ?").run("shared-id", workingId);

		expect(get(beam, "shared-id")?.memory_store).toBe("working");

		expect(forgetWorking(beam, "fact-missing")).toBe(false);
		expect(forgetWorking(beam, "shared-id")).toBe(true);
		expect(get(beam, "shared-id")?.memory_store).toBe("fact");
	});
});

describe("trust tier, temporal annotations, and episodic invalidation", () => {
	function trustTier(beam: BeamMemoryState, id: string): string {
		return (beam.db.prepare("SELECT trust_tier FROM working_memory WHERE id = ?").get(id) as { trust_tier: string })
			.trust_tier;
	}

	it("derives the trust tier from the source when none is supplied, honors a valid explicit tier, and falls back on an unknown one", () => {
		const beam = makeState();

		// Source drives the tier when the caller passes none: writer-facing sources
		// map to EXTERNAL_WRITE, ingestion sources to IMPORTED, everything else STATED.
		expect(trustTier(beam, remember(beam, "from a tool call", { source: "tool" }))).toBe("EXTERNAL_WRITE");
		expect(trustTier(beam, remember(beam, "from the api", { source: "api" }))).toBe("EXTERNAL_WRITE");
		expect(trustTier(beam, remember(beam, "from the system", { source: "system" }))).toBe("EXTERNAL_WRITE");
		expect(trustTier(beam, remember(beam, "restored from import", { source: "import" }))).toBe("IMPORTED");
		expect(trustTier(beam, remember(beam, "restored from imported set", { source: "imported" }))).toBe("IMPORTED");
		expect(trustTier(beam, remember(beam, "restored from backup", { source: "backup" }))).toBe("IMPORTED");
		expect(trustTier(beam, remember(beam, "a plain chat turn", { source: "conversation" }))).toBe("STATED");

		// An explicit, recognized tier overrides the source-derived default.
		expect(trustTier(beam, remember(beam, "explicit derived tier", { source: "tool", trustTier: "DERIVED" }))).toBe(
			"DERIVED",
		);

		// An explicit but unrecognized tier is rejected and clamped to STATED, not
		// stored verbatim.
		expect(trustTier(beam, remember(beam, "bogus explicit tier", { source: "tool", trustTier: "MADE_UP" }))).toBe(
			"STATED",
		);
	});

	it("writes occurred_on for every memory and has_source only for non-conversation sources through the wired store", () => {
		const recorded: RecordedAnnotation[] = [];
		const beam = makeState("session-a", [], {
			add(memoryId: string, kind: string, value: string): number {
				recorded.push({ memoryId, kind, value });
				return 1;
			},
		});

		const toolId = remember(beam, "Tool wrote this", {
			source: "tool",
			timestamp: "2026-03-04T09:15:00.000Z",
		});
		const chatId = remember(beam, "User said this", {
			source: "conversation",
			timestamp: "2026-03-05T09:15:00.000Z",
		});

		// occurred_on carries the date slice for both; has_source is added only for
		// the tool source, never the conversation one.
		expect(recorded).toEqual([
			{ memoryId: toolId, kind: "occurred_on", value: "2026-03-04" },
			{ memoryId: toolId, kind: "has_source", value: "tool" },
			{ memoryId: chatId, kind: "occurred_on", value: "2026-03-05" },
		]);
	});

	it("surfaces a failing annotation write loudly and still stores the memory", () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const beam = makeState("session-a", [], {
			add(): number {
				throw new Error("annotation-store-down");
			},
		});
		try {
			const id = remember(beam, "Durable despite annotation failure", { source: "tool" });

			// The write still lands: enrichment is best-effort and must not block it.
			expect(get(beam, id)?.content).toBe("Durable despite annotation failure");

			// The failure is surfaced, not swallowed: one warn carrying the memory id
			// and the original error message.
			expect(warn).toHaveBeenCalledTimes(1);
			const [message, context] = warn.mock.calls[0] as [string, Record<string, unknown>];
			expect(message).toContain("temporal annotation enrichment failed");
			expect(context).toMatchObject({ memoryId: id, error: "annotation-store-down" });
		} finally {
			warn.mockRestore();
		}
	});

	it("invalidates a memory that lives only in episodic storage", () => {
		const beam = makeState();
		beam.db
			.prepare(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, metadata_json, veracity) VALUES (?, ?, 'sleep', ?, ?, 0.6, '{}', 'unknown')",
			)
			.run("only-episodic", "Consolidated episode", "2026-05-30T00:00:00.000Z", beam.sessionId);

		// No working row shadows the id, so invalidate falls through to the episodic
		// UPDATE arm and reports the change.
		expect(invalidate(beam, "only-episodic", "replacement-9")).toBe(true);
		const row = beam.db
			.prepare("SELECT valid_until, superseded_by FROM episodic_memory WHERE id = ?")
			.get("only-episodic") as { valid_until: string | null; superseded_by: string | null };
		expect(row.superseded_by).toBe("replacement-9");
		expect(row.valid_until).not.toBeNull();

		// An id present nowhere returns false from both arms.
		expect(invalidate(beam, "ghost-id")).toBe(false);
	});

	it("stores the memory and warns when proactive graph linking throws", () => {
		const beam = makeState();
		// A real EpisodicGraph over a closed database: the instanceof check in
		// proactiveLinkIfEnabled passes, so ingestMemory runs and throws, exercising
		// the best-effort catch that must never block durable storage.
		const brokenDb = openDatabase(":memory:");
		const brokenGraph = new EpisodicGraph({ db: brokenDb });
		brokenDb.close();
		beam.episodicGraph = brokenGraph;

		const previous = process.env.MNEMOPI_PROACTIVE_LINKING;
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const id = remember(beam, "A memory that should survive a broken graph", { source: "conversation" });

			// The working row landed despite the graph failure.
			const row = get(beam, id);
			expect(row?.content).toBe("A memory that should survive a broken graph");

			// The failure is surfaced loudly, not swallowed (Law 10).
			const linkWarn = warn.mock.calls.find(call => String(call[0]).includes("proactive graph linking failed"));
			expect(linkWarn).toBeDefined();
			const linkMeta = linkWarn?.[1] as { memoryId: string } | undefined;
			expect(linkMeta?.memoryId).toBe(id);
		} finally {
			warn.mockRestore();
			if (previous === undefined) delete process.env.MNEMOPI_PROACTIVE_LINKING;
			else process.env.MNEMOPI_PROACTIVE_LINKING = previous;
		}
	});
});
