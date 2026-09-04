import { afterEach, describe, expect, it } from "bun:test";
import { type BeamMemoryState, initBeam } from "@veyyon/mnemopi/core/beam";
import {
	PolyphonicRecallEngine,
	polyphonicRecall,
	polyphonicRecallIsEnabled,
} from "@veyyon/mnemopi/core/polyphonic-recall";
import { closeQuietly, openDatabase } from "@veyyon/mnemopi/db";

function makeBeam(): BeamMemoryState {
	const db = openDatabase(":memory:", { create: true, readwrite: true });
	initBeam(db);
	return {
		db,
		sessionId: "test-session",
		authorId: null,
		authorType: null,
		channelId: "test-session",
		useCloud: false,
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
function insertWorking(
	beam: BeamMemoryState,
	id: string,
	content: string,
	importance = 0.7,
	timestamp = new Date().toISOString(),
	sessionId = beam.sessionId,
	scope = "global",
): void {
	beam.db.run(
		`INSERT INTO working_memory
			(id, content, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, scope, created_at)
			VALUES (?, ?, 'test', ?, ?, ?, '{}', 'unknown', 'unknown', ?, ?)`,
		[id, content, timestamp, sessionId, importance, scope, timestamp],
	);
}
function seedPolyphonicFixture(beam: BeamMemoryState): PolyphonicRecallEngine {
	const engine = new PolyphonicRecallEngine({ db: beam.db, sessionId: beam.sessionId, channelId: beam.channelId });
	const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
	insertWorking(beam, "m1", "Alice owns the durable launch checklist", 0.8, old);
	insertWorking(beam, "m2", "Alice linked the graph traversal plan", 0.7, old);
	insertWorking(beam, "m3", "Recent operational note for this week", 0.6);
	beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
		"m1",
		JSON.stringify([0.8, 0.2]),
	]);
	beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
		"m2",
		JSON.stringify([1, 0]),
	]);
	beam.db.run(
		`INSERT INTO gists (id, text, timestamp, participants_json, memory_id)
			VALUES ('gist_m2', 'Alice graph gist', ?, ?, 'm2')`,
		[new Date().toISOString(), JSON.stringify(["Alice"])],
	);
	beam.db.run(
		`INSERT INTO consolidated_facts
			(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
			VALUES ('cf_alice_owns', 'Alice', 'owns', 'durable launch checklist', 0.9, 2, ?, ?, ?, 'likely_true')`,
		[new Date().toISOString(), new Date().toISOString(), JSON.stringify(["m1"])],
	);
	return engine;
}

const previousPolyphonic = process.env.MNEMOPI_POLYPHONIC_RECALL;

afterEach(() => {
	if (previousPolyphonic === undefined) delete process.env.MNEMOPI_POLYPHONIC_RECALL;
	else process.env.MNEMOPI_POLYPHONIC_RECALL = previousPolyphonic;
	delete process.env.MNEMOPI_VOICE_VECTOR;
	delete process.env.MNEMOPI_VOICE_GRAPH;
	delete process.env.MNEMOPI_VOICE_FACT;
	delete process.env.MNEMOPI_VOICE_TEMPORAL;
});

describe("PolyphonicRecallEngine", () => {
	it("reads the polyphonic recall gate per call", () => {
		delete process.env.MNEMOPI_POLYPHONIC_RECALL;
		expect(polyphonicRecallIsEnabled()).toBe(false);
		process.env.MNEMOPI_POLYPHONIC_RECALL = "0";
		expect(polyphonicRecallIsEnabled()).toBe(false);
		process.env.MNEMOPI_POLYPHONIC_RECALL = "1";
		expect(polyphonicRecallIsEnabled()).toBe(true);
	});

	it("fuses the four voices with RRF and preserves voice attribution order", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			const results = engine.recall("Alice recent", [1, 0], 10);
			expect(results.map(result => result.id)).toEqual(["m2", "m1", "m3"]);
			expect(results[0]?.voice_scores).toEqual({ vector: 1 / 61, graph: 1 / 61 });
			expect(results[1]?.voice_scores).toEqual({ vector: 1 / 62, fact: 1 / 61 });
			expect(results[2]?.voice_scores).toEqual({ temporal: 1 / 61 });
			expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
			expect(results[0]?.content).toContain("graph traversal");
		} finally {
			closeQuietly(beam.db);
		}
	});

	// Regression: the engine once carried a frozen `voiceWeights` field (vector
	// 0.35, graph 0.25, fact 0.25, temporal 0.15) surfaced via getStats as
	// `voice_weights`, implying weighted fusion. But combineVoices is pure RRF
	// and never applied those weights, so the reported weights misrepresented
	// scoring. These assertions lock the honest contract: getStats advertises no
	// voice weights, and a rank-1 hit contributes the same `1 / (RRF_K + 1)`
	// regardless of which voice found it. If a per-voice weight is ever
	// reintroduced without wiring it into the score, the equality below breaks.
	it("fuses voices with unweighted RRF and reports no voice weights", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);

			expect(Object.keys(engine.getStats()).sort()).toEqual(["consolidation_stats", "graph_stats", "vector_stats"]);

			const results = engine.recall("Alice recent", [1, 0], 10);
			// m2's vector voice and m3's temporal voice each rank first for their
			// voice, so both contribute exactly 1/61 despite different voice
			// identities. Weighted fusion would have made these 0.35/61 vs 0.15/61.
			expect(results.find(result => result.id === "m2")?.voice_scores.vector).toBe(1 / 61);
			expect(results.find(result => result.id === "m3")?.voice_scores.temporal).toBe(1 / 61);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("honors per-voice gates without producing fake-success results", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			process.env.MNEMOPI_VOICE_VECTOR = "0";
			process.env.MNEMOPI_VOICE_GRAPH = "0";
			process.env.MNEMOPI_VOICE_TEMPORAL = "0";
			const results = engine.recall("Alice recent", [1, 0], 10);
			expect(results.map(result => result.id)).toEqual(["m1"]);
			expect(results[0]?.voice_scores).toEqual({ fact: 1 / 61 });
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("filters vector and temporal voices to beam-session or global memories", () => {
		const beam = makeBeam();
		try {
			const timestamp = new Date().toISOString();
			insertWorking(
				beam,
				"wm-private-b",
				"Other session private vector marker",
				0.9,
				timestamp,
				"session-b",
				"session",
			);
			insertWorking(
				beam,
				"wm-global-b",
				"Other session global vector marker",
				0.8,
				timestamp,
				"session-b",
				"global",
			);
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				"wm-private-b",
				JSON.stringify([1, 0]),
			]);
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				"wm-global-b",
				JSON.stringify([1, 0]),
			]);
			process.env.MNEMOPI_VOICE_GRAPH = "0";
			process.env.MNEMOPI_VOICE_FACT = "0";
			process.env.MNEMOPI_VOICE_TEMPORAL = "0";

			const vectorResults = polyphonicRecall(beam, "vector marker", 5, { queryEmbedding: [1, 0] });

			expect(vectorResults.map(result => result.id)).toEqual(["wm-global-b"]);

			process.env.MNEMOPI_VOICE_VECTOR = "0";
			delete process.env.MNEMOPI_VOICE_TEMPORAL;

			const temporalResults = polyphonicRecall(beam, "recent vector marker", 5);

			expect(temporalResults.map(result => result.id)).toEqual(["wm-global-b"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("hydrates fact voice source memories through the session/global visibility filter", () => {
		const beam = makeBeam();
		try {
			const timestamp = new Date().toISOString();
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			insertWorking(
				beam,
				"wm-private-fact",
				"Alice private source from another session",
				0.9,
				timestamp,
				"session-b",
				"session",
			);
			insertWorking(
				beam,
				"wm-global-fact",
				"Alice global source from another session",
				0.8,
				timestamp,
				"session-b",
				"global",
			);
			beam.db.run(
				`INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES ('cf_alice_visibility', 'Alice', 'owns', 'visibility fixture', 0.9, 2, ?, ?, ?, 'likely_true')`,
				[timestamp, timestamp, JSON.stringify(["wm-private-fact", "wm-global-fact"])],
			);
			process.env.MNEMOPI_VOICE_VECTOR = "0";
			process.env.MNEMOPI_VOICE_GRAPH = "0";
			process.env.MNEMOPI_VOICE_TEMPORAL = "0";

			const results = engine.recall("Alice", null, 5);

			expect(results.map(result => result.id)).toEqual(["wm-global-fact"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("caches an engine on Beam state and hydrates result content", () => {
		const beam = makeBeam();
		try {
			seedPolyphonicFixture(beam).close();
			const first = polyphonicRecall(beam, "Alice", 5, { queryEmbedding: [1, 0] });
			const cached = beam.caches.polyphonicEngine;
			const second = polyphonicRecall(beam, "Alice", 5, { queryEmbedding: [1, 0] });
			expect(cached).toBeInstanceOf(PolyphonicRecallEngine);
			expect(beam.caches.polyphonicEngine).toBe(cached);
			expect(first[0]?.content).toBe(second[0]?.content);
			expect(first[0]?.voice_scores).toEqual(second[0]?.voice_scores);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("voices return empty on an uninitialized DB instead of masking errors", () => {
		// Law-10 gate contract: missing Beam tables are a checked, loud-by-design
		// empty result; anything else must propagate (no blanket catch).
		const db = openDatabase(":memory:", { create: true, readwrite: true });
		try {
			const engine = new PolyphonicRecallEngine({ db, sessionId: "s", channelId: "s" });
			expect(engine.vectorVoice([1, 0])).toEqual([]);
			// A temporal-looking query, so the voice reaches the table gate.
			expect(engine.temporalVoice("what happened yesterday")).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("voices propagate a broken DB handle instead of returning empty", () => {
		const db = openDatabase(":memory:", { create: true, readwrite: true });
		const engine = new PolyphonicRecallEngine({ db, sessionId: "s", channelId: "s" });
		db.close();
		// The old blanket catch rendered a closed handle as "no results".
		expect(() => engine.vectorVoice([1, 0])).toThrow();
		expect(() => engine.temporalVoice("what happened yesterday")).toThrow();
	});
});
