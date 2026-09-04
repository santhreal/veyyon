import { afterEach, describe, expect, it } from "bun:test";
import { type BeamMemoryState, initBeam, type RecallResult } from "@veyyon/mnemopi/core/beam";
import { orchestrateRecall } from "@veyyon/mnemopi/core/orchestrator";
import { PolyphonicRecallEngine } from "@veyyon/mnemopi/core/polyphonic-recall";
import { closeQuietly, openDatabase } from "@veyyon/mnemopi/db";

interface FakeBeam extends BeamMemoryState {
	linearCalls: number;
	enhancedCalls: number;
	recall: (query: string, topK?: number) => Promise<RecallResult[]>;
	recallEnhanced: (query: string, topK?: number) => Promise<RecallResult[]>;
}

function fakeBeam(): FakeBeam {
	const db = openDatabase(":memory:", { create: true, readwrite: true });
	initBeam(db);
	const beam: FakeBeam = {
		db,
		sessionId: "orchestrator-test",
		authorId: null,
		authorType: null,
		channelId: "orchestrator-test",
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
		linearCalls: 0,
		enhancedCalls: 0,
		async recall(query: string, topK = 20): Promise<RecallResult[]> {
			this.linearCalls += 1;
			return [{ id: "linear", content: `${query}:${topK}`, score: 1 }];
		},
		async recallEnhanced(query: string, topK = 20): Promise<RecallResult[]> {
			this.enhancedCalls += 1;
			return [{ id: "enhanced", content: `${query}:${topK}`, score: 2 }];
		},
	};
	return beam;
}

function insertWorking(beam: BeamMemoryState, id: string, content: string): void {
	const now = new Date().toISOString();
	beam.db.run(
		`INSERT INTO working_memory
			(id, content, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, created_at)
			VALUES (?, ?, 'test', ?, ?, 0.8, '{}', 'unknown', 'unknown', ?)`,
		[id, content, now, beam.sessionId, now],
	);
}

const previousPolyphonic = process.env.MNEMOPI_POLYPHONIC_RECALL;

afterEach(() => {
	if (previousPolyphonic === undefined) delete process.env.MNEMOPI_POLYPHONIC_RECALL;
	else process.env.MNEMOPI_POLYPHONIC_RECALL = previousPolyphonic;
});

describe("orchestrateRecall", () => {
	it("delegates to the Beam linear recall surface when the polyphonic gate is off", async () => {
		const beam = fakeBeam();
		try {
			process.env.MNEMOPI_POLYPHONIC_RECALL = "0";
			const results = await orchestrateRecall(beam, "needle", 7);
			expect(results).toEqual([{ id: "linear", content: "needle:7", score: 1 }]);
			expect(beam.linearCalls).toBe(1);
			expect(beam.enhancedCalls).toBe(0);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("returns an empty list when the Beam exposes no recall surface at all", async () => {
		const beam = fakeBeam();
		try {
			process.env.MNEMOPI_POLYPHONIC_RECALL = "0";
			// A Beam with neither recall nor recallEnhanced falls through to [] rather
			// than throwing — the orchestrator degrades to no hits, not a crash.
			(beam as { recall?: unknown }).recall = undefined;
			(beam as { recallEnhanced?: unknown }).recallEnhanced = undefined;
			const results = await orchestrateRecall(beam, "needle", 4);
			expect(results).toEqual([]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("delegates to enhanced recall when requested on the non-polyphonic path", async () => {
		const beam = fakeBeam();
		try {
			delete process.env.MNEMOPI_POLYPHONIC_RECALL;
			const results = await orchestrateRecall(beam, "needle", 3, { enhanced: true });
			expect(results).toEqual([{ id: "enhanced", content: "needle:3", score: 2 }]);
			expect(beam.linearCalls).toBe(0);
			expect(beam.enhancedCalls).toBe(1);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("uses polyphonic recall instead of fake Beam recall when the gate is on", async () => {
		const beam = fakeBeam();
		try {
			const engine = new PolyphonicRecallEngine({ db: beam.db });
			insertWorking(beam, "m-poly", "Alice orchestrator polyphonic memory");
			beam.db.run(
				`INSERT INTO gists (id, text, timestamp, participants_json, memory_id)
					VALUES ('gist_m-poly', 'Alice orchestrator gist', ?, ?, 'm-poly')`,
				[new Date().toISOString(), JSON.stringify(["Alice"])],
			);
			beam.caches.polyphonicEngine = engine;
			process.env.MNEMOPI_POLYPHONIC_RECALL = "1";
			const results = await orchestrateRecall(beam, "Alice", 5);
			expect(beam.linearCalls).toBe(0);
			expect(beam.enhancedCalls).toBe(0);
			expect(results[0]?.id).toBe("m-poly");
			expect(results[0]?.voice_scores).toEqual({ graph: 1 / 61 });
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("forceLinear bypasses the env gate for A/B callers", async () => {
		const beam = fakeBeam();
		try {
			process.env.MNEMOPI_POLYPHONIC_RECALL = "1";
			const results = await orchestrateRecall(beam, "needle", 2, { forceLinear: true });
			expect(results[0]?.id).toBe("linear");
			expect(beam.linearCalls).toBe(1);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("converts a Float32Array query embedding to a plain array on the linear path", async () => {
		const beam = fakeBeam();
		const original = beam.recall.bind(beam);
		let seen: unknown;
		beam.recall = ((query: string, topK?: number, options?: { queryEmbedding?: unknown }) => {
			seen = options?.queryEmbedding;
			return original(query, topK);
		}) as FakeBeam["recall"];
		try {
			const results = await orchestrateRecall(beam, "needle", 2, {
				forceLinear: true,
				queryEmbedding: new Float32Array([0.25, 0.5]),
			});
			expect(results[0]?.id).toBe("linear");
			// toLinearRecallOptions rebuilds the typed array as a JS array before it reaches recall.
			expect(Array.isArray(seen)).toBe(true);
			expect(seen).toEqual([0.25, 0.5]);
		} finally {
			closeQuietly(beam.db);
		}
	});
});
