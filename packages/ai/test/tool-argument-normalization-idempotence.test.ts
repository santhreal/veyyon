/**
 * The GLOBAL idempotence invariant for `validateToolArguments`
 * (`src/utils/validation.ts`): a tool-argument value that ALREADY satisfies its
 * schema must be returned deeply unchanged.
 *
 * WHY THIS SUITE EXISTS. `validateToolArguments` runs a stack of pre-validation
 * normalization passes (double-encoded keys, optional-null stripping, enum
 * whitespace, identifier whitespace, string-encoded array unions, single-string
 * adoption) BEFORE it ever calls the schema validator, then issue-driven
 * coercion passes AFTER a failure. Every one of those passes exists to RESCUE a
 * value that would otherwise fail. None of them may touch a value that already
 * passes. That is not guaranteed by the pipeline's structure — it is an emergent
 * property each pass must individually uphold, and it has been violated before:
 * the `string | number` over-coercion bug (see
 * `tool-argument-union-no-overcoerce.test.ts`) was exactly one pass mutating an
 * already-valid value ("123" -> 123, "007" -> 7). That fix patched one pass;
 * this suite locks the invariant across the WHOLE stack, over nested objects,
 * arrays, enums, optionals, nullables, and multi-branch unions — the recursive
 * surfaces the flat-scalar property in the sibling suite never exercised. A
 * future over-coercion in ANY pass, at ANY depth, breaks a property here.
 *
 * WHAT IT STEERS AROUND. A few passes deliberately mutate a technically-valid
 * value as an intended repair, so the generators avoid ONLY those triggers (a
 * red here is therefore always a real defect, never an intended repair):
 *   - identifier-whitespace trim fires on keys like `path`/`url`/`title` with a
 *     trailing newline -> keys are neutral `p0..pN`, strings carry no `\r\n`.
 *   - enum-whitespace trim fires when a trimmed string matches an enum member and
 *     the raw does not -> enum values are emitted verbatim (already matching).
 *   - string-encoded-array unwrap fires on a `[`-prefixed string under a
 *     `string | array` schema -> generated strings never start with `[` or `{`.
 *   - double-encoded-key rename fires on quote-wrapped keys -> keys are plain.
 *   - optional-null stripping removes null / "null" / "" from optional fields ->
 *     optional and nullable fields are always populated with a real value.
 *
 * Assertions are exact deep-equality against a pre-call `structuredClone` (Law
 * 6). A shrunk counterexample is a real bug: fix the offending pass, never
 * weaken the property (Law 9).
 */
import { describe, expect, it } from "bun:test";
import type { Tool, ToolCall } from "@veyyon/ai/types";
import { validateToolArguments } from "@veyyon/ai/utils/validation";
import fc from "fast-check";
import { z } from "zod/v4";

function validate(parameters: z.ZodType, args: unknown): unknown {
	const tool: Tool = { name: "t", description: "", parameters };
	const toolCall: ToolCall = { type: "toolCall", id: "call-1", name: "t", arguments: args as ToolCall["arguments"] };
	return validateToolArguments(tool, toolCall);
}

/** Round-trips `args` through validation and asserts it comes back deeply identical. */
function expectUnchanged(parameters: z.ZodType, args: Record<string, unknown>): void {
	const expected = structuredClone(args);
	expect(validate(parameters, args)).toEqual(expected);
}

// A string that trips none of the intended repairs: trimmed on both ends, no
// line terminators, and not the leading `[` / `{` that the string-encoded
// container passes look for. Numeric-looking content is allowed on purpose —
// under a plain `string` schema a numeric string must survive verbatim.
const cleanStringArb = fc
	.string({ maxLength: 24 })
	.filter(s => s === s.trim() && !/[\r\n]/.test(s) && !s.startsWith("[") && !s.startsWith("{"));

const finiteFloatArb = fc.float({ noNaN: true, noDefaultInfinity: true }).filter(Number.isFinite);

const ENUM_MEMBERS = ["read", "write", "append", "delete"] as const;

type Node = { zod: z.ZodType; value: unknown };

// A scalar (schema, matching-value) pair. Each variant produces a value that
// already validates against its own schema with no repair needed.
const scalarNodeArb: fc.Arbitrary<Node> = fc.oneof(
	cleanStringArb.map(value => ({ zod: z.string() as z.ZodType, value })),
	fc.integer().map(value => ({ zod: z.number().int() as z.ZodType, value })),
	finiteFloatArb.map(value => ({ zod: z.number() as z.ZodType, value })),
	fc.boolean().map(value => ({ zod: z.boolean() as z.ZodType, value })),
	// Enum member emitted verbatim — must not be whitespace-normalized or dropped.
	fc.constantFrom(...ENUM_MEMBERS).map(value => ({
		zod: z.enum(ENUM_MEMBERS) as unknown as z.ZodType,
		value,
	})),
	// The historically-buggy union, with the value on EITHER branch. A clean
	// string (incl. numeric-looking) stays a string; a real number stays a number.
	cleanStringArb.map(value => ({ zod: z.union([z.string(), z.number()]) as z.ZodType, value })),
	fc.integer().map(value => ({ zod: z.union([z.string(), z.number()]) as z.ZodType, value })),
	// A three-branch union resolved to its boolean branch.
	fc.boolean().map(value => ({ zod: z.union([z.string(), z.number(), z.boolean()]) as z.ZodType, value })),
);

// A (schema, matching-value) pair at bounded depth. At depth 0 only scalars are
// produced; deeper levels add objects and arrays so every pass's recursion is
// exercised on already-valid data.
function nodeArb(depth: number): fc.Arbitrary<Node> {
	if (depth <= 0) return scalarNodeArb;
	const child = () => nodeArb(depth - 1);
	return fc.oneof(
		{ weight: 3, arbitrary: scalarNodeArb },
		{
			weight: 2,
			arbitrary: fc.array(child(), { minLength: 1, maxLength: 4 }).map(children => {
				const shape: Record<string, z.ZodType> = {};
				const value: Record<string, unknown> = {};
				children.forEach((node, i) => {
					shape[`p${i}`] = node.zod;
					value[`p${i}`] = node.value;
				});
				return { zod: z.object(shape) as z.ZodType, value };
			}),
		},
		{
			// Homogeneous array: one element schema, several matching values.
			weight: 2,
			arbitrary: child().chain(elem =>
				fc.array(fc.constant(elem.value), { minLength: 0, maxLength: 4 }).map(items => ({
					zod: z.array(elem.zod) as z.ZodType,
					value: items,
				})),
			),
		},
	);
}

describe("validateToolArguments — global idempotence on already-valid input", () => {
	it("returns a deeply-nested already-valid argument tree unchanged (10k trees)", () => {
		fc.assert(
			fc.property(fc.array(nodeArb(3), { minLength: 1, maxLength: 5 }), fields => {
				const shape: Record<string, z.ZodType> = {};
				const args: Record<string, unknown> = {};
				fields.forEach((node, i) => {
					shape[`p${i}`] = node.zod;
					args[`p${i}`] = node.value;
				});
				expectUnchanged(z.object(shape), args);
			}),
			{ numRuns: 10_000 },
		);
	});

	it("keeps an enum member verbatim at every array index (no drop, no trim)", () => {
		fc.assert(
			fc.property(fc.array(fc.constantFrom(...ENUM_MEMBERS), { minLength: 1, maxLength: 8 }), members => {
				expectUnchanged(z.object({ ops: z.array(z.enum(ENUM_MEMBERS)) }), { ops: members });
			}),
			{ numRuns: 5_000 },
		);
	});

	it("keeps a populated optional and a populated nullable field untouched", () => {
		fc.assert(
			fc.property(finiteFloatArb, cleanStringArb, (n, s) => {
				expectUnchanged(z.object({ opt: z.number().optional(), nul: z.string().nullable() }), { opt: n, nul: s });
			}),
			{ numRuns: 5_000 },
		);
	});
});

describe("validateToolArguments — named nested regressions", () => {
	// The union bug, reproduced one level deep: a numeric string on a nested
	// string|number field must survive the recursive normalizeAnyOfLike walk.
	it("preserves a numeric string on a nested string|number field", () => {
		const schema = z.object({ outer: z.object({ id: z.union([z.string(), z.number()]) }) });
		expectUnchanged(schema, { outer: { id: "007" } });
	});

	// The same bug inside an array element, exercising the array-recursion branch
	// of every pass.
	it("preserves numeric strings across an array of string|number objects", () => {
		const schema = z.object({ rows: z.array(z.object({ v: z.union([z.string(), z.number()]) })) });
		expectUnchanged(schema, { rows: [{ v: "1.50" }, { v: "-0" }, { v: "300" }] });
	});

	// An array whose value is already an array must NOT be re-shaped by the
	// string-encoded-array-union pass (that pass only rescues a `[`-prefixed
	// STRING, never an actual array).
	it("leaves an already-array value for a string|array field unchanged", () => {
		const schema = z.object({ paths: z.union([z.string(), z.array(z.string())]) });
		expectUnchanged(schema, { paths: ["a.ts", "b.ts"] });
	});

	// A plain string field carrying a bracketed, JSON-array-looking value is a
	// STRING and must stay one — but only when the schema does not also accept an
	// array. Verifies the pass keys off the schema, not the string's shape.
	it("keeps a bracket-looking string as a string when the schema is string-only", () => {
		expectUnchanged(z.object({ note: z.string() }), { note: '["not","a","list"]' });
	});

	// An enum value that is already a member must pass through even though a
	// whitespace-padded sibling would be trimmed — proves the trim never fires on
	// an already-matching value.
	it("keeps an already-matching enum value at depth without trimming", () => {
		const schema = z.object({ cfg: z.object({ mode: z.enum(ENUM_MEMBERS) }) });
		expectUnchanged(schema, { cfg: { mode: "append" } });
	});

	// A real number (not a string) on a string|number field stays a number, at
	// depth — the mirror of the string-preservation case.
	it("keeps a real number on a nested string|number field as a number", () => {
		const schema = z.object({ a: z.object({ b: z.object({ n: z.union([z.string(), z.number()]) }) }) });
		expectUnchanged(schema, { a: { b: { n: 42 } } });
	});
});
