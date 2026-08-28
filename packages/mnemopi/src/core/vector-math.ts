import { tryParseJson } from "@veyyon/utils";

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
	const length = a.length > b.length ? a.length : b.length;
	if (length === 0) {
		return 0;
	}

	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < length; i += 1) {
		const rawA = a[i] ?? 0;
		const rawB = b[i] ?? 0;
		const av = Number.isFinite(rawA) ? rawA : 0;
		const bv = Number.isFinite(rawB) ? rawB : 0;
		dot += av * bv;
		normA += av * av;
		normB += bv * bv;
	}
	if (normA === 0 || normB === 0) {
		return 0;
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function cosineScorer(query: ArrayLike<number>): (candidate: ArrayLike<number>) => number {
	const cleanQuery = new Float64Array(query.length);
	let normA = 0;
	for (let i = 0; i < query.length; i += 1) {
		const raw = query[i] ?? 0;
		const av = Number.isFinite(raw) ? raw : 0;
		cleanQuery[i] = av;
		normA += av * av;
	}
	if (normA === 0) {
		return () => 0;
	}
	const sqrtA = Math.sqrt(normA);
	return (candidate: ArrayLike<number>): number => {
		const length = cleanQuery.length > candidate.length ? cleanQuery.length : candidate.length;
		let dot = 0;
		let normB = 0;
		for (let i = 0; i < length; i += 1) {
			const av = cleanQuery[i] ?? 0;
			const rawB = candidate[i] ?? 0;
			const bv = Number.isFinite(rawB) ? rawB : 0;
			dot += av * bv;
			normB += bv * bv;
		}
		if (normB === 0) {
			return 0;
		}
		return dot / (sqrtA * Math.sqrt(normB));
	};
}

export function encodeEmbeddingJson(embedding: readonly number[]): string {
	return JSON.stringify(embedding);
}

export function decodeEmbeddingJson(raw: unknown): number[] | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	const parsed = tryParseJson<unknown>(raw);
	if (!Array.isArray(parsed) || parsed.length === 0) return null;
	const out: number[] = new Array(parsed.length);
	for (let i = 0; i < parsed.length; i++) {
		const value = parsed[i];
		if (typeof value !== "number" || !Number.isFinite(value)) return null;
		out[i] = value;
	}
	return out;
}
