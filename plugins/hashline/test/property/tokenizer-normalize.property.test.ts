/**
 * Generative property suite (TS-SUITE-4) for the hashline tokenizer/normalize
 * boundary — the invariants a Rust port must reproduce, asserted over 10k+
 * generated cases with shrinking instead of a handful of examples:
 *
 * - splitHashlineLines is LOSSLESS for LF-joined content (join(split) round
 *   trips) and line-count-stable for arbitrary content;
 * - normalizeToLF is IDEMPOTENT, produces no CR bytes, and preserves line
 *   content under every CR/CRLF/LF mixture;
 * - restoreLineEndings(normalizeToLF(x), detectLineEnding(x)) round-trips any
 *   single-style document byte-exactly;
 * - stripBom splits losslessly (bom + text === input) and is idempotent;
 * - parseLid accepts exactly the canonical decimal renderings it should and
 *   round-trips every positive safe integer.
 *
 * Any shrunk counterexample found here must be frozen as a named vector via
 * scripts/record-conformance.ts so it can never regress (TS-SUITE-3).
 */
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../../src/normalize";
import { parseLid, splitHashlineLines } from "../../src/tokenizer";

const RUNS = { numRuns: 10_000 } as const;

/** Line content: printable-ish text with no line terminators of any kind. */
const lineArb = fc.string({ maxLength: 40 }).map(s => s.replace(/[\r\n]/g, "x"));

/** Line content that is never empty, for properties where an empty final
 * line would collide with the terminator-style trailing-LF collapse. */
const nonEmptyLineArb = fc.string({ minLength: 1, maxLength: 40 }).map(s => s.replace(/[\r\n]/g, "x"));

/** A document whose FINAL line is non-empty: splitHashlineLines is
 * terminator-style ("a\n" is one line), so a trailing empty line is by
 * design indistinguishable from a trailing terminator — the lossless
 * round-trip invariant holds exactly on this domain. */
const lfDocArb = fc.tuple(fc.array(lineArb, { maxLength: 19 }), nonEmptyLineArb).map(([init, last]) => [...init, last]);

describe("splitHashlineLines properties", () => {
	it("round-trips LF-joined content losslessly (join(split(x)) === x)", () => {
		fc.assert(
			fc.property(lfDocArb, lines => {
				const text = lines.join("\n");
				expect(splitHashlineLines(text).join("\n")).toBe(text);
			}),
			RUNS,
		);
	});

	it("splits a CRLF document into exactly the source lines (CR never leaks into a line)", () => {
		fc.assert(
			fc.property(
				fc.tuple(fc.array(lineArb, { maxLength: 19 }), nonEmptyLineArb).map(([init, last]) => [...init, last]),
				lines => {
					const split = splitHashlineLines(lines.join("\r\n"));
					expect(split).toEqual(lines);
				},
			),
			RUNS,
		);
	});

	it("never returns zero lines and never returns a line containing LF", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), text => {
				const lines = splitHashlineLines(text);
				expect(lines.length).toBeGreaterThan(0);
				for (const line of lines) expect(line.includes("\n")).toBe(false);
			}),
			RUNS,
		);
	});
});

describe("normalizeToLF properties", () => {
	it("is idempotent and leaves no CR byte behind", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), text => {
				const once = normalizeToLF(text);
				expect(once.includes("\r")).toBe(false);
				expect(normalizeToLF(once)).toBe(once);
			}),
			RUNS,
		);
	});

	it("preserves line CONTENT for documents built from any per-boundary ending mix", () => {
		// Lines must be non-empty: a bare-CR boundary directly followed by an
		// empty line and an LF boundary forms the byte pair CR LF, which IS one
		// CRLF ending by definition — the shrunk counterexample "\n\r\n\n" is
		// frozen as a conformance vector (TS-SUITE-3), not a bug.
		const endingArb = fc.constantFrom("\n", "\r\n", "\r");
		fc.assert(
			fc.property(
				fc.array(nonEmptyLineArb, { minLength: 1, maxLength: 12 }),
				fc.array(endingArb, { minLength: 11, maxLength: 11 }),
				(lines, endings) => {
					let text = "";
					lines.forEach((line, i) => {
						text += line;
						if (i < lines.length - 1) text += endings[i] ?? "\n";
					});
					expect(normalizeToLF(text)).toBe(lines.join("\n"));
				},
			),
			RUNS,
		);
	});
});

describe("line-ending round-trip properties", () => {
	it("restore(normalize(x), detect(x)) is byte-identity for any single-style document", () => {
		const styleArb = fc.constantFrom<"\n" | "\r\n">("\n", "\r\n");
		fc.assert(
			fc.property(
				fc.array(lineArb, { minLength: 1, maxLength: 15 }),
				styleArb,
				fc.boolean(),
				(lines, style, trailing) => {
					const text = lines.join(style) + (trailing ? style : "");
					expect(restoreLineEndings(normalizeToLF(text), detectLineEnding(text))).toBe(text);
				},
			),
			RUNS,
		);
	});
});

describe("stripBom properties", () => {
	it("splits losslessly (bom + text === input) and is idempotent on the text", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 100 }), fc.boolean(), (body, withBom) => {
				const input = withBom ? `﻿${body}` : body;
				const result = stripBom(input);
				expect(result.bom + result.text).toBe(input);
				// Stripping again removes nothing more unless the body itself
				// started with a second BOM — then exactly one more comes off.
				const again = stripBom(result.text);
				expect(again.bom === "" || result.text.startsWith("﻿")).toBe(true);
			}),
			RUNS,
		);
	});
});

describe("parseLid properties", () => {
	it("round-trips every positive safe integer's canonical decimal rendering", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), value => {
				expect(parseLid(String(value), 1)).toEqual({ line: value });
			}),
			RUNS,
		);
	});

	it("tolerates ASCII space/tab padding without changing the parsed line", () => {
		const padArb = fc.string({ unit: fc.constantFrom(" ", "\t"), maxLength: 4 });
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 1_000_000 }), padArb, padArb, (value, left, right) => {
				expect(parseLid(`${left}${value}${right}`, 1)).toEqual({ line: value });
			}),
			RUNS,
		);
	});

	it("rejects every non-canonical decimal rendering (leading zeros, signs, suffixes)", () => {
		const badArb = fc.oneof(
			fc.integer({ min: 1, max: 99999 }).map(n => `0${n}`),
			fc.integer({ min: 1, max: 99999 }).map(n => `-${n}`),
			fc.integer({ min: 1, max: 99999 }).map(n => `+${n}`),
			fc
				.tuple(fc.integer({ min: 1, max: 9999 }), fc.constantFrom("x", ".", "e", "_", "a"))
				.map(([n, c]) => `${n}${c}`),
		);
		fc.assert(
			fc.property(badArb, raw => {
				expect(() => parseLid(raw, 1)).toThrow("expected a line number");
			}),
			RUNS,
		);
	});
});
