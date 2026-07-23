/**
 * Mnemopi conformance corpus (TS-SUITE-3). The vectors in ./vectors are the
 * language-neutral record of the first-wave pure-math boundary (cosine,
 * embedding JSON codec, int8/bit quantization, hamming, weibull decay,
 * jaccard, MMR): a Rust port replays the SAME files per
 * docs/migration/conformance-format.md. This suite proves the TS oracle is
 * green against its own corpus, so any divergence a port shows is a port
 * bug, not corpus drift. Counts are pinned so a dropped or orphaned vector
 * file can never pass silently as "fewer vectors, all green".
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertConformance } from "@veyyon/utils";
import { EMBEDDING_DIM } from "../../src/core/binary-vectors";
import {
	binarizeAsArray,
	cosineSimilarity,
	decodeEmbeddingJson,
	encodeEmbeddingJson,
	hammingDistanceFromArrays,
	informationScore,
	jaccardWordSimilarity,
	mmrRerankRecords,
	quantizeInt8AsArray,
	weibullDecayFactor12,
	wordSetSorted,
} from "../../src/core/conformance-boundary";

const VECTOR_DIR = join(import.meta.dir, "vectors");

/** The JSON-level port boundary the corpus targets (conformance-boundary.ts). */
const BOUNDARY = {
	cosineSimilarity,
	encodeEmbeddingJson,
	decodeEmbeddingJson,
	quantizeInt8AsArray,
	binarizeAsArray,
	hammingDistanceFromArrays,
	informationScore,
	weibullDecayFactor12,
	jaccardWordSimilarity,
	wordSetSorted,
	mmrRerankRecords,
};

describe("mnemopi conformance corpus", () => {
	test("recorded vectors assume the default embedding dimension regime", () => {
		// binarizeAsArray clamps to EMBEDDING_DIM (env-overridable). The corpus
		// uses inputs of at most 32 dims, so any environment with a smaller
		// override would silently change oracle behavior: fail loudly instead.
		expect(EMBEDDING_DIM).toBeGreaterThanOrEqual(32);
	});

	test("every recorded vector replays exactly against the TS implementation", () => {
		const report = assertConformance(BOUNDARY, VECTOR_DIR);
		// Regenerate with `bun scripts/record-conformance.ts mnemopi` and update
		// these counts in the same reviewed change (TS-SUITE-3).
		expect(report.files).toBe(11);
		expect(report.vectors).toBe(168);
	});
});
