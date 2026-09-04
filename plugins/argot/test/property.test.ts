/**
 * Property and differential tests for the expander. The hand-written codec
 * (a single compiled RegExp) is checked against an independent reference
 * expander (a plain left-to-right scanner) over thousands of fuzzed vocabularies
 * and inputs, and against the invariants a harness relies on: expansion is a
 * single deterministic pass, an expansion carrying no sigil makes the pass
 * idempotent, and a text built out of handle tokens expands back to exactly the
 * strings those handles stand for.
 *
 * The fuzzer is seeded (mulberry32), so a failure reproduces from its seed
 * instead of flaking. Bump SEED to explore a different stream.
 */

import { describe, expect, test } from "bun:test";
import { makeExpander } from "../src/codec.js";
import type { Vocabulary } from "../src/types.js";

const SEED = 0x9e3779b9;
const NAME_BOUNDARY = /[a-z0-9_]/;

// Sigils that pass the parser's SIGIL_FORBIDDEN_RE (no letter/digit/underscore/
// whitespace). Every one is also a RegExp metacharacter or a multi-char marker,
// which is exactly what stresses escapeRegExp in the codec.
const SAFE_SIGILS = [
	"§",
	"$",
	".",
	"*",
	"+",
	"?",
	"^",
	"|",
	"(",
	")",
	"[",
	"]",
	"\\",
	"~",
	"!",
	"%",
	"#",
	"@",
	"&",
	"@@",
	"#$",
	"::",
];

/** A small deterministic PRNG so fuzz failures are reproducible from the seed. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rand: () => number, xs: readonly T[]): T {
	return xs[Math.floor(rand() * xs.length)] as T;
}

const NAME_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_";

function randomName(rand: () => number): string {
	const len = 1 + Math.floor(rand() * 6);
	let s = "";
	for (let i = 0; i < len; i++) s += pick(rand, NAME_CHARS.split(""));
	return s;
}

/**
 * A random sigil-free expansion. Sigil-free is the parser's real guarantee, and
 * it is what makes the single pass idempotent, so the fuzzer honors it.
 */
function randomExpansion(rand: () => number, sigil: string): string {
	const alphabet = "abc XYZ/._-012:".split("");
	const len = 1 + Math.floor(rand() * 12);
	let s = "";
	while (s.length < len) {
		const c = pick(rand, alphabet);
		s += c;
	}
	// Strip any accidental sigil occurrence to keep the parser's invariant.
	return s.split(sigil).join("Z") || "Z";
}

function randomVocab(rand: () => number): Vocabulary {
	const sigil = pick(rand, SAFE_SIGILS);
	const count = 1 + Math.floor(rand() * 8);
	const handles = new Map<string, string>();
	let guard = 0;
	while (handles.size < count && guard++ < count * 10) {
		const name = randomName(rand);
		if (!handles.has(name)) handles.set(name, randomExpansion(rand, sigil));
	}
	return { version: 1, sigil, handles, meta: new Map() };
}

/**
 * The reference expander: scan left to right, and at each position try the known
 * handle names longest-first, expanding only when the sigil is present and the
 * name is not immediately followed by another name character. No RegExp, so it
 * shares no code with the implementation under test.
 */
function referenceExpand(vocab: Vocabulary, text: string): string {
	const names = [...vocab.handles.keys()].sort((a, b) => b.length - a.length);
	const sigil = vocab.sigil;
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (text.startsWith(sigil, i)) {
			const rest = text.slice(i + sigil.length);
			let matched: string | undefined;
			for (const name of names) {
				if (rest.startsWith(name)) {
					const after = rest.charAt(name.length);
					if (after === "" || !NAME_BOUNDARY.test(after)) {
						matched = name;
						break;
					}
				}
			}
			if (matched !== undefined) {
				out += vocab.handles.get(matched) as string;
				i += sigil.length + matched.length;
				continue;
			}
		}
		out += text.charAt(i);
		i += 1;
	}
	return out;
}

/** Random text drawn from an alphabet that includes the vocab's sigil and name characters, to force boundary collisions. */
function randomText(rand: () => number, vocab: Vocabulary): string {
	const names = [...vocab.handles.keys()];
	const alphabet = [...new Set([...vocab.sigil, ...NAME_CHARS.slice(0, 6), " ", "X", "/"])];
	const len = Math.floor(rand() * 40);
	let s = "";
	for (let i = 0; i < len; i++) {
		// Occasionally splice a real handle token in so matches actually happen.
		if (rand() < 0.15 && names.length > 0) {
			s += vocab.sigil + pick(rand, names);
		} else {
			s += pick(rand, alphabet);
		}
	}
	return s;
}

/**
 * Realistic model output: handle tokens separated by filler that can neither
 * start a sigil match nor extend a name boundary. Filler is uppercase letters
 * and spaces; every safe sigil is a punctuation symbol and every name character
 * is lowercase/digit/underscore, so the filler collides with neither. Returns
 * the input and the exact text it must expand to, so the expansion is checked
 * against a constructed oracle, not against referenceExpand.
 */
function realisticOutput(rand: () => number, vocab: Vocabulary): { input: string; expected: string } {
	const names = [...vocab.handles.keys()];
	const filler = () => " ABC "[Math.floor(rand() * 5)];
	let input = "";
	let expected = "";
	const pieces = 1 + Math.floor(rand() * 8);
	for (let p = 0; p < pieces; p++) {
		const f = `${filler()}${filler()}`;
		const name = pick(rand, names);
		input += f + vocab.sigil + name;
		expected += f + (vocab.handles.get(name) as string);
	}
	return { input, expected };
}

describe("expander vs reference oracle (differential fuzz)", () => {
	test("the compiled RegExp expander agrees with the plain scanner on 3000 random cases", () => {
		const rand = mulberry32(SEED);
		for (let n = 0; n < 3000; n++) {
			const vocab = randomVocab(rand);
			const expand = makeExpander(vocab);
			const text = randomText(rand, vocab);
			const got = expand(text);
			const want = referenceExpand(vocab, text);
			if (got !== want) {
				throw new Error(
					`mismatch at case ${n}\n sigil=${JSON.stringify(vocab.sigil)}\n handles=${JSON.stringify([...vocab.handles])}\n text=${JSON.stringify(text)}\n got =${JSON.stringify(got)}\n want=${JSON.stringify(want)}`,
				);
			}
		}
	});
});

describe("expander invariants (property fuzz)", () => {
	test("text assembled from handle tokens expands to exactly the strings they stand for", () => {
		// A positive oracle independent of referenceExpand.
		const rand = mulberry32(SEED ^ 0x0f0f);
		for (let n = 0; n < 2000; n++) {
			const vocab = randomVocab(rand);
			const expand = makeExpander(vocab);
			const { input, expected } = realisticOutput(rand, vocab);
			expect(expand(input)).toBe(expected);
		}
	});

	test("expansion of realistic output is idempotent: the result has no handle left to change", () => {
		// The codec is a single, non-recursive pass by design; it never re-scans its
		// own output (doing so could expand text the model never marked). So a second
		// pass is a no-op exactly when the first pass leaves nothing expandable, which
		// is the case for realistic output: every sigil is part of a matched handle
		// and every expansion is sigil-free, so the result carries no handle token.
		// (Idempotency is NOT claimed for arbitrary text with stray sigils placed
		// against expansion-initial name characters; the differential test above
		// pins that single-pass behavior directly.)
		const rand = mulberry32(SEED ^ 0x1234);
		for (let n = 0; n < 2000; n++) {
			const vocab = randomVocab(rand);
			const expand = makeExpander(vocab);
			const { input, expected } = realisticOutput(rand, vocab);
			const once = expand(input);
			expect(once).toBe(expected);
			expect(expand(once)).toBe(once);
		}
	});

	test("two expanders built from the same vocabulary produce identical output", () => {
		const rand = mulberry32(SEED ^ 0x55aa);
		for (let n = 0; n < 1000; n++) {
			const vocab = randomVocab(rand);
			const text = randomText(rand, vocab);
			expect(makeExpander(vocab)(text)).toBe(makeExpander(vocab)(text));
		}
	});
});
