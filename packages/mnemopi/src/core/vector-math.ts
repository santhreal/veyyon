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

/**
 * Build a reusable cosine scorer bound to one query vector. When you score many
 * candidates against the same query (recall's vector pass sweeps up to a few hundred
 * rows per tier), `cosineSimilarity(query, candidate)` recomputes the query norm and
 * re-runs the query's finite-value check on every call. `cosineScorer` does that work
 * once and returns a closure that scores each candidate.
 *
 * The returned scorer is byte-identical to `cosineSimilarity(query, candidate)` for
 * every candidate, not merely close: it keeps the same operation order (accumulate the
 * dot product at full precision, then divide by `sqrt(normA) * sqrt(normB)`), so no
 * pre-division shifts a rounding bit. Length mismatch (missing entries read as 0) and
 * non-finite entries (read as 0) are handled exactly as in `cosineSimilarity`.
 */
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

// Every persisted embedding is stored as a JSON array of numbers. `encodeEmbeddingJson`
// and `decodeEmbeddingJson` are the single owner of that wire format: encode with the
// former on write, decode with the latter on read, and never hand-roll `JSON.parse`
// over an `embedding_json` column again. Decoding is strict on purpose. A stored blob
// is trusted input only insofar as this validator accepts it, so anything that is not a
// non-empty JSON array of finite numbers decodes to `null` and the caller skips the row
// rather than feeding garbage (a non-array, a `NaN`, a numeric string) into scoring.

/** Serialize an embedding to the stored `embedding_json` wire format. */
export function encodeEmbeddingJson(embedding: readonly number[]): string {
	return JSON.stringify(embedding);
}

/**
 * Decode a stored `embedding_json` blob into a plain vector, or `null` when the blob is
 * missing, malformed, empty, or holds a non-numeric or non-finite element. This is the
 * one validation contract shared by every persisted-embedding read path.
 */
export function decodeEmbeddingJson(raw: unknown): number[] | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return null;
	const out: number[] = new Array(parsed.length);
	for (let i = 0; i < parsed.length; i++) {
		const value = parsed[i];
		if (typeof value !== "number" || !Number.isFinite(value)) return null;
		out[i] = value;
	}
	return out;
}
