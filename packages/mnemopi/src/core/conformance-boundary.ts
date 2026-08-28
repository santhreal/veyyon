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

export function round12(value: number): number {
	if (!Number.isFinite(value)) return value;
	return Number(value.toPrecision(12));
}

export function quantizeInt8AsArray(embedding: readonly number[]): number[] {
	return Array.from(quantizeInt8(embedding));
}

export function binarizeAsArray(embedding: readonly number[]): number[] {
	return Array.from(maximallyInformativeBinarization(embedding));
}

export function hammingDistanceFromArrays(a: readonly number[], b: readonly number[]): number {
	return hammingDistance(Uint8Array.from(a), Uint8Array.from(b));
}

export function informationScore(distance: number, dim: number): number {
	return informationTheoreticScore(distance, dim);
}

export function weibullDecayFactor12(ageHours: number, memoryType?: string): number {
	return round12(weibullDecayFactor(ageHours, memoryType));
}

export function wordSetSorted(text: string): string[] {
	return Array.from(wordSet(text)).sort();
}

export function mmrRerankRecords(
	results: ReadonlyArray<{ content?: string; score?: number }>,
	lambdaParam: number,
	topK: number,
): Array<{ content?: string; score?: number }> {
	return mmrRerank(results, lambdaParam, topK);
}
