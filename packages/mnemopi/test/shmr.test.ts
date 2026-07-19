import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { initBeam } from "@veyyon/mnemopi/core/beam";
import * as embeddings from "@veyyon/mnemopi/core/embeddings";
import {
	applyBeliefs,
	clusterBySimilarity,
	cosineSimilarity,
	embed,
	embedBatch,
	extractJsonFromLlmOutput,
	formatClusterForLlm,
	getResonanceLog,
	harmonize,
	recallBeliefs,
	reflect,
} from "@veyyon/mnemopi/core/shmr";
import { logger } from "@veyyon/utils";

let embedSpy: Mock<typeof embeddings.embed> | null = null;

afterEach(() => {
	embedSpy?.mockRestore();
	embedSpy = null;
});

/** Routes the embeddings module's batch API through a fake per-text vector table. */
function stubProvider(vectorFor: (text: string) => Float32Array): void {
	embedSpy = spyOn(embeddings, "embed").mockImplementation(async (texts: readonly string[]) => texts.map(vectorFor));
}

function stubNoProvider(): void {
	embedSpy = spyOn(embeddings, "embed").mockResolvedValue(null);
}

describe("SHMR embedding integration", () => {
	it("clusters with provider vectors when an embedding provider is configured", async () => {
		// Zero word overlap between the first two texts: the hash fallback could
		// never cluster them, so a [2, 1] split proves provider vectors were used.
		const table: Record<string, Float32Array> = {
			"alpha beta": new Float32Array([1, 0, 0]),
			"gamma delta": new Float32Array([1, 0, 0]),
			"omega psi": new Float32Array([0, 1, 0]),
		};
		stubProvider(text => table[text] ?? new Float32Array([0, 0, 1]));
		const clusters = await clusterBySimilarity(
			[{ object: "alpha beta" }, { object: "gamma delta" }, { object: "omega psi" }],
			0.9,
		);
		expect(clusters.map(cluster => cluster.length).sort()).toEqual([1, 2]);
		// One batch call for all missing vectors, not one call per item.
		expect(embedSpy?.mock.calls.length).toBe(1);
		expect(embedSpy?.mock.calls[0]?.[0]).toEqual(["alpha beta", "gamma delta", "omega psi"]);
	});

	it("falls back to deterministic hash vectors when no provider is available", async () => {
		stubNoProvider();
		const a = await embed("dark mode preference");
		const b = await embed("dark mode preference");
		const c = await embed("unrelated database migration");
		expect(Array.from(a)).toEqual(Array.from(b));
		expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
		const clusters = await clusterBySimilarity(
			[
				{ object: "dark mode preference", embedding: a },
				{ object: "dark mode preference", embedding: b },
				{ object: "unrelated database migration", embedding: c },
			],
			0.9,
		);
		expect(clusters.map(cluster => cluster.length).sort()).toEqual([1, 2]);
	});

	it("degrades to hash embeddings and warns when the provider throws mid-batch", async () => {
		embedSpy = spyOn(embeddings, "embed").mockRejectedValue(new Error("provider offline"));
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const vectors = await embedBatch(["dark mode preference", "dark mode preference"]);

			// One vector per input, and identical text hashes to an identical vector,
			// so the whole batch shares the deterministic hash space.
			expect(vectors).toHaveLength(2);
			expect(Array.from(vectors[0] as Float32Array)).toEqual(Array.from(vectors[1] as Float32Array));

			// The degrade is surfaced loudly, not swallowed (Law 10).
			const degraded = warn.mock.calls.find(call => String(call[0]).includes("degraded to hash embeddings"));
			expect(degraded).toBeDefined();
			expect((degraded?.[1] as Record<string, unknown>).error).toContain("provider offline");
		} finally {
			warn.mockRestore();
		}
	});

	it("reuses precomputed vectors from memory_embeddings during harmonize", async () => {
		// No provider and zero word overlap between contents: only the precomputed
		// vectors stored in memory_embeddings can make these two items cluster.
		stubNoProvider();
		const db = new Database(":memory:");
		try {
			initBeam(db);
			db.run("INSERT INTO episodic_memory (id, content, importance) VALUES (?, ?, ?)", [
				"m1",
				"alpha beta quartz one",
				0.8,
			]);
			db.run("INSERT INTO episodic_memory (id, content, importance) VALUES (?, ?, ?)", [
				"m2",
				"gamma delta umbra two",
				0.8,
			]);
			db.run("INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?, ?)", ["m1", "[1, 0, 0]"]);
			db.run("INSERT INTO memory_embeddings (memory_id, embedding_json) VALUES (?, ?)", ["m2", "[1, 0, 0]"]);
			const stats = await harmonize({ db, session_id: "s" }, 10, 1, 0.9);
			expect(stats.status).toBe("harmonized");
			expect(stats.clusters_found).toBe(1);
		} finally {
			db.close();
		}
	});
});

describe("SHMR deterministic helpers", () => {
	it("harmonizes corroborated facts without an LLM", async () => {
		stubNoProvider();
		const db = new Database(":memory:");
		try {
			initBeam(db);
			db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, confidence, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["f1", "s", "user", "prefers", "dark mode", 0.8, "2026-01-01T00:00:00"],
			);
			db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, confidence, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["f2", "s", "user", "prefers", "dark mode", 0.9, "2026-01-02T00:00:00"],
			);
			const stats = await harmonize({ db, session_id: "s" }, 10, 1, 0.8);
			expect(stats.status).toBe("harmonized");
			expect(stats.clusters_found).toBe(1);
			expect(stats.beliefs_generated).toBeGreaterThanOrEqual(1);
			const beliefs = await recallBeliefs({ db }, "dark mode", 5);
			expect(beliefs.some(belief => belief.content === "dark mode" && belief.source === "harmonic_belief")).toBe(
				true,
			);
			expect(getResonanceLog({ db }, 1)[0]?.beliefs_generated).toBeGreaterThanOrEqual(1);
		} finally {
			db.close();
		}
	});

	it("applies an update belief by rewriting the target fact object and confidence", () => {
		const db = new Database(":memory:");
		try {
			initBeam(db);
			db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, confidence, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["f1", "s", "user", "prefers", "light mode", 0.5, "2026-01-01T00:00:00"],
			);

			applyBeliefs(
				db,
				[
					{
						subject: "user",
						predicate: "prefers",
						object: "dark mode",
						confidence: 0.9,
						action: "update",
						target_fact_id: "f1",
					},
				],
				[{ fact_id: "f1", object: "light mode" }],
				"cluster-1",
			);

			const fact = db.query("SELECT object, confidence FROM facts WHERE fact_id = ?").get("f1") as {
				object: string;
				confidence: number;
			};
			expect(fact.object).toBe("dark mode");
			expect(fact.confidence).toBeCloseTo(0.9, 10);

			// The belief itself is also persisted with the cluster's fact provenance.
			const belief = db
				.query("SELECT object, confidence, provenance, cluster_id FROM harmonic_beliefs WHERE cluster_id = ?")
				.get("cluster-1") as { object: string; confidence: number; provenance: string; cluster_id: string };
			expect(belief.object).toBe("dark mode");
			expect(belief.confidence).toBeCloseTo(0.9, 10);
			expect(JSON.parse(belief.provenance)).toEqual(["f1"]);
		} finally {
			db.close();
		}
	});

	it("reports insufficient candidates deterministically", async () => {
		stubNoProvider();
		const db = new Database(":memory:");
		try {
			initBeam(db);
			const stats = await harmonize({ db }, 10, 1, 0.8);
			expect(stats.status).toBe("insufficient_candidates");
			expect(stats.beliefs_generated).toBe(0);
		} finally {
			db.close();
		}
	});
});

describe("SHMR pure parse and format helpers", () => {
	it("formats a cluster and skips holes in a sparse cluster array", () => {
		expect(formatClusterForLlm([])).toBe("=== MEMORY CLUSTER ===");
		expect(
			formatClusterForLlm([{ subject: "user", predicate: "likes", object: "tea", source: "fact", confidence: 0.8 }]),
		).toBe("=== MEMORY CLUSTER ===\n[0] (fact, conf=0.80) user | likes | tea");
		// Missing subject/predicate/source/confidence fall back to defaults, and
		// object resolves from content when object is absent.
		expect(formatClusterForLlm([{ content: "note" }])).toBe(
			"=== MEMORY CLUSTER ===\n[0] (fact, conf=0.50) unknown | stated | note",
		);
		// A hole in the array is skipped, so the surviving row keeps its real index.
		const sparse: Parameters<typeof formatClusterForLlm>[0] = [{ object: "y" }];
		(sparse as unknown[]).unshift(undefined);
		expect(formatClusterForLlm(sparse)).toBe("=== MEMORY CLUSTER ===\n[1] (fact, conf=0.50) unknown | stated | y");
	});

	it("extracts beliefs from direct, wrapped, fenced, and embedded JSON", () => {
		expect(
			extractJsonFromLlmOutput(
				'[{"subject":"a","predicate":"b","object":"tea","confidence":0.9,"action":"update","target_fact_id":"f1","rationale":"r"}]',
			),
		).toEqual([
			{
				subject: "a",
				predicate: "b",
				object: "tea",
				confidence: 0.9,
				action: "update",
				target_fact_id: "f1",
				rationale: "r",
			},
		]);
		// A {beliefs:[...]} wrapper is unwrapped; missing fields take their defaults.
		expect(extractJsonFromLlmOutput('{"beliefs":[{"object":"x"}]}')).toEqual([
			{
				subject: "entity",
				predicate: "related_to",
				object: "x",
				confidence: 0.5,
				action: "create",
				target_fact_id: null,
			},
		]);
		// Fenced block: out-of-range confidence clamps to 1 and an unknown action becomes "create".
		expect(extractJsonFromLlmOutput('```json\n[{"object":"y","confidence":5,"action":"bogus"}]\n```')).toEqual([
			{
				subject: "entity",
				predicate: "related_to",
				object: "y",
				confidence: 1,
				action: "create",
				target_fact_id: null,
			},
		]);
		// A bare array embedded in prose is recovered.
		expect(extractJsonFromLlmOutput('noise before [{"object":"z"}] noise after')).toEqual([
			{
				subject: "entity",
				predicate: "related_to",
				object: "z",
				confidence: 0.5,
				action: "create",
				target_fact_id: null,
			},
		]);
	});

	it("returns no beliefs for junk and drops entries with a non-string object", () => {
		expect(extractJsonFromLlmOutput("no json here")).toEqual([]);
		expect(extractJsonFromLlmOutput('[{"object":123},{"object":"ok"}]')).toEqual([
			{
				subject: "entity",
				predicate: "related_to",
				object: "ok",
				confidence: 0.5,
				action: "create",
				target_fact_id: null,
			},
		]);
	});

	it("reflects the highest-scoring non-empty facts, honoring topK", () => {
		expect(reflect(null, "q", null)).toBeNull();
		expect(reflect(null, "q", [])).toBeNull();
		// Sorted by score desc, empty content dropped: "a"(3) then "b"(1).
		expect(
			reflect(null, "q", [
				{ content: "b", score: 1 },
				{ content: "a", score: 3 },
				{ content: "", score: 5 },
			]),
		).toBe("a b");
		// topK=1 keeps only the top fact and falls back to `object` when content is absent.
		expect(
			reflect(
				null,
				"q",
				[
					{ object: "x", score: 2 },
					{ content: "y", score: 1 },
				],
				1,
			),
		).toBe("x");
		// All-empty content collapses to null.
		expect(reflect(null, "q", [{ content: "", score: 1 }])).toBeNull();
	});
});
