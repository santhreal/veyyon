/**
 * Generative property suite for the URL string primitives in `src/url.ts` — the
 * ONE-PLACE owner every provider/discovery base-URL normalizer imports. The
 * example suite in `url.test.ts` pins named cases; this suite asserts the
 * INVARIANTS those functions must hold over 10k+ generated inputs with
 * shrinking, so an unexplored string cannot break a contract the examples never
 * reached. These are also the behavioral contracts a future Rust port must
 * reproduce byte-for-byte, stated as black-box properties rather than
 * TS-internal calls.
 *
 * Locked invariants:
 * - trimTrailingSlashes: strips exactly the trailing slash run (postcondition:
 *   the result never ends in `/`), is idempotent, preserves a prefix of the
 *   input, and is insensitive to how many trailing slashes were appended.
 * - normalizeBaseUrl: a defined non-empty result is trimmed and slash-free;
 *   blank/whitespace/undefined input returns the fallback unchanged; on any
 *   non-blank input it equals trimTrailingSlashes(input.trim()) exactly.
 * - the scheme predicates form a strict implication hierarchy
 *   (hasUrlScheme ⟹ hasUriScheme, hasUrlScheme ⟹ containsUrlScheme),
 *   urlScheme(x) !== null is the biconditional of hasUrlScheme(x), a resolved
 *   scheme is always lowercase, scheme detection is case-insensitive, and every
 *   predicate is stateless across repeated calls (the regexes are non-global, so
 *   a `.test`/`.exec` must never drift `lastIndex`).
 *
 * Any shrunk counterexample surfaced here is a real contract break: fix the
 * owner or, if the behavior is intended, add the case to `url.test.ts` as a
 * named example. Never weaken a property to make it pass (Law 6, Law 9).
 */
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
	containsUrlScheme,
	hasUriScheme,
	hasUrlScheme,
	normalizeBaseUrl,
	trimTrailingSlashes,
	urlScheme,
} from "../src/url";

const RUNS = { numRuns: 10_000 } as const;

/** A syntactically valid RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ). */
const schemeArb: fc.Arbitrary<string> = fc
	.tuple(
		fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")),
		fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789+-.".split("")), maxLength: 12 }),
	)
	.map(([head, tail]) => head + tail);

/** Authority/path remainder after `scheme://`; never contains a line terminator. */
const restArb: fc.Arbitrary<string> = fc.string({ maxLength: 40 }).map(s => s.replace(/[\r\n]/g, "x"));

describe("trimTrailingSlashes properties", () => {
	it("result never ends in a slash, for any input", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 60 }), s => {
				expect(trimTrailingSlashes(s).endsWith("/")).toBe(false);
			}),
			RUNS,
		);
	});

	it("is idempotent (f(f(x)) === f(x))", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 60 }), s => {
				const once = trimTrailingSlashes(s);
				expect(trimTrailingSlashes(once)).toBe(once);
			}),
			RUNS,
		);
	});

	it("removes only a suffix of slashes (result + stripped-slashes === input)", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 60 }), s => {
				const trimmed = trimTrailingSlashes(s);
				expect(s.startsWith(trimmed)).toBe(true);
				const removed = s.slice(trimmed.length);
				expect(removed).toBe("/".repeat(removed.length));
				expect(trimmed + removed).toBe(s);
			}),
			RUNS,
		);
	});

	it("is insensitive to how many trailing slashes are appended", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), fc.nat({ max: 8 }), (s, k) => {
				expect(trimTrailingSlashes(s + "/".repeat(k))).toBe(trimTrailingSlashes(s));
			}),
			RUNS,
		);
	});

	it("leaves a slashless string untouched", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 40 }).filter(s => !s.endsWith("/")),
				s => {
					expect(trimTrailingSlashes(s)).toBe(s);
				},
			),
			RUNS,
		);
	});
});

describe("normalizeBaseUrl properties", () => {
	/** Whether `x?.trim()` is a non-empty string, i.e. normalizeBaseUrl computes a
	 * value rather than returning the fallback. */
	const isNonBlank = (x: string | undefined): boolean => typeof x === "string" && x.trim().length > 0;

	it("on non-blank input, the result is trimmed, slash-free, and a content-prefix of input.trim()", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 20 }), (input, fb) => {
				const r = normalizeBaseUrl(input, fb);
				if (!isNonBlank(input)) return;
				// A computed result is always a string here.
				expect(typeof r).toBe("string");
				const result = r as string;
				// Fully normalized: no surrounding whitespace, no trailing slash.
				expect(result).toBe(result.trim());
				expect(result.endsWith("/")).toBe(false);
				// Content-preserving: it is a prefix of the trimmed input, and the only
				// thing removed from the tail is slashes and whitespace.
				const core = input.trim();
				expect(core.startsWith(result)).toBe(true);
				expect(/^[/\s]*$/.test(core.slice(result.length))).toBe(true);
			}),
			RUNS,
		);
	});

	it("is insensitive to a trailing mix of slashes and whitespace", () => {
		// Core ends in a character that is neither slash nor whitespace, so any
		// trailing slash/space run appended to it is exactly what normalization
		// removes: normalizeBaseUrl(core + junk) === normalizeBaseUrl(core).
		const coreArb = fc
			.string({ minLength: 1, maxLength: 30 })
			.map(s => s.replace(/[\r\n]/g, "x"))
			.filter(s => /[^/\s]$/.test(s) && /^\S/.test(s));
		const junkArb = fc.string({ unit: fc.constantFrom("/", " ", "\t"), maxLength: 8 });
		fc.assert(
			fc.property(coreArb, junkArb, (core, junk) => {
				expect(normalizeBaseUrl(core + junk, "")).toBe(normalizeBaseUrl(core, ""));
			}),
			RUNS,
		);
	});

	it("returns the fallback unchanged for blank, whitespace-only, or undefined input", () => {
		const blankArb = fc.oneof(
			fc.constant(undefined),
			fc.constant(""),
			fc.string({ unit: fc.constantFrom(" ", "\t", "\n", "\r"), minLength: 1, maxLength: 6 }),
		);
		fc.assert(
			fc.property(blankArb, fc.string({ maxLength: 20 }), (blank, fb) => {
				expect(normalizeBaseUrl(blank, fb)).toBe(fb);
			}),
			RUNS,
		);
	});

	it("is idempotent: normalizing an already-normalized value returns it unchanged", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), input => {
				const once = normalizeBaseUrl(input, "");
				if (once.length === 0) return;
				expect(normalizeBaseUrl(once, "")).toBe(once);
			}),
			RUNS,
		);
	});
});

describe("scheme predicate properties", () => {
	const anyStringArb = fc.string({ maxLength: 50 });

	it("hasUrlScheme(x) implies hasUriScheme(x)", () => {
		fc.assert(
			fc.property(anyStringArb, s => {
				if (hasUrlScheme(s)) expect(hasUriScheme(s)).toBe(true);
			}),
			RUNS,
		);
	});

	it("hasUrlScheme(x) implies containsUrlScheme(x)", () => {
		fc.assert(
			fc.property(anyStringArb, s => {
				if (hasUrlScheme(s)) expect(containsUrlScheme(s)).toBe(true);
			}),
			RUNS,
		);
	});

	it("urlScheme(x) !== null is the biconditional of hasUrlScheme(x)", () => {
		fc.assert(
			fc.property(anyStringArb, s => {
				expect(urlScheme(s) !== null).toBe(hasUrlScheme(s));
			}),
			RUNS,
		);
	});

	it("a resolved scheme is always lowercase", () => {
		fc.assert(
			fc.property(anyStringArb, s => {
				const scheme = urlScheme(s);
				if (scheme !== null) expect(scheme).toBe(scheme.toLowerCase());
			}),
			RUNS,
		);
	});

	it("round-trips a generated scheme://rest: predicates true, scheme lowercased", () => {
		fc.assert(
			fc.property(schemeArb, restArb, (scheme, rest) => {
				const url = `${scheme}://${rest}`;
				expect(hasUrlScheme(url)).toBe(true);
				expect(hasUriScheme(url)).toBe(true);
				expect(containsUrlScheme(url)).toBe(true);
				expect(urlScheme(url)).toBe(scheme.toLowerCase());
			}),
			RUNS,
		);
	});

	it("scheme detection is case-insensitive", () => {
		fc.assert(
			fc.property(schemeArb, restArb, (scheme, rest) => {
				const upper = `${scheme.toUpperCase()}://${rest}`;
				expect(hasUrlScheme(upper)).toBe(true);
				expect(urlScheme(upper)).toBe(scheme.toLowerCase());
			}),
			RUNS,
		);
	});

	it("every predicate is stateless across repeated calls (non-global regexes)", () => {
		fc.assert(
			fc.property(anyStringArb, s => {
				expect(hasUrlScheme(s)).toBe(hasUrlScheme(s));
				expect(hasUriScheme(s)).toBe(hasUriScheme(s));
				expect(containsUrlScheme(s)).toBe(containsUrlScheme(s));
				expect(urlScheme(s)).toBe(urlScheme(s));
			}),
			RUNS,
		);
	});

	it("rejects a scheme that starts with a digit or is otherwise malformed at the prefix", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(..."0123456789+-.".split("")),
				fc.string({ unit: fc.constantFrom(..."abc0123456789".split("")), maxLength: 6 }),
				restArb,
				(badHead, tail, rest) => {
					// A scheme must start with ALPHA; a leading digit/`+`/`-`/`.` is not a
					// valid `scheme://` prefix, so hasUrlScheme is false at the anchor.
					const url = `${badHead}${tail}://${rest}`;
					expect(hasUrlScheme(url)).toBe(false);
					expect(urlScheme(url)).toBeNull();
				},
			),
			RUNS,
		);
	});
});
