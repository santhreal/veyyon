/**
 * `utf8ByteLength` and `isWellFormedUtf16` measure what the encoder does.
 *
 * WHY THIS SUITE EXISTS. Both were private helpers inside
 * `packages/coding-agent/src/secrets/obfuscator.ts`, an 1,800-line module that reaches
 * the secret registry and an 18-module JSON Schema validator, and `isWellFormedUtf16`
 * additionally had a SECOND copy in `secrets/placeholder.ts`. They are neither about
 * secrets nor about placeholders: one counts the bytes a string takes on the wire and
 * the other says whether it is encodable at all. They live in `string-length.ts` now,
 * beside `codePointLength`, which is the module that owns string measurement.
 *
 * Neither had a test of its own, because a private helper cannot have one. That matters
 * more than usual here: both are used as SECURITY BOUNDS. `utf8ByteLength` decides
 * whether a payload is under the transformation byte limit, so an undercount is a limit
 * that does not hold, and `isWellFormedUtf16` decides whether a value can survive a round
 * trip, so a false positive is a secret that goes out as one string and comes back as
 * another with U+FFFD in it.
 *
 * So the two central cases are DIFFERENTIAL against the platform: `utf8ByteLength` must
 * agree with `TextEncoder` on every input including the ill-formed ones, and
 * `isWellFormedUtf16` must agree with `String.prototype.isWellFormed`. Those are the
 * oracles the contract is actually stated against, and a hand-written table of expected
 * numbers would only pin what the author already believed.
 */

import { describe, expect, it } from "bun:test";
import { codePointLength, isWellFormedUtf16, utf8ByteLength } from "@veyyon/utils/string-length";

/** Every string both functions are checked against, named so a failure says which shape broke. */
const CORPUS: ReadonlyArray<readonly [string, string]> = [
	["empty", ""],
	["ascii", "hello world"],
	["ascii control", "\x00\x01\t\n\r\x7f"],
	["two-byte latin", "café"],
	["two-byte greek", "λόγος"],
	["three-byte cjk", "日本語"],
	["three-byte at the boundary", "߿ࠀ"],
	["four-byte astral", "𝄞𝄢"],
	["emoji with a zero-width joiner", "👩‍👩‍👧‍👦"],
	["emoji with a variation selector", "☂️"],
	["a lone high surrogate", "\ud800"],
	["a lone low surrogate", "\udc00"],
	["a reversed pair", "\udc00\ud800"],
	["a high surrogate at the end", "ok\ud83d"],
	["a well-formed pair", "😀"],
	["mixed", "a√日𝄞\ud800z"],
];

const encoder = new TextEncoder();

describe("utf8ByteLength", () => {
	/**
	 * THE CONTRACT, stated against the encoder that actually writes the bytes. A byte
	 * limit is only a limit if the count matches what goes on the wire, and the whole
	 * reason this is a loop over a corpus rather than a table is that the interesting
	 * inputs are the ones nobody predicts: a lone surrogate is THREE bytes here because
	 * `TextEncoder` substitutes U+FFFD for it, not because three is a natural answer.
	 */
	it("counts what TextEncoder emits, for every shape including the ill-formed ones", () => {
		for (const [name, value] of CORPUS) {
			expect(`${name}: ${utf8ByteLength(value)}`).toBe(`${name}: ${encoder.encode(value).length}`);
		}
	});

	/**
	 * The per-class numbers, written out. The differential above proves agreement without
	 * saying what is being agreed on, so this pins the four widths a reader needs to know
	 * to reason about a byte budget at all.
	 */
	it("charges one, two, three and four bytes by code-point range", () => {
		expect(utf8ByteLength("a")).toBe(1);
		// Escaped, not literal: a raw DEL byte in a source file makes the whole file read as binary.
		expect(utf8ByteLength("\u007f")).toBe(1);
		expect(utf8ByteLength("")).toBe(2);
		expect(utf8ByteLength("߿")).toBe(2);
		expect(utf8ByteLength("ࠀ")).toBe(3);
		expect(utf8ByteLength("￿")).toBe(3);
		expect(utf8ByteLength("\u{10000}")).toBe(4);
		expect(utf8ByteLength("\u{10ffff}")).toBe(4);
	});

	/**
	 * The three measurements disagree, which is the reason all three exist. A budget
	 * written against the wrong one is wrong by up to a factor of four on the same text,
	 * and this is the case that shows all three answers for one string at once.
	 */
	it("is not the code-unit count and not the code-point count", () => {
		const astral = "𝄞";

		expect(astral.length).toBe(2);
		expect(codePointLength(astral)).toBe(1);
		expect(utf8ByteLength(astral)).toBe(4);
	});

	/**
	 * The range form, which exists so a caller rewriting a long string can measure the span
	 * it just matched without allocating a substring. It has to answer what slicing would.
	 */
	it("measures a code-unit range the way slicing it would", () => {
		const text = "aé日𝄞z";
		for (let start = 0; start <= text.length; start++) {
			for (let end = start; end <= text.length; end++) {
				const label = `[${start},${end})`;
				expect(`${label}: ${utf8ByteLength(text, start, end)}`).toBe(
					`${label}: ${encoder.encode(text.slice(start, end)).length}`,
				);
			}
		}
	});

	/**
	 * A range that cuts a surrogate pair in half. This is the case the range form is most
	 * likely to get wrong, because the four-byte path reads the NEXT code unit and has to
	 * stop at `end` rather than at the string's end: charging four for a half pair would
	 * make two adjacent spans sum to more than the whole.
	 */
	it("charges three for half a pair rather than reading past the end of the range", () => {
		const pair = "😀";

		expect(utf8ByteLength(pair)).toBe(4);
		expect(utf8ByteLength(pair, 0, 1)).toBe(3);
		expect(utf8ByteLength(pair, 1, 2)).toBe(3);
		expect(utf8ByteLength(pair, 0, 1) + utf8ByteLength(pair, 1, 2)).toBeGreaterThan(utf8ByteLength(pair));
	});

	/** An empty range is zero bytes, and so is an empty string. The base case of every accumulation. */
	it("charges nothing for an empty range", () => {
		expect(utf8ByteLength("")).toBe(0);
		expect(utf8ByteLength("abc", 2, 2)).toBe(0);
	});
});

describe("isWellFormedUtf16", () => {
	/**
	 * THE CONTRACT, against the platform's own answer. `String.prototype.isWellFormed` is
	 * the specification of this predicate; this function exists because it runs per string
	 * on payloads of arbitrary size and short-circuits without allocating, which is a
	 * performance choice and must not become a semantic one.
	 */
	it("agrees with String.prototype.isWellFormed on every shape", () => {
		for (const [name, value] of CORPUS) {
			expect(`${name}: ${isWellFormedUtf16(value)}`).toBe(`${name}: ${value.isWellFormed()}`);
		}
	});

	/**
	 * The four ways a surrogate can be wrong, each on its own, so a failure names the branch
	 * rather than just the corpus. The reversed pair is the one a naive implementation misses:
	 * both halves are present and both are surrogates, but they are in the wrong order.
	 */
	it("rejects each way a surrogate can stand alone", () => {
		expect(isWellFormedUtf16("\ud800")).toBe(false);
		expect(isWellFormedUtf16("\udc00")).toBe(false);
		expect(isWellFormedUtf16("\udc00\ud800")).toBe(false);
		expect(isWellFormedUtf16("\ud800a")).toBe(false);
		expect(isWellFormedUtf16("a\ud800")).toBe(false);
	});

	/**
	 * And accepts a real pair, at both ends of the astral range plus in the middle of other
	 * text. Without this the function could return `false` unconditionally and pass every
	 * rejection case above.
	 */
	it("accepts a well-formed pair wherever it sits", () => {
		expect(isWellFormedUtf16("𐀀")).toBe(true);
		expect(isWellFormedUtf16("􏿿")).toBe(true);
		expect(isWellFormedUtf16("a😀z")).toBe(true);
		expect(isWellFormedUtf16("😀😀")).toBe(true);
		expect(isWellFormedUtf16("")).toBe(true);
	});

	/**
	 * The consequence, spelled out: an ill-formed string does not survive an encode/decode
	 * round trip, and a well-formed one does. This is WHY the predicate is a refusal rather
	 * than a warning at every call site, and it would still hold if someone replaced the
	 * implementation with something subtly wrong, so it is the test that states the stake.
	 */
	it("predicts whether a round trip through UTF-8 returns the same string", () => {
		const decoder = new TextDecoder();
		for (const [name, value] of CORPUS) {
			const roundTripped = decoder.decode(encoder.encode(value));
			expect(`${name}: ${roundTripped === value}`).toBe(`${name}: ${isWellFormedUtf16(value)}`);
		}
	});
});
