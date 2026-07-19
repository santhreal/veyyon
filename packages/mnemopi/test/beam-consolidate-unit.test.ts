import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { initBeam } from "@veyyon/mnemopi/core/beam";
import {
	consolidateToEpisodic,
	degradeEpisodic,
	extractAndStoreFacts,
	getConsolidationLog,
	getContaminated,
	getEpisodicStats,
	getMemoriaStats,
	health,
	memoriaRetrieve,
	sleep,
	sleepAllSessions,
	storeExtractedFactCategories,
	storeFactStrings,
} from "@veyyon/mnemopi/core/beam/consolidate";
import type { BeamMemoryState } from "@veyyon/mnemopi/core/beam/types";
import { REGEX_EXTRACTION_MAX_INPUT_CHARS } from "@veyyon/mnemopi/core/entities";
import { EpisodicGraph } from "@veyyon/mnemopi/core/episodic-graph";
import { closeQuietly, openDatabase } from "@veyyon/mnemopi/db";
import { logger } from "@veyyon/utils";

function state(sessionId = "s1"): BeamMemoryState {
	const db = openDatabase(":memory:", { create: true, readwrite: true });
	initBeam(db);
	return {
		db,
		dbPath: ":memory:",
		sessionId,
		authorId: "author-1",
		authorType: "user",
		channelId: sessionId,
		useCloud: false,
		eventEmitter: undefined,
		pluginManager: null,
		annotations: null,
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
}

function oldIso(hours = 20): string {
	return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function insertWorking(db: Database, id: string, sessionId: string, content: string, source = "conversation"): void {
	db.run(
		`INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, veracity, scope, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[id, content, source, oldIso(), sessionId, 0.7, "true", "session", oldIso()],
	);
}

function insertWorkingVeracity(db: Database, id: string, sessionId: string, veracity: string): void {
	db.run(
		`INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, veracity, scope, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[id, `note ${id}`, "conversation", oldIso(), sessionId, 0.7, veracity, "session", oldIso()],
	);
}

const opened: Database[] = [];

function trackedState(sessionId = "s1"): BeamMemoryState {
	const beam = state(sessionId);
	opened.push(beam.db);
	return beam;
}

afterEach(() => {
	while (opened.length > 0) {
		const db = opened.pop();
		if (db !== undefined) closeQuietly(db);
	}
});

describe("beam consolidation free functions", () => {
	it("consolidates working ids into a real episodic row with stats", () => {
		const beam = trackedState();
		insertWorking(beam.db, "wm1", "s1", "User likes dark mode");

		const id = consolidateToEpisodic(beam, "User likes dark mode", ["wm1"], "consolidation", 0.8, {
			metadata: { reason: "unit" },
			veracity: "true",
		});

		const row = beam.db.query("SELECT * FROM episodic_memory WHERE id = ?").get(id) as Record<string, unknown> | null;
		expect(row).not.toBeNull();
		expect(row?.content).toBe("User likes dark mode");
		expect(row?.summary_of).toBe("wm1");
		expect(row?.session_id).toBe("s1");
		expect(row?.veracity).toBe("true");
		expect(getEpisodicStats(beam).total).toBe(1);
	});

	it("consolidateToEpisodic populates the episodic graph (gists, edges) for the new memory (#2435)", () => {
		const beam = trackedState();
		insertWorking(beam.db, "wm1", "s1", "Alice deployed the staging cluster checklist");

		const id = consolidateToEpisodic(
			beam,
			"Alice deployed the staging cluster checklist",
			["wm1"],
			"consolidation",
			0.7,
		);

		const gist = beam.db.query("SELECT id, memory_id FROM gists WHERE memory_id = ?").get(id) as {
			id: string;
			memory_id: string;
		} | null;
		expect(gist).not.toBeNull();
		expect(gist?.id).toBe(`gist_${id}`);
		const edges = beam.db
			.query("SELECT source, target, edge_type FROM graph_edges WHERE source = ? OR target = ?")
			.all(id, id) as { source: string; target: string; edge_type: string }[];
		expect(edges.some(edge => edge.source === id && edge.target === `gist_${id}` && edge.edge_type === "ctx")).toBe(
			true,
		);
	});

	it("sleepAllSessions adds gists and edges for every consolidated session (#2435)", () => {
		const beam = trackedState("maintenance");
		insertWorking(beam.db, "wm-a1", "a", "Alpha launch checklist");
		insertWorking(beam.db, "wm-b1", "b", "Beta launch checklist");

		const result = sleepAllSessions(beam, false);
		expect(result.items_consolidated).toBe(2);
		const gistCount = (beam.db.query("SELECT COUNT(*) AS count FROM gists").get() as { count: number }).count;
		const edgeCount = (beam.db.query("SELECT COUNT(*) AS count FROM graph_edges").get() as { count: number }).count;
		expect(gistCount).toBe(2);
		expect(edgeCount).toBeGreaterThan(0);
	});

	it("sleep dry-run is side-effect-free and real sleep marks originals, writes summary and log", () => {
		const beam = trackedState();
		insertWorking(beam.db, "wm1", "s1", "task alpha", "conversation");
		insertWorking(beam.db, "wm2", "s1", "task beta", "conversation");

		const dry = sleep(beam, true);
		expect(dry.status).toBe("dry_run");
		expect(dry.items_consolidated).toBe(2);
		expect(beam.db.query("SELECT COUNT(*) AS count FROM episodic_memory").get()).toEqual({
			count: 0,
		});
		expect(
			beam.db.query("SELECT COUNT(*) AS count FROM working_memory WHERE consolidated_at IS NOT NULL").get(),
		).toEqual({ count: 0 });

		const real = sleep(beam, false);
		expect(real.status).toBe("consolidated");
		expect(real.items_consolidated).toBe(2);
		expect(beam.db.query("SELECT COUNT(*) AS count FROM working_memory").get()).toEqual({
			count: 2,
		});
		expect(
			beam.db.query("SELECT COUNT(*) AS count FROM working_memory WHERE consolidated_at IS NOT NULL").get(),
		).toEqual({ count: 2 });
		expect(beam.db.query("SELECT COUNT(*) AS count FROM episodic_memory").get()).toEqual({
			count: 1,
		});
		expect(getConsolidationLog(beam, 1)[0]?.items_consolidated).toBe(2);
	});
	it("sleep caps oversized episodes before extraction and embedding", () => {
		const beam = trackedState();
		beam.config.maxEpisodeChars = 512;
		const transcript = "[role: user] progress output with noisy tool transcript ".repeat(40);
		insertWorking(beam.db, "wm-big", "s1", transcript, "conversation");

		const result = sleep(beam, false);
		const row = beam.db
			.query(
				`SELECT content, length(content) AS chars, json_extract(metadata_json, '$.truncated') AS truncated,
				 json_extract(metadata_json, '$.original_chars') AS original_chars,
				 json_extract(metadata_json, '$.max_chars') AS max_chars
				 FROM episodic_memory WHERE source = 'sleep_consolidation'`,
			)
			.get() as {
			content: string;
			chars: number;
			truncated: number;
			original_chars: number;
			max_chars: number;
		} | null;

		expect(result.status).toBe("consolidated");
		expect(row).not.toBeNull();
		expect(row?.chars).toBeLessThanOrEqual(512);
		expect(row?.content.includes("sleep_consolidation episode truncated")).toBe(true);
		expect(row?.truncated).toBe(1);
		expect(row?.original_chars).toBeGreaterThan(512);
		expect(row?.max_chars).toBe(512);
	});

	it("sleep consolidates embedText projections instead of raw working content", () => {
		const beam = trackedState();
		const raw =
			"[role: user]\nI always prefer tabs\n[user:end]\n\n[role: assistant]\nthe parser never initializes\n[assistant:end]";
		const clean = "I always prefer tabs\n\nthe parser never initializes";
		beam.db.run(
			`INSERT INTO working_memory
			 (id, content, embed_text, source, timestamp, session_id, importance, veracity, scope, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			["wm-projected", raw, clean, "coding-agent-transcript", oldIso(), "s1", 0.7, "unknown", "session", oldIso()],
		);

		const result = sleep(beam, false);
		const row = beam.db.query("SELECT content FROM episodic_memory WHERE source = 'sleep_consolidation'").get() as {
			content: string;
		} | null;

		expect(result.status).toBe("consolidated");
		expect(row?.content).toContain("I always prefer tabs");
		expect(row?.content).toContain("the parser never initializes");
		expect(row?.content).not.toContain("[role:");
		expect(row?.content).not.toContain(":end]");
		expect(beam.db.query("SELECT rowid FROM fts_episodes WHERE fts_episodes MATCH ?").all("tabs")).toHaveLength(1);
		expect(beam.db.query("SELECT rowid FROM fts_episodes WHERE fts_episodes MATCH ?").all("role")).toEqual([]);
	});
	it("sleep splits capped source groups without dropping row ids", () => {
		const beam = trackedState();
		beam.config.maxEpisodeChars = 100;
		insertWorking(beam.db, "wm-one", "s1", `first ${"a".repeat(70)}`, "conversation");
		insertWorking(beam.db, "wm-two", "s1", `second ${"b".repeat(70)}`, "conversation");
		insertWorking(beam.db, "wm-three", "s1", `third ${"c".repeat(70)}`, "conversation");

		const result = sleep(beam, false);
		const rows = beam.db
			.query("SELECT summary_of, length(content) AS chars FROM episodic_memory WHERE source = 'sleep_consolidation'")
			.all() as { summary_of: string; chars: number }[];

		expect(result.status).toBe("consolidated");
		expect(result.items_consolidated).toBe(3);
		expect(result.summaries_created).toBe(3);
		expect(rows).toHaveLength(3);
		expect(rows.every(row => row.chars <= 100)).toBe(true);
		expect(rows.map(row => row.summary_of).sort()).toEqual(["wm-one", "wm-three", "wm-two"]);
	});

	it("sleepAllSessions consolidates eligible rows outside the caller session", () => {
		const beam = trackedState("maintenance");
		insertWorking(beam.db, "wm-a", "a", "alpha session task");
		insertWorking(beam.db, "wm-b", "b", "beta session task");

		const result = sleepAllSessions(beam, false);
		expect(result.status).toBe("consolidated");
		expect(result.sessions_scanned).toBe(2);
		expect(result.items_consolidated).toBe(2);
		expect(beam.db.query("SELECT COUNT(*) AS count FROM episodic_memory").get()).toEqual({
			count: 2,
		});
	});

	it("degradation marks old tier transitions without deleting memories", () => {
		const beam = trackedState();
		const id1 = consolidateToEpisodic(beam, "A detailed tier one memory", ["wm1"]);
		const id2 = consolidateToEpisodic(
			beam,
			"B detailed tier two memory with Project Phoenix deadline and important release facts.".repeat(12),
			["wm2"],
		);
		beam.db.run("UPDATE episodic_memory SET tier = 1, created_at = ? WHERE id = ?", [oldIso(31 * 24), id1]);
		beam.db.run("UPDATE episodic_memory SET tier = 2, created_at = ? WHERE id = ?", [oldIso(181 * 24), id2]);

		const dry = degradeEpisodic(beam, true);
		expect(dry.tier1_to_tier2).toBe(1);
		expect(dry.tier2_to_tier3).toBe(1);
		expect((beam.db.query("SELECT tier FROM episodic_memory WHERE id = ?").get(id1) as { tier: number }).tier).toBe(
			1,
		);

		const real = degradeEpisodic(beam, false);
		expect(real.status).toBe("degraded");
		expect((beam.db.query("SELECT tier FROM episodic_memory WHERE id = ?").get(id1) as { tier: number }).tier).toBe(
			2,
		);
		expect((beam.db.query("SELECT tier FROM episodic_memory WHERE id = ?").get(id2) as { tier: number }).tier).toBe(
			3,
		);
		expect(beam.db.query("SELECT COUNT(*) AS count FROM episodic_memory").get()).toEqual({
			count: 2,
		});
	});

	it("returns contaminated episodic memories by veracity and importance", () => {
		const beam = trackedState();
		consolidateToEpisodic(beam, "High stakes inferred memory", ["wm1"], "test", 0.9, {
			veracity: "inferred",
		});
		consolidateToEpisodic(beam, "High stakes unknown memory", ["wm2"], "test", 0.8, {
			veracity: "unknown",
		});
		consolidateToEpisodic(beam, "High stakes false memory", ["wm3"], "test", 0.85, {
			veracity: "false",
		});
		consolidateToEpisodic(beam, "Low stakes unknown memory", ["wm4"], "test", 0.1, {
			veracity: "unknown",
		});
		consolidateToEpisodic(beam, "Clean true memory", ["wm5"], "test", 0.95, { veracity: "true" });

		const rows = getContaminated(beam, 10, 0.5);
		expect(rows.map(row => row.content)).toEqual([
			"High stakes inferred memory",
			"High stakes false memory",
			"High stakes unknown memory",
		]);
	});

	it("extracts/stores MEMORIA facts and retrieves them with stats", () => {
		const beam = trackedState();
		const counts = extractAndStoreFacts(
			beam,
			"My name is Ada. I prefer Rust. Dashboard API latency is 250ms. Release is v1.2.3 on 2026-05-30. ProjectX uses SQLite.",
			7,
			"wm-facts",
		);

		expect(counts.metric).toBeGreaterThanOrEqual(1);
		expect(counts.version).toBeGreaterThanOrEqual(1);
		expect(counts.date).toBeGreaterThanOrEqual(1);
		expect(counts.entity).toBeGreaterThanOrEqual(1);
		const stats = getMemoriaStats(beam);
		expect(stats.memoria_facts).toBeGreaterThanOrEqual(4);
		expect(stats.memoria_preferences).toBeGreaterThanOrEqual(1);
		expect(stats.memoria_kg).toBeGreaterThanOrEqual(1);

		const metrics = memoriaRetrieve(beam, "what was dashboard api latency", "IE", 5);
		expect(metrics.results.some(row => String((row as Record<string, unknown>).value).includes("250ms"))).toBe(true);
		const facts = beam.db.query("SELECT COUNT(*) AS count FROM facts WHERE source_msg_id = ?").get("wm-facts") as {
			count: number;
		};
		expect(facts.count).toBeGreaterThanOrEqual(4);
	});

	it("skips pattern fact extraction for oversized raw transcripts", () => {
		const beam = trackedState();
		const line = "progress boot done 615014ms downloading gapps its@66% priv-app files done 221MB version 1.2.3\n";
		const text = line.repeat(Math.ceil((REGEX_EXTRACTION_MAX_INPUT_CHARS + 1) / line.length));
		const counts = extractAndStoreFacts(beam, text, 7, "large-transcript");

		expect(counts).toEqual({
			metric: 0,
			date: 0,
			version: 0,
			entity: 0,
			sequence: 0,
			timeline: 0,
			negation: 0,
			decision: 0,
		});
		const facts = beam.db.query("SELECT COUNT(*) AS count FROM memoria_facts").get() as { count: number };
		expect(facts.count).toBe(0);
	});

	it("stores every extracted category into its MEMORIA table and the knowledge graph", () => {
		const beam = trackedState();
		const stored = storeExtractedFactCategories(
			beam,
			{
				facts: ["The user prefers dark mode", "Ada owns the API"],
				instructions: ["always run tests before pushing"],
				preferences: ["dark roast coffee"],
				timelines: ["Release ships on 2026-05-30", "Kickoff happened last spring"],
				kg: [{ subject: "Ada", predicate: "owns", object: "the API" }],
			},
			3,
			"wm-src",
			0.8,
		);

		// facts(2) + instructions(1) + preferences(1) + timelines(2); kg is not part of `stored`.
		expect(stored).toBe(6);

		// Every category string also lands as an "entity" fact row.
		const factRows = beam.db
			.query("SELECT fact_type, key, value, importance FROM memoria_facts WHERE source_memory_id = ? ORDER BY id")
			.all("wm-src") as { fact_type: string; key: string; value: string; importance: number }[];
		expect(factRows).toHaveLength(6);
		expect(factRows.every(row => row.fact_type === "entity" && row.key === "fact")).toBe(true);
		expect(factRows.every(row => row.importance === 0.8)).toBe(true);

		// The fact "The user prefers dark mode" routes a preference (topic captured); the
		// explicit preferences array adds a topic-less row.
		const prefs = beam.db
			.query("SELECT preference, topic FROM memoria_preferences WHERE source_memory_id = ? ORDER BY id")
			.all("wm-src") as { preference: string; topic: string | null }[];
		expect(prefs).toEqual([
			{ preference: "The user prefers dark mode", topic: "dark mode" },
			{ preference: "dark roast coffee", topic: null },
		]);

		const instructions = beam.db
			.query("SELECT instruction, active, context_snippet FROM memoria_instructions WHERE source_memory_id = ?")
			.all("wm-src") as { instruction: string; active: number; context_snippet: string }[];
		expect(instructions).toEqual([
			{
				instruction: "always run tests before pushing",
				active: 1,
				context_snippet: "always run tests before pushing",
			},
		]);

		// timelineDate lifts an ISO date out of the description, else stores null.
		const timelines = beam.db
			.query(
				"SELECT date, description, source FROM memoria_timelines WHERE source_memory_id = ? ORDER BY message_idx, description",
			)
			.all("wm-src") as { date: string | null; description: string; source: string }[];
		expect(timelines).toEqual([
			{ date: null, description: "Kickoff happened last spring", source: "extraction" },
			{ date: "2026-05-30", description: "Release ships on 2026-05-30", source: "extraction" },
		]);

		const kg = beam.db
			.query("SELECT subject, predicate, object, confidence FROM memoria_kg WHERE source_memory_id = ?")
			.all("wm-src") as { subject: string; predicate: string; object: string; confidence: number }[];
		expect(kg).toEqual([{ subject: "Ada", predicate: "owns", object: "the API", confidence: 0.65 }]);
		const triples = beam.db.query("SELECT subject, predicate, object, source, confidence FROM triples").all() as {
			subject: string;
			predicate: string;
			object: string;
			source: string;
			confidence: number;
		}[];
		expect(triples).toEqual([
			{ subject: "Ada", predicate: "owns", object: "the API", source: "wm-src", confidence: 0.65 },
		]);
	});

	it("routes preference and instruction heuristics only when enabled", () => {
		const beam = trackedState();
		const stored = storeFactStrings(
			beam,
			["The user dislikes loud offices", "Instruction: keep replies terse", "plain fact"],
			0,
			"wm-h",
			0.6,
		);
		expect(stored).toBe(3);
		expect(
			beam.db.query("SELECT preference, topic FROM memoria_preferences WHERE source_memory_id = ?").all("wm-h"),
		).toEqual([{ preference: "The user dislikes loud offices", topic: "loud offices" }]);
		expect(
			beam.db.query("SELECT instruction FROM memoria_instructions WHERE source_memory_id = ?").all("wm-h"),
		).toEqual([{ instruction: "keep replies terse" }]);

		// With routing off, the same shapes stay plain facts.
		storeFactStrings(beam, ["The user prefers X", "Instruction: Y"], 0, "wm-off", 0.6, {
			routeHeuristicCategories: false,
		});
		expect(
			beam.db.query("SELECT COUNT(*) AS count FROM memoria_preferences WHERE source_memory_id = ?").get("wm-off"),
		).toEqual({ count: 0 });
		expect(
			beam.db.query("SELECT COUNT(*) AS count FROM memoria_instructions WHERE source_memory_id = ?").get("wm-off"),
		).toEqual({ count: 0 });
		expect(
			beam.db.query("SELECT COUNT(*) AS count FROM memoria_facts WHERE source_memory_id = ?").get("wm-off"),
		).toEqual({ count: 2 });
	});

	it("aggregates episodic veracity by majority, lowest-weight tie-break, and unknown floor", () => {
		const majority = trackedState("maj");
		insertWorkingVeracity(majority.db, "m1", "maj", "true");
		insertWorkingVeracity(majority.db, "m2", "maj", "true");
		insertWorkingVeracity(majority.db, "m3", "maj", "false");
		sleep(majority, false);
		expect((majority.db.query("SELECT veracity FROM episodic_memory").get() as { veracity: string }).veracity).toBe(
			"true",
		);

		// Tie between "inferred" (0.7) and "false" (0.0): the lower weight wins.
		const tie = trackedState("tie");
		insertWorkingVeracity(tie.db, "t1", "tie", "inferred");
		insertWorkingVeracity(tie.db, "t2", "tie", "false");
		sleep(tie, false);
		expect((tie.db.query("SELECT veracity FROM episodic_memory").get() as { veracity: string }).veracity).toBe(
			"false",
		);

		// All-unknown sources fall through to the "unknown" floor.
		const floor = trackedState("floor");
		insertWorkingVeracity(floor.db, "f1", "floor", "unknown");
		insertWorkingVeracity(floor.db, "f2", "floor", "unknown");
		sleep(floor, false);
		expect((floor.db.query("SELECT veracity FROM episodic_memory").get() as { veracity: string }).veracity).toBe(
			"unknown",
		);
	});

	it("classifies retrieval ability and routes to the matching MEMORIA table", () => {
		const beam = trackedState();
		storeExtractedFactCategories(
			beam,
			{
				facts: ["Phoenix uses SQLite"],
				instructions: [],
				preferences: [],
				timelines: ["Phoenix launch on 2026-05-30"],
				kg: [{ subject: "Phoenix", predicate: "uses", object: "SQLite" }],
			},
			0,
			"seed",
			0.7,
		);

		// Timeline reasoning (TR) and event ordering (EO) both route to the timeline table.
		const tr = memoriaRetrieve(beam, "how long until phoenix");
		expect(tr.ability).toBe("TR");
		expect((tr.results[0] as { description?: string }).description).toBe("Phoenix launch on 2026-05-30");
		const eo = memoriaRetrieve(beam, "walk me through phoenix");
		expect(eo.ability).toBe("TR");
		expect((eo.results[0] as { description?: string }).description).toBe("Phoenix launch on 2026-05-30");

		// Multi-session recall (MR) routes to the knowledge graph.
		const mr = memoriaRetrieve(beam, "across all my sessions about phoenix");
		expect(mr.ability).toBe("MR");
		expect((mr.results[0] as { subject?: string }).subject).toBe("Phoenix");

		// Contradiction (CR), regex-headed questions, and keyword questions route to facts.
		const cr = memoriaRetrieve(beam, "have i noted phoenix");
		expect(cr.ability).toBe("IE");
		expect(cr.results.map(row => (row as { value?: string }).value)).toContain("Phoenix uses SQLite");
		expect(memoriaRetrieve(beam, "who owns phoenix").ability).toBe("IE");

		// A plain statement classifies as nothing and returns no results.
		const none = memoriaRetrieve(beam, "phoenix is here");
		expect(none.ability).toBe("");
		expect(none.results).toEqual([]);
	});

	it("scopes getEpisodicStats by author id, author type, and channel id", () => {
		const beam = trackedState();
		for (const [wm, content] of [
			["wm1", "Ada shipped the release"],
			["wm2", "Bob paged the on-call"],
			["wm3", "Ada wrote the runbook"],
		] as const) {
			insertWorking(beam.db, wm, "s1", content);
		}
		const id1 = consolidateToEpisodic(beam, "Ada shipped the release", ["wm1"], "consolidation", 0.7);
		const id2 = consolidateToEpisodic(beam, "Bob paged the on-call", ["wm2"], "consolidation", 0.7);
		const id3 = consolidateToEpisodic(beam, "Ada wrote the runbook", ["wm3"], "consolidation", 0.7);
		beam.db.run("UPDATE episodic_memory SET author_id = ?, author_type = ?, channel_id = ? WHERE id = ?", [
			"ada",
			"human",
			"ch1",
			id1,
		]);
		beam.db.run("UPDATE episodic_memory SET author_id = ?, author_type = ?, channel_id = ? WHERE id = ?", [
			"bob",
			"bot",
			"ch2",
			id2,
		]);
		beam.db.run("UPDATE episodic_memory SET author_id = ?, author_type = ?, channel_id = ? WHERE id = ?", [
			"ada",
			"bot",
			"ch1",
			id3,
		]);

		// No filter sees every row.
		expect(getEpisodicStats(beam).total).toBe(3);
		// Each single clause narrows to its matching rows.
		expect(getEpisodicStats(beam, "ada", null, null).total).toBe(2);
		expect(getEpisodicStats(beam, null, "bot", null).total).toBe(2);
		expect(getEpisodicStats(beam, null, null, "ch1").total).toBe(2);
		// All three clauses AND together to a single row.
		const scoped = getEpisodicStats(beam, "ada", "bot", "ch1");
		expect(scoped.total).toBe(1);
		expect(scoped.count).toBe(1);
		expect(scoped.vectors).toBe(0);
		expect(scoped.vec_type).toBe("none");
		expect(typeof scoped.last).toBe("string");
	});

	it("reports a healthy consolidation window with a zero error count", () => {
		const beam = trackedState();
		// One recent successful consolidation, one recent failure marker within the 7-day window.
		beam.db.run(
			"INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES (?, ?, ?, ?)",
			["s1", 5, "consolidated 5 memories", new Date().toISOString()],
		);
		beam.db.run(
			"INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES (?, ?, ?, ?)",
			["s1", 0, "sleep failed to reach the model", new Date().toISOString()],
		);

		const report = health(beam, 24);
		expect(report.status).toBe("healthy");
		expect(report.error_count).toBe(1);
		expect(report.stale_threshold_hours).toBe(24);
		expect(report.recommendation).toBe("Consolidation is within the healthy window.");
		expect(report.details).toEqual({ stale: false, consolidation_log_entries_checked: "last 7 days" });
		expect(typeof report.stale_hours).toBe("number");
		expect(report.stale_hours as number).toBeLessThanOrEqual(1);
	});

	it("reports a stale consolidation window past the threshold", () => {
		const beam = trackedState();
		beam.db.run(
			"INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES (?, ?, ?, ?)",
			["s1", 3, "consolidated 3 memories", oldIso(30)],
		);

		const report = health(beam, 24);
		expect(report.status).toBe("stale");
		expect(report.error_count).toBe(0);
		expect(report.stale_hours as number).toBeGreaterThan(24);
		expect(report.details).toEqual({ stale: true, consolidation_log_entries_checked: "last 7 days" });
		expect(report.recommendation as string).toContain("Run sleepAllSessions()");
	});
});

describe("episodic veracity aggregation and graph-enrichment failure", () => {
	it("settles an all-unrecognized veracity group to unknown when consolidating", () => {
		const beam = trackedState();
		// One source so the rows land in a single sleep chunk. Every veracity is
		// either the literal "unknown" or a string clampVeracity does not recognize
		// (which clamps to unknown), so aggregateEpisodicVeracity finds no non-unknown
		// winner and returns unknown through its fallthrough.
		insertWorkingVeracity(beam.db, "wv1", "s1", "asserted");
		insertWorkingVeracity(beam.db, "wv2", "s1", "verified");
		insertWorkingVeracity(beam.db, "wv3", "s1", "unknown");

		const result = sleep(beam, false);
		expect(result.status).toBe("consolidated");
		expect(result.items_consolidated).toBe(3);

		const rows = beam.db.query("SELECT veracity FROM episodic_memory").all() as { veracity: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].veracity).toBe("unknown");
	});

	it("picks the most frequent recognized veracity as the consolidated winner", () => {
		const beam = trackedState();
		insertWorkingVeracity(beam.db, "wa1", "s1", "stated");
		insertWorkingVeracity(beam.db, "wa2", "s1", "stated");
		insertWorkingVeracity(beam.db, "wa3", "s1", "inferred");

		expect(sleep(beam, false).items_consolidated).toBe(3);
		const rows = beam.db.query("SELECT veracity FROM episodic_memory").all() as { veracity: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].veracity).toBe("stated");
	});

	it("stores the episodic memory and surfaces a warning when graph enrichment fails", () => {
		const beam = trackedState();
		// A real EpisodicGraph over a closed database: instanceof passes so
		// consolidateToEpisodic reuses it, and ingestMemory then throws, exercising
		// the best-effort catch that must never roll back the episodic write.
		const brokenDb = openDatabase(":memory:");
		const brokenGraph = new EpisodicGraph({ db: brokenDb });
		brokenDb.close();
		beam.episodicGraph = brokenGraph;

		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const memoryId = consolidateToEpisodic(beam, "A settled summary of the day", ["src1", "src2"], "sleep", 0.6, {
				veracity: "stated",
			});

			// The episodic row landed despite the graph failure.
			const row = beam.db.query("SELECT content, veracity FROM episodic_memory WHERE id = ?").get(memoryId) as {
				content: string;
				veracity: string;
			};
			expect(row.content).toBe("A settled summary of the day");
			expect(row.veracity).toBe("stated");

			// The failure is surfaced, not swallowed.
			const enrichmentWarn = warn.mock.calls.find(call =>
				String(call[0]).includes("episodic-graph enrichment failed"),
			);
			expect(enrichmentWarn).toBeDefined();
			expect(enrichmentWarn?.[1] as Record<string, unknown>).toMatchObject({ memoryId });
		} finally {
			warn.mockRestore();
			closeQuietly(brokenDb);
		}
	});
});
