/**
 * Regression + property coverage for a tool-argument over-coercion bug in
 * `validateToolArguments` (`src/utils/validation.ts`).
 *
 * THE BUG: the pre-validation `normalizeOptionalNullsForSchema` pass rescues a
 * numeric STRING into a number for a schema branch that declares `number` /
 * `integer` — a repair meant for `number | null` (wire
 * `anyOf:[{type:"number"},{type:"null"}]`) receiving "123", where neither branch
 * accepts the raw string so validation would otherwise fail. But `normalizeAnyOfLike`
 * applied that coercion to ANY union with a number branch, INCLUDING
 * `string | number`, whose string branch already accepts "123" verbatim. The
 * result: a `string | number` field receiving the quoted numeric string "123"
 * came back as the number 123 — a value that already satisfied its schema was
 * silently mutated, changing its type and destroying data ("007" -> 7,
 * "  5  " -> 5, "1.5" -> 1.5).
 *
 * THE CONTRACT these tests lock: a value that already validates against its
 * schema is returned UNCHANGED. Coercion passes exist to rescue values that would
 * otherwise fail; they must never touch a value that already passes. The fix adds
 * a guard in `normalizeAnyOfLike` that returns the raw value untouched when it
 * already matches any union branch, while leaving the genuine `number | null <-
 * "123"` coercion (matches no branch raw) intact.
 *
 * The property suite is the first fast-check suite in `@veyyon/ai`. A shrunk
 * counterexample is a real defect: fix the owner, never weaken the property
 * (Law 6, Law 9). No `!is_empty` shape checks — every assertion is on the exact
 * returned value.
 */
import { describe, expect, it } from "bun:test";
import type { Tool, ToolCall } from "@veyyon/ai/types";
import { validateToolArguments } from "@veyyon/ai/utils/validation";
import fc from "fast-check";
import { z } from "zod/v4";

const RUNS = { numRuns: 10_000 } as const;

function validate(parameters: z.ZodType, args: unknown): unknown {
	const tool: Tool = { name: "t", description: "", parameters };
	const toolCall: ToolCall = { type: "toolCall", id: "call-1", name: "t", arguments: args as ToolCall["arguments"] };
	return validateToolArguments(tool, toolCall);
}

describe("tool-argument union over-coercion — named regressions", () => {
	// The exact reported class: string | number must keep a quoted numeric string
	// as a string, because the string branch already accepts it.
	it("keeps a quoted numeric string as a string for a string|number field", () => {
		expect(validate(z.object({ f: z.union([z.string(), z.number()]) }), { f: "123" })).toEqual({ f: "123" });
	});

	it("preserves leading zeros (no lossy Number() coercion) for string|number", () => {
		// "007" -> 7 would be irreversible data loss (zip codes, ids, versions).
		expect(validate(z.object({ f: z.union([z.string(), z.number()]) }), { f: "007" })).toEqual({ f: "007" });
	});

	it("preserves a decimal string form for string|number", () => {
		expect(validate(z.object({ f: z.union([z.string(), z.number()]) }), { f: "1.5" })).toEqual({ f: "1.5" });
	});

	it("preserves surrounding whitespace in a string for string|number", () => {
		expect(validate(z.object({ f: z.union([z.string(), z.number()]) }), { f: "  5  " })).toEqual({ f: "  5  " });
	});

	it("preserves a signed/exponent numeric string for number|string (branch order reversed)", () => {
		expect(validate(z.object({ f: z.union([z.number(), z.string()]) }), { f: "-1e3" })).toEqual({ f: "-1e3" });
	});

	it("keeps an actual number as a number for string|number", () => {
		expect(validate(z.object({ f: z.union([z.string(), z.number()]) }), { f: 42 })).toEqual({ f: 42 });
	});

	// The intended coercion must SURVIVE the fix: number | null (nullable number)
	// receiving a numeric string matches neither branch raw, so it is still healed
	// to a real number.
	it("still coerces a numeric string to a number for a nullable number field", () => {
		expect(validate(z.object({ f: z.number().nullable() }), { f: "123" })).toEqual({ f: 123 });
	});

	it("still coerces a numeric string to a number for a plain number field", () => {
		expect(validate(z.object({ f: z.number() }), { f: "300" })).toEqual({ f: 300 });
	});

	it("keeps a numeric string as a string for a plain string field", () => {
		expect(validate(z.object({ f: z.string() }), { f: "300" })).toEqual({ f: "300" });
	});
});

/** Numeric-looking strings — exactly the values the number branch would swallow. */
const numericStringArb: fc.Arbitrary<string> = fc.oneof(
	fc.integer({ min: -99_999, max: 99_999 }).map(String),
	fc.integer({ min: 0, max: 9_999 }).map(n => `00${n}`), // leading zeros
	fc.float({ noNaN: true, noDefaultInfinity: true }).filter(Number.isFinite).map(String),
	fc.constantFrom("1e3", "-2E4", "0.0", "+7", "1_", " 5 "),
);

describe("tool-argument union over-coercion — properties", () => {
	it("string|number keeps EVERY numeric string as a string (never coerces)", () => {
		fc.assert(
			fc.property(numericStringArb, s => {
				expect(validate(z.object({ f: z.union([z.string(), z.number()]) }), { f: s })).toEqual({ f: s });
			}),
			RUNS,
		);
	});

	it("string|number keeps EVERY real number as that number", () => {
		fc.assert(
			fc.property(fc.oneof(fc.integer(), fc.float({ noNaN: true, noDefaultInfinity: true }).filter(Number.isFinite)), n => {
				expect(validate(z.object({ f: z.union([z.string(), z.number()]) }), { f: n })).toEqual({ f: n });
			}),
			RUNS,
		);
	});

	it("string|boolean keeps EVERY boolean-looking string as a string (never coerces)", () => {
		fc.assert(
			fc.property(fc.constantFrom("true", "false", "yes", "no", "on", "off", "1", "0"), s => {
				expect(validate(z.object({ f: z.union([z.string(), z.boolean()]) }), { f: s })).toEqual({ f: s });
			}),
			RUNS,
		);
	});

	// The general contract: an object whose fields ALREADY satisfy a clean scalar
	// schema is returned deeply unchanged — no normalization pass may touch an
	// already-valid argument set. Field names are neutral (p0, p1, …) so the
	// identifier-whitespace pass never applies, and string values carry no edge
	// whitespace so nothing is trimmable.
	const cleanStringArb = fc.string({ maxLength: 40 }).filter(s => s === s.trim() && !/[\r\n]/.test(s));
	type FieldSpec = { zod: z.ZodType; value: unknown };
	const fieldSpecArb: fc.Arbitrary<FieldSpec> = fc.oneof(
		cleanStringArb.map(value => ({ zod: z.string() as z.ZodType, value })),
		fc.integer().map(value => ({ zod: z.number().int() as z.ZodType, value })),
		fc.float({ noNaN: true, noDefaultInfinity: true }).filter(Number.isFinite).map(value => ({
			zod: z.number() as z.ZodType,
			value,
		})),
		fc.boolean().map(value => ({ zod: z.boolean() as z.ZodType, value })),
		// The fixed path, mixed into whole-object generation:
		numericStringArb.map(value => ({ zod: z.union([z.string(), z.number()]) as z.ZodType, value })),
		cleanStringArb.map(value => ({ zod: z.union([z.string(), z.number()]) as z.ZodType, value })),
	);

	it("returns an already-valid clean-schema argument object deeply unchanged", () => {
		fc.assert(
			fc.property(fc.array(fieldSpecArb, { minLength: 1, maxLength: 6 }), specs => {
				const shape: Record<string, z.ZodType> = {};
				const args: Record<string, unknown> = {};
				specs.forEach((spec, i) => {
					const key = `p${i}`;
					shape[key] = spec.zod;
					args[key] = spec.value;
				});
				const expected = structuredClone(args);
				expect(validate(z.object(shape), args)).toEqual(expected);
			}),
			{ numRuns: 5_000 },
		);
	});
});
