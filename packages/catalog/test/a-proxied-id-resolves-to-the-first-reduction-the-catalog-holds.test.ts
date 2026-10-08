/**
 * A proxied model id resolves to the reference of the first id, in reduction order, that the catalog
 * holds, and reads each lookup key at most once on the way.
 *
 * WHY THIS SUITE EXISTS. `resolveModelReference` runs once per discovered model, and on the lazy bundled
 * index every key it reads can parse catalog records. It used to derive every reduction of an id before
 * reading the first key, and it read a key again for each spelling that differed only in case:
 * `[Kiro] gpt-4o:cloud` read three of its six keys twice. It now reads as it reduces and skips a key that
 * already missed.
 *
 * THE CLASS. Any resolver change that reads a key twice, returns a later reduction's reference over an
 * earlier one, keeps reading past a hit, or prefers a suffix alias to an exact entry under one key. The
 * sweep crosses bracketed affixes, path prefixes, case, cloud and marker suffixes, and for each query
 * holds random subsets of the keys it reads, so precedence is checked at every position of the trace.
 *
 * WHAT IT DOES NOT CATCH. A change to the reduction rules themselves that keeps the order consistent
 * with itself: the precedence property is stated against the resolver's own read order. One trace is
 * pinned by hand below to hold that order. Spellings outside ASCII whose lowercase changes under slicing
 * are not swept.
 */
import { describe, expect, it } from "bun:test";
import {
	type ModelReferenceCandidate,
	type ModelReferenceLookup,
	resolveModelReference,
} from "../src/identity/reference";

/** A lookup that holds what the test gives it and records every exact key the resolver reads. */
function recordingLookup(
	exact: ReadonlyMap<string, ModelReferenceCandidate>,
	alias: ReadonlyMap<string, ModelReferenceCandidate>,
): { lookup: ModelReferenceLookup<ModelReferenceCandidate>; reads: string[] } {
	const reads: string[] = [];
	return {
		reads,
		lookup: {
			exact: {
				get(key) {
					reads.push(key);
					return exact.get(key);
				},
			},
			suffixAlias: { get: key => alias.get(key) },
		},
	};
}

/** The keys `query` reads against a lookup that holds nothing: the whole reduction order. */
function readOrder(query: string): string[] {
	const { lookup, reads } = recordingLookup(new Map(), new Map());
	expect(resolveModelReference(query, lookup)).toBeUndefined();
	return reads;
}

function reference(id: string): ModelReferenceCandidate {
	return { id, provider: "p", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
}

/** A deterministic 32-bit generator, so a failing seed reproduces. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PREFIXES = ["", "[Kiro] ", "【gcli转】", "vendor/", "Vendor/", "a/b/", " "];
const BASES = ["gpt-4o", "Claude-Opus-4-6", "llama-3.1-70b", "plain-model", "GROK-2"];
const SUFFIXES = ["", ":cloud", "-Cloud", "-thinking", ":free", " [假流]", ":nitro:cloud", "-search"];
const QUERIES = PREFIXES.flatMap(prefix => BASES.flatMap(base => SUFFIXES.map(suffix => prefix + base + suffix)));

describe("a proxied id resolves to the first reduction the catalog holds", () => {
	it("reads the keys of a bracketed cloud id in breadth-first reduction order", () => {
		// The affix-stripped id, then the id without its cloud suffix, then that one's separators, and only
		// then the reductions of those. The lowercase spelling of the query is not read again.
		expect(readOrder("[Kiro] gpt-4o:cloud")).toEqual([
			"[kiro] gpt-4o:cloud",
			"gpt-4o:cloud",
			"[kiro] gpt-4o",
			"[kiro] gpt-4o-cloud",
			"gpt-4o",
			"gpt-4o-cloud",
		]);
	});

	it("reads each key at most once", () => {
		const repeated = QUERIES.filter(query => {
			const reads = readOrder(query);
			return new Set(reads).size !== reads.length;
		});
		expect(repeated).toEqual([]);
	});

	it("returns the first key's reference, exact before alias, and reads nothing past it", () => {
		const failures: string[] = [];
		for (const [ordinal, query] of QUERIES.entries()) {
			const order = readOrder(query);
			const random = mulberry32(ordinal + 1);
			for (let trial = 0; trial < 24; trial++) {
				const exact = new Map<string, ModelReferenceCandidate>();
				const alias = new Map<string, ModelReferenceCandidate>();
				for (const key of order) {
					if (random() < 0.25) exact.set(key, reference(`exact:${key}`));
					if (random() < 0.25) alias.set(key, reference(`alias:${key}`));
				}
				const first = order.findIndex(key => exact.has(key) || alias.has(key));
				const expected = first === -1 ? undefined : (exact.get(order[first]!) ?? alias.get(order[first]!));
				const { lookup, reads } = recordingLookup(exact, alias);
				const resolved = resolveModelReference(query, lookup);
				if (resolved !== expected) {
					failures.push(`${JSON.stringify(query)} trial ${trial}: ${resolved?.id} instead of ${expected?.id}`);
				}
				const expectedReads = first === -1 ? order.length : first + 1;
				if (reads.length !== expectedReads) {
					failures.push(
						`${JSON.stringify(query)} trial ${trial}: read ${reads.length} keys, not ${expectedReads}`,
					);
				}
			}
		}
		expect(failures).toEqual([]);
	});
});
