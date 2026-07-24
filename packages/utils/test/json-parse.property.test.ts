/**
 * Generative differential suite for the JSON repair/parse owners in
 * `src/json-parse.ts`. The example suites (`json-parse.test.ts`,
 * `json-parse-adversarial.test.ts`, the prototype-pollution suites) pin named
 * cases; this suite asserts the INVARIANTS the repair path must hold over 10k+
 * generated values, with `JSON.parse`/`JSON.stringify` as the reference oracle.
 *
 * The single most important guarantee: the repair path must NEVER corrupt input
 * that was already valid JSON. `repairJson` advertises "returns the input
 * unchanged when no repair is needed" and `parseJsonWithRepair` must agree with
 * the platform parser on every valid document. A repair that silently rewrote a
 * valid value would be exactly the kind of quiet data corruption these tests
 * exist to make impossible. The suite also proves the repair actually does its
 * job (raw control characters inside a string are rescued into parseable JSON),
 * that `repairJson` is total (never throws) and idempotent for arbitrary junk,
 * and that `parseStreamingJson` matches the reference on any complete document.
 *
 * A shrunk counterexample is a real defect: fix the owner, never weaken the
 * property (Law 6, Law 9). No silent skips (Law 10): every generated case is
 * asserted.
 */
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { parseJsonWithRepair, parseStreamingJson, repairJson } from "../src/json-parse";

const RUNS = { numRuns: 10_000 } as const;

describe("repair path preserves valid JSON (differential vs JSON.parse)", () => {
	it("repairJson is a no-op on the output of JSON.stringify", () => {
		fc.assert(
			fc.property(fc.jsonValue(), value => {
				const s = JSON.stringify(value);
				expect(repairJson(s)).toBe(s);
			}),
			RUNS,
		);
	});

	it("parseJsonWithRepair agrees with JSON.parse on every valid document", () => {
		fc.assert(
			fc.property(fc.jsonValue(), value => {
				const s = JSON.stringify(value);
				expect(parseJsonWithRepair(s)).toEqual(JSON.parse(s));
			}),
			RUNS,
		);
	});

	it("parseStreamingJson agrees with JSON.parse on a complete document", () => {
		fc.assert(
			fc.property(fc.jsonValue(), value => {
				const s = JSON.stringify(value);
				expect(parseStreamingJson(s)).toEqual(JSON.parse(s));
			}),
			RUNS,
		);
	});

	it("repairJson keeps a valid document parseable and semantically identical", () => {
		fc.assert(
			fc.property(fc.jsonValue(), value => {
				const s = JSON.stringify(value);
				expect(JSON.parse(repairJson(s))).toEqual(JSON.parse(s));
			}),
			RUNS,
		);
	});
});

describe("repairJson robustness on arbitrary input", () => {
	it("is total: never throws and always returns a string", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 120 }), s => {
				const out = repairJson(s);
				expect(typeof out).toBe("string");
			}),
			RUNS,
		);
	});

	it("is idempotent: repairJson(repairJson(x)) === repairJson(x)", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 120 }), s => {
				const once = repairJson(s);
				expect(repairJson(once)).toBe(once);
			}),
			RUNS,
		);
	});
});

describe("repairJson performs its stated repair", () => {
	// A quoted string body of printable characters (never `"` or `\`, so the only
	// hazard is the raw control chars) with at least one raw control character
	// (cp < 0x20) that `JSON.parse` rejects. repairJson must escape the control
	// chars so the document parses, and the parsed string must equal the original
	// body byte-for-byte.
	const bodyArb = fc
		.array(
			fc.oneof(
				fc.integer({ min: 0x20, max: 0x7e }).filter(cp => cp !== 0x22 && cp !== 0x5c),
				fc.integer({ min: 0x00, max: 0x1f }),
			),
			{ minLength: 1, maxLength: 24 },
		)
		.filter(cps => cps.some(cp => cp < 0x20))
		.map(cps => String.fromCharCode(...cps));

	it("escapes raw control characters inside a string so it parses back unchanged", () => {
		fc.assert(
			fc.property(bodyArb, body => {
				const malformed = `"${body}"`;
				// The raw control char makes the original unparseable...
				expect(() => JSON.parse(malformed)).toThrow();
				// ...and repair rescues it to the exact same string value.
				const repaired = repairJson(malformed);
				expect(JSON.parse(repaired)).toBe(body);
			}),
			RUNS,
		);
	});
});
