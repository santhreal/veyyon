/**
 * The JSON-level port boundary for mnemopi's first-wave pure math
 * (TS-SUITE-1). A Rust port reimplements exactly these functions against the
 * recorded conformance corpus, so every input and output here is plain JSON:
 * typed arrays cross the boundary as number arrays, sets as sorted arrays.
 * The adapters delegate to the real implementations; they never reimplement,
 * so the corpus always records production behavior.
 *
 * Float determinism: cosine and the bit/byte functions use only IEEE-exact
 * operations (+, *, /, sqrt) and must match bit-for-bit. Weibull decay uses
 * exp/pow, which are not correctly rounded across libms, so its boundary
 * value is rounded to 12 significant digits (documented in
 * docs/migration/mnemopi-contract.md); a port applies the same rounding.
 */

import { jaccardWordSimilarity, wordSet } from "../util/text-similarity";
import {
	hammingDistance,
	informationTheoreticScore,
	maximallyInformativeBinarization,
	quantizeInt8,
} from "./binary-vectors";
import { mmrRerank } from "./mmr";
import { cosineSimilarity, decodeEmbeddingJson, encodeEmbeddingJson } from "./vector-math";
import { weibullDecayFactor } from "./weibull";

export { cosineSimilarity, decodeEmbeddingJson, encodeEmbeddingJson, jaccardWordSimilarity };

/** Round to 12 significant digits: the boundary form for exp/pow results. */
export function round12(value: number): number {
	if (!Number.isFinite(value)) return value;
	return Number(value.toPrecision(12));
}

/** {@link quantizeInt8} with the Int8Array crossing the boundary as numbers. */
export function quantizeInt8AsArray(embedding: readonly number[]): number[] {
	return Array.from(quantizeInt8(embedding));
}

/** {@link maximallyInformativeBinarization} as a plain byte array (MSB-first bits). */
export function binarizeAsArray(embedding: readonly number[]): number[] {
	return Array.from(maximallyInformativeBinarization(embedding));
}

/** {@link hammingDistance} over plain byte arrays. */
export function hammingDistanceFromArrays(a: readonly number[], b: readonly number[]): number {
	return hammingDistance(Uint8Array.from(a), Uint8Array.from(b));
}

/** {@link informationTheoreticScore} with the dimension always explicit (no env default). */
export function informationScore(distance: number, dim: number): number {
	return informationTheoreticScore(distance, dim);
}

/** {@link weibullDecayFactor} rounded to the boundary's 12 significant digits. */
export function weibullDecayFactor12(ageHours: number, memoryType?: string): number {
	return round12(weibullDecayFactor(ageHours, memoryType));
}

/** {@link wordSet} as a sorted array (sets have no JSON form). */
export function wordSetSorted(text: string): string[] {
	return [...wordSet(text)].sort();
}

/** {@link mmrRerank} over plain `{content, score}` records with an explicit
 * lambda and topK; the default Jaccard similarity is part of the contract. */
export function mmrRerankRecords(
	results: ReadonlyArray<{ content?: string; score?: number }>,
	lambdaParam: number,
	topK: number,
): Array<{ content?: string; score?: number }> {
	return mmrRerank(results, lambdaParam, topK);
}
