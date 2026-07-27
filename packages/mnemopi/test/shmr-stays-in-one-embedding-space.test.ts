/**
 * SHMR never compares vectors from two different embedding spaces.
 *
 * THE BUG. SHMR has two sources of vectors: the configured embedding provider, and a
 * deterministic SHA1 bag-of-words sketch used when no provider is available. The sketch
 * is 384 slots wide and counts word occurrences; a provider vector is whatever the model
 * produces and encodes meaning. They are not comparable. `cosineSimilarity` does not say
 * so, because it zero-pads the shorter side to the longer side's length and returns a
 * number, so every mixed comparison produced a plausible-looking score.
 *
 * Three paths mixed them, all silently:
 *
 *   1. `resolveItemVectors` kept the caller's provider vectors (which `harmonize` seeds
 *      from the stored `memory_embeddings` rows) and hash-filled only the items that had
 *      none. With the provider down, one clustering pass held both kinds at once.
 *   2. `computeHarmonyScore` embedded the cluster's items and its beliefs in two separate
 *      calls, so a provider that failed between them left the two sides in two spaces.
 *   3. `embedBatch` fell through to the hash whenever the provider returned the wrong
 *      NUMBER of vectors, with no log at all. Only the throwing path was reported.
 *
 * WHY IT WAS INVISIBLE. Nothing threw and nothing logged. Clusters still formed and
 * harmony scores still came out in range; they were just wrong. The symptom is recall
 * degrading, which nobody attributes to a vector-space mismatch.
 *
 * WHAT IS PINNED HERE. A degrade takes the whole pass, so one call's vectors always share
 * one space; every degrade is logged; and widths that disagree fail closed with an error
 * naming the repair, rather than being zero-padded into a meaningless cosine.
 */

import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { initBeam } from "@veyyon/mnemopi/core/beam";
import * as embeddings from "@veyyon/mnemopi/core/embeddings";
import {
	clusterBySimilarity,
	computeHarmonyScore,
	embed,
	embedBatch,
	harmonize,
	initSchema,
	recallBeliefs,
} from "@veyyon/mnemopi/core/shmr";
import { logger } from "@veyyon/utils";

let embedSpy: Mock<typeof embeddings.embed> | null = null;
let warnSpy: Mock<typeof logger.warn> | null = null;

afterEach(() => {
	embedSpy?.mockRestore();
	embedSpy = null;
	warnSpy?.mockRestore();
	warnSpy = null;
});

/** The hash fallback's width. A vector of this length in these tests is a sketch. */
const HASH_DIM = 384;
/** A provider width that is not the hash width, so the two are told apart by length. */
const WIDE_DIM = 1024;

/** Routes the embeddings module's batch API through a fake per-text vector table. */
function stubProvider(vectorFor: (text: string) => Float32Array): void {
	embedSpy = spyOn(embeddings, "embed").mockImplementation(async (texts: readonly string[]) => texts.map(vectorFor));
}

/** No provider at all: every call falls back to the hash sketch. */
function stubNoProvider(): void {
	embedSpy = spyOn(embeddings, "embed").mockResolvedValue(null);
}

/** A provider that throws, the failure path that was already logged before this change. */
function stubFailingProvider(): void {
	embedSpy = spyOn(embeddings, "embed").mockRejectedValue(new Error("provider unreachable"));
}

/** Capture `logger.warn` so a degrade can be asserted to be loud rather than silent. */
function captureWarnings(): string[] {
	const messages: string[] = [];
	warnSpy = spyOn(logger, "warn").mockImplementation((message: string) => {
		messages.push(message);
	});
	return messages;
}

/** A `WIDE_DIM`-wide provider-style vector pointing along one axis. */
function wide(axis: number): Float32Array {
	const out = new Float32Array(WIDE_DIM);
	out[axis] = 1;
	return out;
}

describe("a degraded pass degrades completely", () => {
	/**
	 * THE regression, at its narrowest. One item arrives with a provider vector and one
	 * does not; the provider is gone, so the second can only be hashed. Before this
	 * change the first kept its 1024-dimension vector and the second got a 384-slot
	 * sketch, and the two were compared. Now both are sketches: one space, one width.
	 */
	it("re-hashes items that arrived with a provider vector when the rest cannot be embedded", async () => {
		stubNoProvider();

		// Both items carry the SAME text, so once both are hashed their sketches are
		// identical and they cluster. Before the fix the first kept its 1024-dimension
		// vector while the second became a 384-slot sketch, the cosine between them was
		// zero-padded noise well under the threshold, and two identical items landed in
		// two separate clusters.
		const clusters = await clusterBySimilarity(
			[{ object: "alpha beta", embedding: wide(0) }, { object: "alpha beta" }],
			0.7,
		);

		expect(clusters.length).toBe(1);
		expect(clusters[0]?.length).toBe(2);
	});

	/**
	 * The re-hash is announced. A pass that quietly threw away real provider vectors
	 * would be the same class of defect as the mixing it replaces: correct output, no
	 * way to know why recall got worse.
	 */
	it("logs that it discarded provider vectors to stay in one space", async () => {
		const warnings = captureWarnings();
		stubNoProvider();

		await clusterBySimilarity([{ object: "alpha beta", embedding: wide(0) }, { object: "gamma delta" }], 0.7);

		expect(warnings).toContain("mnemopi shmr re-hashed every item so one pass stays in one embedding space");
	});

	/**
	 * The re-hash fires only when it is needed. Every item arriving with a vector, or no
	 * item arriving with one, is already a single space, and discarding provider vectors
	 * in that case would be a pure loss.
	 */
	it("keeps provider vectors when nothing needs the fallback", async () => {
		const warnings = captureWarnings();
		stubNoProvider();

		const clusters = await clusterBySimilarity(
			[
				{ object: "alpha beta", embedding: wide(0) },
				{ object: "gamma delta", embedding: wide(0) },
			],
			0.7,
		);

		// Identical vectors, so they cluster together, which the 384-slot sketches of two
		// texts with no shared words could not do.
		expect(clusters.length).toBe(1);
		expect(warnings).not.toContain("mnemopi shmr re-hashed every item so one pass stays in one embedding space");
	});

	/**
	 * And with a working provider the seeded vectors survive, because the freshly
	 * embedded items come from the same model. This is the case the fix must not break.
	 */
	it("keeps provider vectors when the provider can embed the rest", async () => {
		stubProvider(() => wide(0));

		const clusters = await clusterBySimilarity(
			[{ object: "alpha beta", embedding: wide(0) }, { object: "gamma delta" }],
			0.7,
		);

		expect(clusters.length).toBe(1);
		expect(clusters[0]?.length).toBe(2);
	});
});

describe("a batch that cannot be embedded is reported", () => {
	/**
	 * A provider returning the wrong number of vectors used to fall through to the hash
	 * with no log whatsoever: the only silent degrade of the three. It is a defect in
	 * that provider, and swallowing it means nobody ever learns which provider is broken.
	 */
	it("logs when the provider returns the wrong number of vectors", async () => {
		const warnings = captureWarnings();
		embedSpy = spyOn(embeddings, "embed").mockResolvedValue([wide(0)]);

		const vectors = await embedBatch(["one", "two", "three"]);

		expect(warnings).toContain(
			"mnemopi shmr embedding provider returned the wrong number of vectors; recall degraded to hash",
		);
		expect(vectors.length).toBe(3);
		expect(vectors.every(vector => vector.length === HASH_DIM)).toBe(true);
	});

	/** The provider throwing was already reported, and still is. */
	it("logs when the provider fails outright", async () => {
		const warnings = captureWarnings();
		stubFailingProvider();

		const vectors = await embedBatch(["one", "two"]);

		expect(warnings).toContain(
			"mnemopi shmr embedding provider failed; recall degraded to hash embeddings for this batch",
		);
		expect(vectors.length).toBe(2);
	});

	/**
	 * One vector per text, always. The old `?? hashEmbedding(...)` guards at each read
	 * site existed because this was not guaranteed, and each of them mixed a lone sketch
	 * into a set of provider vectors when it fired.
	 */
	it("returns exactly one vector per text", async () => {
		stubProvider(() => wide(0));

		expect((await embedBatch(["a", "b", "c", "d"])).length).toBe(4);
		expect((await embedBatch([])).length).toBe(0);
	});

	/** A single-text embed is the same contract, and no longer needs its own fallback. */
	it("embeds a single text at the provider's width", async () => {
		stubProvider(() => wide(3));

		expect((await embed("alpha")).length).toBe(WIDE_DIM);
	});

	/** With no provider, that same call yields a sketch at the sketch's own width. */
	it("embeds a single text at the sketch width when there is no provider", async () => {
		stubNoProvider();

		expect((await embed("alpha")).length).toBe(HASH_DIM);
	});
});

describe("widths that disagree fail closed", () => {
	/**
	 * The backstop. Re-hashing covers the fallback case, but a store can hold rows from
	 * two different models after a model change, and those vectors are seeded straight
	 * into a pass. Zero-padding them together produced a number; refusing names the
	 * repair instead. Widths agreeing does not prove the spaces agree, but widths
	 * disagreeing proves they do not.
	 */
	it("refuses a cluster whose caller-supplied vectors are different widths", async () => {
		stubProvider(() => wide(0));

		const mixed = [
			{ object: "alpha", embedding: wide(0) },
			{ object: "beta", embedding: new Float32Array(HASH_DIM) },
		];

		expect(clusterBySimilarity(mixed, 0.7)).rejects.toThrow(/mixes embedding widths \(1024 and 384\)/);
	});

	/** The message has to be actionable, not just an assertion failure. */
	it("names the repair in the error", async () => {
		stubProvider(() => wide(0));

		const mixed = [
			{ object: "alpha", embedding: wide(0) },
			{ object: "beta", embedding: new Float32Array(HASH_DIM) },
		];

		expect(clusterBySimilarity(mixed, 0.7)).rejects.toThrow(/Re-embed the affected rows with one model/);
	});

	/**
	 * A provider that itself returns ragged vectors is the same defect one layer out.
	 * It is caught at the boundary rather than propagating into a cosine.
	 */
	it("refuses a provider that returns vectors of different widths", async () => {
		embedSpy = spyOn(embeddings, "embed").mockResolvedValue([wide(0), new Float32Array(7)]);

		expect(embedBatch(["one", "two"])).rejects.toThrow(/the embedding provider's own output/);
	});

	/** One vector on its own is trivially one space and must not be refused. */
	it("accepts a single vector", async () => {
		stubProvider(() => wide(0));

		expect((await embedBatch(["only"])).length).toBe(1);
	});
});

describe("harmony scoring embeds items and beliefs together", () => {
	/**
	 * The items and the beliefs used to be two separate `embedBatch` calls, so a provider
	 * that failed between them left one side as provider vectors and the other as
	 * sketches. Pinning the call COUNT is what proves they cannot diverge: one call
	 * cannot make two fallback decisions.
	 */
	it("makes one provider call for the whole score", async () => {
		stubProvider(() => wide(0));

		await computeHarmonyScore(
			[{ subject: "s", predicate: "p", object: "o", confidence: 0.9, action: "create", rationale: "r" }],
			[{ object: "alpha" }, { object: "beta" }],
		);

		expect(embedSpy?.mock.calls.length).toBe(1);
	});

	/** That one call carries every text: both cluster items and every belief. */
	it("passes the cluster's items and the beliefs in that one call", async () => {
		stubProvider(() => wide(0));

		await computeHarmonyScore(
			[{ subject: "s", predicate: "likes", object: "tea", confidence: 0.9, action: "create", rationale: "r" }],
			[{ object: "alpha" }, { object: "beta" }],
		);

		expect(embedSpy?.mock.calls[0]?.[0]).toEqual(["alpha", "beta", "likes tea"]);
	});

	/**
	 * A belief sitting exactly at the cluster's centre scores its own confidence. Real
	 * value, not a range check: with the mixing, this returned a small arbitrary number
	 * because the belief's sketch was compared against a centroid of provider vectors.
	 */
	it("scores a belief at the cluster centre as its confidence", async () => {
		stubProvider(() => wide(0));

		const score = await computeHarmonyScore(
			[{ subject: "s", predicate: "p", object: "o", confidence: 0.8, action: "create", rationale: "r" }],
			[{ object: "alpha" }, { object: "beta" }],
		);

		expect(score).toBeCloseTo(0.8, 6);
	});

	/** A belief orthogonal to the cluster scores zero, the other end of the same scale. */
	it("scores a belief orthogonal to the cluster as zero", async () => {
		stubProvider(text => (text === "p o" ? wide(1) : wide(0)));

		const score = await computeHarmonyScore(
			[{ subject: "s", predicate: "p", object: "o", confidence: 0.8, action: "create", rationale: "r" }],
			[{ object: "alpha" }, { object: "beta" }],
		);

		expect(score).toBeCloseTo(0, 6);
	});

	/** Empty inputs are not an error, and must not reach the provider at all. */
	it("scores nothing without calling the provider", async () => {
		stubProvider(() => wide(0));

		expect(await computeHarmonyScore([], [{ object: "alpha" }])).toBe(0);
		expect(
			await computeHarmonyScore(
				[{ subject: "s", predicate: "p", object: "o", confidence: 1, action: "create", rationale: "r" }],
				[],
			),
		).toBe(0);
		expect(embedSpy?.mock.calls.length).toBe(0);
	});
});

describe("belief recall scores in one space", () => {
	/**
	 * `recallBeliefs` embedded the query and every stored belief in one call already, but
	 * guarded each read with `?? hashEmbedding(...)`. When such a guard fired it scored a
	 * lone sketch against provider vectors. The guards are gone and the contract they
	 * papered over is enforced instead.
	 */
	it("ranks the belief matching the query first", async () => {
		const db = new Database(":memory:");
		initSchema(db);
		db.query(
			"INSERT INTO harmonic_beliefs (belief_id, subject, predicate, object, confidence, provenance) VALUES (?, ?, ?, ?, ?, ?)",
		).run("b1", "user", "likes", "tea", 0.9, "test");
		db.query(
			"INSERT INTO harmonic_beliefs (belief_id, subject, predicate, object, confidence, provenance) VALUES (?, ?, ?, ?, ?, ?)",
		).run("b2", "user", "likes", "coffee", 0.9, "test");
		stubProvider(text => (text === "coffee" ? wide(1) : wide(0)));

		const results = await recallBeliefs({ db }, "tea", 2);

		expect(results[0]?.belief_id).toBe("b1");
		expect(results[0]?.score).toBe(0.9);
	});

	/** And the non-matching belief scores zero rather than a padded near-miss. */
	it("scores an unrelated belief as zero", async () => {
		const db = new Database(":memory:");
		initSchema(db);
		db.query(
			"INSERT INTO harmonic_beliefs (belief_id, subject, predicate, object, confidence, provenance) VALUES (?, ?, ?, ?, ?, ?)",
		).run("b2", "user", "likes", "coffee", 0.9, "test");
		stubProvider(text => (text === "coffee" ? wide(1) : wide(0)));

		const results = await recallBeliefs({ db }, "tea", 2);

		expect(results[0]?.score).toBe(0);
	});
});

describe("harmonize over a store where only some memories are pre-embedded", () => {
	/**
	 * A store holding one memory with a stored `memory_embeddings` row and one without is
	 * the ordinary state of a live store: embedding is scheduled, so it lags writes.
	 * `harmonize` seeds the first from the store and leaves the second to be embedded,
	 * which is exactly the mix that used to reach `clusterBySimilarity`.
	 */
	function storeWithOneEmbeddedMemory(): Database {
		const db = new Database(":memory:");
		initBeam(db);
		initSchema(db);
		const insert = db.query(
			"INSERT INTO episodic_memory (id, content, importance, created_at) VALUES (?, ?, ?, ?)",
		);
		// Identical content, so any single space clusters them and no space at all does not.
		insert.run("m1", "the same remembered sentence", 0.6, "2026-01-01T00:00:00Z");
		insert.run("m2", "the same remembered sentence", 0.6, "2026-01-01T00:00:01Z");
		db.query("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, ?)").run(
			"m1",
			JSON.stringify(Array.from(wide(0))),
			"a-wide-model",
		);
		return db;
	}

	/**
	 * THE end-to-end regression. With the provider down, `m1` used to keep its stored
	 * 1024-dimension vector while `m2` became a 384-slot sketch. Two identical memories
	 * then scored near zero against each other, no cluster reached the minimum size, and
	 * harmonize reported nothing found. Re-hashing both puts them back in one space.
	 */
	it("clusters two identical memories when only one of them was pre-embedded", async () => {
		stubNoProvider();

		const stats = await harmonize({ db: storeWithOneEmbeddedMemory() } as never);

		expect(stats.clusters_found).toBe(1);
		expect(stats.status).toBe("harmonized");
	});

	/** The discard is reported on this path too, not only in the unit case. */
	it("logs the discard on the harmonize path", async () => {
		const warnings = captureWarnings();
		stubNoProvider();

		await harmonize({ db: storeWithOneEmbeddedMemory() } as never);

		expect(warnings).toContain("mnemopi shmr re-hashed every item so one pass stays in one embedding space");
	});

	/**
	 * With a working provider nothing is discarded: the stored vector and the fresh one
	 * come from the same model, so they are already one space and both are kept.
	 */
	it("keeps the stored vector when the provider is available", async () => {
		const warnings = captureWarnings();
		stubProvider(() => wide(0));

		const stats = await harmonize({ db: storeWithOneEmbeddedMemory() } as never);

		expect(stats.clusters_found).toBe(1);
		expect(warnings).not.toContain("mnemopi shmr re-hashed every item so one pass stays in one embedding space");
	});
});
