/**
 * WHY: the launch endpoint was not the only boundary that cast its JSON body to the interface it
 * documents and used it. `POST /api/experiments`, `PUT /api/experiments/:id` and
 * `POST /api/experiments/:id/arms` did the same, so a misspelled key was dropped in silence, a
 * `role` outside `baseline | variant | ""` was written to the store, and an arm launched from a
 * body nothing had checked.
 *
 * The class this closes is a mutating route whose body reaches the store or the runner unchecked.
 * The sweep reads `SERVER_ROUTES` and `BODY_SPEC_BY_ROUTE` at run time: a mutating route added
 * without an entry fails the first test, so a new endpoint cannot arrive unchecked, and a route
 * that takes no body records that as an explicit null rather than as an absence. Each spec is then
 * swept field by field, so a field added to a spec is checked here without an edit.
 *
 * What it does not catch: whether a value that passes these checks means anything to the operation
 * behind it -- an unregistered `benchmark`, an experiment id with no runs, a resume filter naming
 * an error class that does not exist. Those refusals belong to the runner, the store and the
 * benchmark registry, and are covered where they are decided.
 */
import { describe, expect, test } from "bun:test";
import {
	ADD_ARM_SPEC,
	BODY_SPEC_BY_ROUTE,
	type BodyFieldKind,
	type BodySpec,
	CREATE_EXPERIMENT_SPEC,
	EXPERIMENT_META_UPDATE_SPEC,
	InvalidRequestBodyError,
	LAUNCH_REQUEST_SPEC,
	parseRequestBody,
	RESUME_RUN_SPEC,
	SERVER_ROUTES,
} from "../../engine/store-shapes";

/** A value of the right shape for each kind. */
const VALID: Readonly<Record<BodyFieldKind, unknown>> = {
	string: "docker",
	strings: ["one"],
	count: 2,
	ratio: 1.5,
	boolean: true,
	object: {},
	map: {},
};

/** Values no field of that kind may take. */
const REJECTED: Readonly<Record<BodyFieldKind, readonly unknown[]>> = {
	string: [7, true, ["a"], {}],
	strings: ["one", [""], [3], {}],
	count: ["lots", -5, 0, 1.5],
	ratio: ["fast", 0, -1],
	boolean: ["true", 1, {}],
	object: ["x", 3, ["x"]],
	map: ["x", 3, ["x"]],
};

/** Field values that satisfy a spec's pinned shapes and required fields. */
const SEEDS: Readonly<Record<string, unknown>> = {
	id: "exp1",
	model: "anthropic/claude-sonnet-4-5",
	arm: "baseline",
	role: "variant",
	environment: "docker",
	into: "anthropic/claude-haiku-4-5",
	prewalk: { into: "anthropic/claude-haiku-4-5" },
};

const SPECS: readonly BodySpec<never>[] = [
	LAUNCH_REQUEST_SPEC as BodySpec<never>,
	CREATE_EXPERIMENT_SPEC as BodySpec<never>,
	EXPERIMENT_META_UPDATE_SPEC as BodySpec<never>,
	ADD_ARM_SPEC as BodySpec<never>,
	RESUME_RUN_SPEC as BodySpec<never>,
];

function fieldsOf(spec: BodySpec<never>): Readonly<Record<string, BodyFieldKind>> {
	return spec.fields as Readonly<Record<string, BodyFieldKind>>;
}

/** A body that satisfies the spec: every required field present with a value it accepts. */
function minimalBody(spec: BodySpec<never>): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	for (const field of spec.required ?? []) body[field] = SEEDS[field] ?? VALID[fieldsOf(spec)[field]];
	return body;
}

function refusalFor(body: unknown, spec: BodySpec<never>): string {
	try {
		parseRequestBody(body, spec);
	} catch (error) {
		if (error instanceof InvalidRequestBodyError) return error.message;
		throw error;
	}
	throw new Error(`${spec.what}: expected ${JSON.stringify(body)} to be rejected, it was accepted`);
}

describe("the mutating routes", () => {
	test("each record whether their body is checked, or that they take none", () => {
		const mutating = SERVER_ROUTES.filter(route => route.method !== "GET").map(
			route => `${route.method} ${route.path}`,
		);
		expect(mutating.length).toBeGreaterThan(0);
		for (const route of mutating) {
			expect(Object.keys(BODY_SPEC_BY_ROUTE)).toContain(route);
		}
		expect(Object.keys(BODY_SPEC_BY_ROUTE).sort()).toEqual([...mutating].sort());
	});

	test("every recorded spec is one of the specs this suite sweeps", () => {
		const checked = Object.values(BODY_SPEC_BY_ROUTE).filter((spec): spec is BodySpec<never> => spec !== null);
		for (const spec of checked) expect(SPECS).toContain(spec);
		expect(new Set(checked).size).toBe(new Set(SPECS.filter(spec => checked.includes(spec))).size);
	});

	test.each(SPECS.map(spec => [spec.what, spec] as const))("%s names the boundary in every refusal", (what, spec) => {
		expect(refusalFor(7, spec)).toStartWith(`${what} rejected:`);
		expect(refusalFor({ nope: 1, ...minimalBody(spec) }, spec)).toContain(`${what} rejected:`);
	});
});

describe.each(SPECS.map(spec => [spec.what, spec] as const))("%s", (_what, spec) => {
	const fields = fieldsOf(spec);

	test("accepts a body carrying only its required fields", () => {
		expect(parseRequestBody(minimalBody(spec), spec)).toEqual(minimalBody(spec) as never);
	});

	test("rejects a body that is not a JSON object", () => {
		for (const body of [null, undefined, "x", 7, true, []]) {
			expect(refusalFor(body, spec)).toContain("not a JSON object");
		}
	});

	test("rejects an unknown field by name and states the fields it knows", () => {
		const refusal = refusalFor({ ...minimalBody(spec), mispelled: "x" }, spec);
		expect(refusal).toContain('"mispelled"');
		for (const field of Object.keys(fields)) expect(refusal).toContain(field);
	});

	test.each(Object.entries(fields))("names %s when its value is the wrong kind", (field, kind) => {
		for (const value of REJECTED[kind]) {
			expect(refusalFor({ ...minimalBody(spec), [field]: value }, spec)).toContain(`"${field}"`);
		}
	});

	test.each(Object.entries(fields))("accepts a well-formed %s", (field, kind) => {
		const value = SEEDS[field] ?? (spec.enums?.[field]?.[0] as unknown) ?? VALID[kind];
		const parsed = parseRequestBody({ ...minimalBody(spec), [field]: value }, spec) as Record<string, unknown>;
		expect(parsed[field]).toEqual(value);
	});

	test("requires each of its required fields, present and non-blank", () => {
		for (const field of spec.required ?? []) {
			const without = minimalBody(spec);
			delete without[field];
			expect(refusalFor(without, spec)).toContain(`"${field}" is required`);
			expect(refusalFor({ ...minimalBody(spec), [field]: "  " }, spec)).toContain(`"${field}"`);
		}
	});

	test("rejects a value outside a pinned set, naming the values it accepts", () => {
		for (const [field, allowed] of Object.entries(spec.enums ?? {})) {
			if (!(field in fields)) continue;
			const refusal = refusalFor({ ...minimalBody(spec), [field]: "nope" }, spec);
			for (const option of allowed) expect(refusal).toContain(`"${option}"`);
		}
	});

	test("rejects a stray key inside a nested object instead of dropping it", () => {
		for (const [field, inner] of Object.entries(spec.nested ?? {})) {
			const kind = fields[field];
			const stray = { mispelled: "x" };
			const value = kind === "map" ? { "exp1-arm1": stray } : stray;
			const refusal = refusalFor({ ...minimalBody(spec), [field]: value }, spec);
			expect(refusal).toContain('"mispelled"');
			for (const innerField of Object.keys(inner)) expect(refusal).toContain(innerField);
		}
	});
});

describe("an experiment update", () => {
	test("rejects a run whose metadata is not an object", () => {
		const refusal = refusalFor({ runs: { "exp1-arm1": "baseline" } }, EXPERIMENT_META_UPDATE_SPEC as BodySpec<never>);
		expect(refusal).toContain('"runs.exp1-arm1" must be an object');
	});

	test("rejects a role no run can hold, naming the run it came from", () => {
		const refusal = refusalFor(
			{ runs: { "exp1-arm1": { role: "control" } } },
			EXPERIMENT_META_UPDATE_SPEC as BodySpec<never>,
		);
		expect(refusal).toContain('"runs.exp1-arm1.role"');
		expect(refusal).toContain('"baseline"');
	});

	test("accepts per-run metadata for several runs at once", () => {
		const body = {
			goal: "does prewalk pay for itself",
			runs: {
				"exp1-arm1": { role: "baseline", note: "no prewalk" },
				"exp1-arm2": { role: "variant", note: "prewalk into haiku", label: "haiku prewalk" },
			},
		} as const;
		expect(parseRequestBody(body, EXPERIMENT_META_UPDATE_SPEC)).toEqual(body);
	});
});

describe("an experiment id", () => {
	test.each(["exp 1", "exp-1", "exp/1", "exp:1", ""])("rejects %p, which would not group runs", id => {
		expect(refusalFor({ id }, CREATE_EXPERIMENT_SPEC as BodySpec<never>)).toContain('"id"');
	});

	test.each(["exp1", "prewalk_v2", "sweep.3"])("accepts %p", id => {
		expect(parseRequestBody({ id }, CREATE_EXPERIMENT_SPEC).id).toBe(id);
	});
});

describe("a prewalk", () => {
	test("rejects an empty model id instead of walking into nothing", () => {
		expect(refusalFor({ model: "a/b", prewalk: { into: "" } }, LAUNCH_REQUEST_SPEC as BodySpec<never>)).toContain(
			'"prewalk.into"',
		);
		expect(refusalFor({ arm: "a", model: "a/b", prewalk: { into: " " } }, ADD_ARM_SPEC as BodySpec<never>)).toContain(
			'"prewalk.into"',
		);
	});

	test("accepts an empty config, which prewalks with the default target", () => {
		expect(parseRequestBody({ model: "a/b", prewalk: {} }, LAUNCH_REQUEST_SPEC).prewalk).toEqual({});
	});
});
