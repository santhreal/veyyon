/**
 * WHY: `POST /api/runs` cast its JSON body to `LaunchRequest` and handed it to the runner, so a
 * body the caller got wrong still launched. `concurrency: "lots"` and `tasks: -5` reached the
 * runner as command-line values; a misspelled key (`models` for `model`, `kind` for `benchmark`)
 * was dropped in silence and the run started on the defaults. Either way a job directory, a store
 * row and a container existed before anything reported the mistake.
 *
 * The class this closes is a launch field that reaches the runner without a check. The sweep reads
 * `LAUNCH_REQUEST_FIELDS` at run time, so a field added to the table is checked here without an
 * edit, and the table's `keyof LaunchRequest` key type makes a field added to the interface and
 * not to the table a type error, which is what keeps the two from drifting.
 *
 * What it does not catch: whether a value that passes these checks means anything to the runner
 * that receives it (an unregistered `benchmark`, a dataset that does not exist). Those refusals
 * live in the runner and the benchmark registry, and are covered where they are decided.
 */
import { describe, expect, test } from "bun:test";
import {
	type BodyFieldKind,
	InvalidRequestBodyError,
	LAUNCH_REQUEST_FIELDS,
	type LaunchRequest,
	parseLaunchRequest,
} from "../../engine/store-shapes";

/** A value of the right shape for each kind, used to prove a swept field still accepts one. */
const VALID: Readonly<Record<BodyFieldKind, unknown>> = {
	string: "docker",
	strings: ["task-one"],
	count: 2,
	ratio: 1.5,
	boolean: true,
	object: { into: "anthropic/claude-haiku-4-5" },
	map: { "exp1-arm1": { note: "a" } },
};

/** Values no field of that kind may accept, each with the reason the refusal must name. */
const REJECTED: Readonly<Record<BodyFieldKind, readonly unknown[]>> = {
	string: [7, true, ["a"], {}],
	strings: ["task-one", [""], [3], {}],
	count: ["lots", -5, 0, 1.5, Number.NaN],
	ratio: ["fast", 0, -1, Number.POSITIVE_INFINITY],
	boolean: ["true", 1, {}],
	object: ["haiku", 3, ["haiku"]],
	map: ["haiku", 3, ["haiku"]],
};

/** The two fields whose string values are pinned to a set rather than left open. */
const ENUM_FIELDS: Readonly<Record<string, readonly string[]>> = {
	environment: ["docker", "apple-container"],
	role: ["baseline", "variant", ""],
};

function bodyWith(field: string, value: unknown): Record<string, unknown> {
	return field === "model" ? { model: value } : { model: "anthropic/claude-sonnet-4-5", [field]: value };
}

function refusalFor(body: unknown): string {
	try {
		parseLaunchRequest(body);
	} catch (error) {
		if (error instanceof InvalidRequestBodyError) return error.message;
		throw error;
	}
	throw new Error(`expected ${JSON.stringify(body)} to be rejected, it was accepted`);
}

describe("a launch body", () => {
	test("declares a checked kind for every field it accepts", () => {
		const kinds = new Set<string>(Object.values(LAUNCH_REQUEST_FIELDS));
		expect([...kinds].sort()).toEqual(["boolean", "count", "object", "ratio", "string", "strings"]);
		expect(Object.keys(LAUNCH_REQUEST_FIELDS)).toContain("model");
	});

	test.each(Object.entries(LAUNCH_REQUEST_FIELDS))("accepts a well-formed %s", (field, kind) => {
		const value = field in ENUM_FIELDS ? ENUM_FIELDS[field][0] : VALID[kind];
		const parsed = parseLaunchRequest(bodyWith(field, value));
		expect(parsed[field as keyof LaunchRequest]).toEqual(value as never);
	});

	test.each(Object.entries(LAUNCH_REQUEST_FIELDS))("names %s when its value is the wrong kind", (field, kind) => {
		for (const value of REJECTED[kind]) {
			if (field === "model" && kind === "string") continue;
			expect(refusalFor(bodyWith(field, value))).toContain(`"${field}"`);
		}
	});

	test.each(Object.entries(ENUM_FIELDS))("rejects a %s outside its pinned values", (field, allowed) => {
		const refusal = refusalFor(bodyWith(field, "nope"));
		expect(refusal).toContain(`"${field}"`);
		for (const option of allowed) expect(refusal).toContain(`"${option}"`);
		for (const option of allowed) {
			const parsed = parseLaunchRequest(bodyWith(field, option)) as unknown as Record<string, unknown>;
			expect(parsed[field]).toBe(option);
		}
	});

	test("rejects an unknown field by name and states the fields it knows", () => {
		const refusal = refusalFor({ model: "a/b", models: "c/d" });
		expect(refusal).toContain('"models"');
		expect(refusal).toContain("Known fields:");
		for (const field of Object.keys(LAUNCH_REQUEST_FIELDS)) expect(refusal).toContain(field);
	});

	test("rejects every unknown field in one refusal", () => {
		const refusal = refusalFor({ model: "a/b", kind: "edit", jobname: "x" });
		expect(refusal).toContain('"kind"');
		expect(refusal).toContain('"jobname"');
	});

	test("requires a model", () => {
		expect(refusalFor({ benchmark: "edit" })).toContain('"model" is required');
		expect(refusalFor({ model: "   " })).toContain('"model" is required');
		expect(refusalFor({ model: "" })).toContain('"model" is required');
	});

	test("rejects a body that is not a JSON object", () => {
		for (const body of [null, undefined, "model=a/b", 7, true, [{ model: "a/b" }]]) {
			expect(refusalFor(body)).toContain("not a JSON object");
		}
	});

	test("rejects a stray key inside prewalk instead of dropping it", () => {
		const refusal = refusalFor({ model: "a/b", prewalk: { intoo: "haiku" } });
		expect(refusal).toContain('"intoo"');
		expect(refusal).toContain("into");
		expect(refusalFor({ model: "a/b", prewalk: { into: "" } })).toContain('"prewalk.into"');
		expect(parseLaunchRequest({ model: "a/b", prewalk: {} }).prewalk).toEqual({});
	});

	test("treats an absent optional field as absent, not as a wrong value", () => {
		const parsed = parseLaunchRequest({ model: "a/b", tasks: undefined, note: null });
		expect(parsed.model).toBe("a/b");
		expect(parsed.tasks).toBeUndefined();
	});

	test("accepts the body the dashboard launch form submits", () => {
		const parsed = parseLaunchRequest({
			benchmark: "edit",
			model: "anthropic/claude-sonnet-4-5",
			jobName: "edit-smoke",
			dataset: "typescript-edit",
			tasks: 4,
			concurrency: 2,
			timeoutMultiplier: 1.5,
			include: ["rename-symbol", "extract-function"],
			goal: "does prewalk pay for itself",
			role: "variant",
			note: "prewalk into haiku at first edit",
			prewalk: { into: "anthropic/claude-haiku-4-5" },
		});
		expect(parsed.tasks).toBe(4);
		expect(parsed.role).toBe("variant");
		expect(parsed.include).toEqual(["rename-symbol", "extract-function"]);
	});

	test("states which launch body it rejected", () => {
		const error = new InvalidRequestBodyError("Launch request", '"tasks" must be an integer >= 1, got -5');
		expect(error.name).toBe("InvalidRequestBodyError");
		expect(error.message).toBe('Launch request rejected: "tasks" must be an integer >= 1, got -5');
	});
});
