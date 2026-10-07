/**
 * The pre-validation repairs `validateToolArguments` applies (an omitted null or `"null"`
 * placeholder, an omitted empty string the schema rejects, a declared default for a required
 * null, a parsed numeric string, a trimmed enum or `const` string) hold for an object no matter
 * which combinator keyword wraps it, and two repairs from different passes compose inside one
 * union branch.
 *
 * The class this closes: a repair walked through `anyOf` but not `oneOf` or `allOf`; a union
 * rewrite that discarded a branch's partial repair because that branch still rejected the value
 * a later pass would finish; a repair that wrote into the caller's arguments; and a call that
 * still fails whose error echoed only the original arguments although a repair changed them.
 * Every cell checks the caller's arguments are untouched, and that the failing twin (the same
 * arguments without a required field) echoes the repaired form beside the original. Inside a
 * union an enum trim applies only when it makes a branch accept the value, so the failing twin
 * echoes an enum string inside a union untrimmed.
 *
 * Not covered: a combinator nested inside another combinator, `not` and `if`/`then`/`else`
 * (no pass walks them), and a repair added without a row in REPAIRS.
 */
import { describe, expect, it } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import type { Tool, ToolCall } from "@veyyon/ai/types";
import { validateToolArguments } from "@veyyon/ai/utils/validation";

const OMITTED = Symbol("omitted");

interface Repair {
	name: string;
	/** The normalization pass that applies the repair. */
	pass: "placeholder" | "enum";
	key: string;
	schema: Record<string, unknown>;
	required: boolean;
	raw: unknown;
	repaired: unknown;
}

const REPAIRS: readonly Repair[] = [
	{
		name: "an optional null placeholder is omitted",
		pass: "placeholder",
		key: "limit",
		schema: { type: "number" },
		required: false,
		raw: null,
		repaired: OMITTED,
	},
	{
		name: 'an optional "null" placeholder is omitted',
		pass: "placeholder",
		key: "depth",
		schema: { type: "integer" },
		required: false,
		raw: "null",
		repaired: OMITTED,
	},
	{
		name: "an optional empty string the schema rejects is omitted",
		pass: "placeholder",
		key: "flavor",
		schema: { type: "string", enum: ["sweet", "sour"] },
		required: false,
		raw: "",
		repaired: OMITTED,
	},
	{
		name: "a required null takes the declared default",
		pass: "placeholder",
		key: "retries",
		schema: { type: "integer", default: 3 },
		required: true,
		raw: null,
		repaired: 3,
	},
	{
		name: "a numeric string under a number type is parsed",
		pass: "placeholder",
		key: "timeout",
		schema: { type: "number" },
		required: true,
		raw: "2.5",
		repaired: 2.5,
	},
	{
		name: "an enum member with surrounding whitespace is trimmed",
		pass: "enum",
		key: "speed",
		schema: { type: "string", enum: ["fast", "slow"] },
		required: true,
		raw: " fast\n",
		repaired: "fast",
	},
	{
		name: "a const value with surrounding whitespace is trimmed",
		pass: "enum",
		key: "kind",
		schema: { const: "fixed" },
		required: true,
		raw: "fixed ",
		repaired: "fixed",
	},
];

interface Wrapper {
	wrap: (schema: Record<string, unknown>) => Record<string, unknown>;
	/** Whether the wrapper is a union (`anyOf` / `oneOf`). */
	union: boolean;
}

/** An object branch no repair can satisfy: the arguments never hold `other`. */
const REJECTING_BRANCH = { type: "object", properties: { other: { type: "string" } }, required: ["other"] };

const WRAPPERS: Record<string, Wrapper> = {
	"no combinator": { wrap: schema => schema, union: false },
	anyOf: { wrap: schema => ({ anyOf: [schema] }), union: true },
	oneOf: { wrap: schema => ({ oneOf: [schema] }), union: true },
	allOf: { wrap: schema => ({ allOf: [schema] }), union: false },
	"anyOf after a rejecting branch": { wrap: schema => ({ anyOf: [REJECTING_BRANCH, schema] }), union: true },
	"oneOf after a rejecting branch": { wrap: schema => ({ oneOf: [REJECTING_BRANCH, schema] }), union: true },
};

/** Every single repair, then every pair of a placeholder-pass repair with an enum-pass repair. */
const REPAIR_SETS: readonly (readonly Repair[])[] = [
	...REPAIRS.map(repair => [repair]),
	...REPAIRS.filter(first => first.pass === "placeholder").flatMap(first =>
		REPAIRS.filter(second => second.pass === "enum").map(second => [first, second]),
	),
];

function toolFor(repairs: readonly Repair[], wrap: (schema: Record<string, unknown>) => Record<string, unknown>): Tool {
	const box = {
		type: "object",
		properties: {
			id: { type: "string" },
			...Object.fromEntries(repairs.map(repair => [repair.key, repair.schema])),
		},
		required: ["id", ...repairs.filter(repair => repair.required).map(repair => repair.key)],
	};
	const parameters = { type: "object", properties: { box: wrap(box) }, required: ["box"] };
	return { name: "repair", description: "", parameters: parameters as unknown as Tool["parameters"] };
}

function boxArgs(repairs: readonly Repair[], pick: (repair: Repair) => unknown): Record<string, unknown> {
	const box: Record<string, unknown> = { id: "k" };
	for (const repair of repairs) {
		const value = pick(repair);
		if (value !== OMITTED) box[repair.key] = value;
	}
	return box;
}

function call(tool: Tool, args: Record<string, unknown>): unknown {
	const toolCall: ToolCall = { type: "toolCall", id: "c", name: tool.name, arguments: args };
	return validateToolArguments(tool, toolCall);
}

/** The arguments echo of the error a failing call throws. */
function receivedArguments(run: () => unknown): unknown {
	let message = "";
	try {
		run();
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	const marker = "Received arguments:\n";
	const at = message.indexOf(marker);
	expect(at).toBeGreaterThan(-1);
	return JSON.parse(message.slice(at + marker.length));
}

for (const [wrapperName, { wrap, union }] of Object.entries(WRAPPERS)) {
	describe(`schema repairs under ${wrapperName}`, () => {
		for (const repairs of REPAIR_SETS) {
			const label = repairs.map(repair => repair.name).join(", and ");
			const tool = toolFor(repairs, wrap);

			it(`${label}, without writing into the caller's arguments`, () => {
				const args = { box: boxArgs(repairs, repair => repair.raw) };
				const before = structuredClone(args);
				expect(call(tool, args)).toEqual({ box: boxArgs(repairs, repair => repair.repaired) });
				expect(args).toEqual(before);
			});

			it(`${label}, and a call that still fails echoes the repaired form`, () => {
				const { id: _raw, ...original } = boxArgs(repairs, repair => repair.raw);
				const { id: _repaired, ...normalized } = boxArgs(repairs, repair =>
					union && repair.pass === "enum" ? repair.raw : repair.repaired,
				);
				const args = { box: original };
				const before = structuredClone(args);
				const echo = isDeepStrictEqual(normalized, original)
					? { box: original }
					: { original: { box: original }, normalized: { box: normalized } };
				expect(receivedArguments(() => call(tool, args))).toEqual(echo);
				expect(args).toEqual(before);
			});
		}
	});
}
