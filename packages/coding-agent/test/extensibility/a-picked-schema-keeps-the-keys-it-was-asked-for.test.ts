import { describe, expect, it } from "bun:test";
import { type TSchema, Type } from "@veyyon/kernel/registry/typebox";

/**
 * WHY: `Type.Pick` and `Type.Omit` were separate functions until they were
 * deduplicated into one `selectProperties(obj, keys, pick)` helper. The merge
 * expressed both directions as a single `for (const key in source)` loop with a
 * `match(key)` predicate, which silently changed Pick on two axes that Omit does
 * not have:
 *
 *   1. Key order. Pick emits the caller's requested order; iterating the source
 *      emits the declared/data order instead.
 *   2. Own non-enumerable keys. Pick's raw-schema fallback tested `key in data`,
 *      which sees them; `for...in` skips them, so a picked key disappeared.
 *
 * The class this closes is "a Pick/Omit consolidation that keeps the resulting
 * key SET correct while changing the key ORDER or the key-presence test". Both
 * code paths are covered: the declared path (`__properties` present, from
 * `Type.Object`) and the raw-schema fallback (`__properties` absent, from
 * `Type.Unsafe`).
 *
 * What it does NOT catch: the fallback validator never runs the source schema's
 * own property validators, so `Type.Pick(Type.Unsafe(...), ...)` accepts an
 * out-of-type value for a picked key. That is pre-existing behavior, identical
 * in the pre-consolidation code, and is not a property of the merge.
 */

interface WireSchema {
	properties?: Record<string, unknown>;
	required?: string[];
}

/** The JSON Schema a provider sees: only the enumerable keywords survive serialization. */
function wire(schema: TSchema): WireSchema {
	return JSON.parse(JSON.stringify(schema)) as WireSchema;
}

function declaredKeys(schema: TSchema): string[] {
	return Object.keys(schema.__properties ?? {});
}

const rawObject = () =>
	Type.Unsafe({
		type: "object",
		properties: { alpha: { type: "string" }, beta: { type: "string" }, gamma: { type: "string" } },
		required: ["alpha", "beta"],
	});

describe("Type.Pick", () => {
	it("emits the requested keys in the order they were requested", () => {
		const base = Type.Object({ alpha: Type.String(), beta: Type.String(), gamma: Type.String() });

		const picked = Type.Pick(base, ["gamma", "alpha"]);

		expect(declaredKeys(picked)).toEqual(["gamma", "alpha"]);
		expect(Object.keys(wire(picked).properties ?? {})).toEqual(["gamma", "alpha"]);
	});

	it("skips a requested key the source never declared instead of emitting it as undefined", () => {
		const base = Type.Object({ alpha: Type.String(), beta: Type.String() });

		const picked = Type.Pick(base, ["alpha", "absent"]);

		expect(declaredKeys(picked)).toEqual(["alpha"]);
		expect("absent" in (picked.__properties ?? {})).toBe(false);
		expect(Object.keys(wire(picked).properties ?? {})).toEqual(["alpha"]);
	});

	it("keeps an own non-enumerable key when the source carries no property metadata", () => {
		const picked = Type.Pick(rawObject(), ["beta", "alpha"]);
		const data: Record<string, unknown> = { alpha: "a", gamma: "g" };
		Object.defineProperty(data, "beta", { value: "b", enumerable: false });

		const validated = picked.__validator(data);

		expect(Object.keys(validated as Record<string, unknown>)).toEqual(["beta", "alpha"]);
		expect(validated).toEqual({ beta: "b", alpha: "a" });
	});

	it("filters the wire properties and required list to the picked keys", () => {
		const picked = wire(Type.Pick(rawObject(), ["beta"]));

		expect(picked.properties).toEqual({ beta: { type: "string" } });
		expect(picked.required).toEqual(["beta"]);
	});

	it("rejects a non-object through the raw-schema fallback", () => {
		const result = Type.Pick(rawObject(), ["alpha"]).__validator("alpha");

		expect(result).toMatchObject({ message: "Expected object" });
	});
});

describe("Type.Omit", () => {
	it("keeps the surviving keys in their declared order", () => {
		const base = Type.Object({ alpha: Type.String(), beta: Type.String(), gamma: Type.String() });

		const omitted = Type.Omit(base, ["beta"]);

		expect(declaredKeys(omitted)).toEqual(["alpha", "gamma"]);
		expect(Object.keys(wire(omitted).properties ?? {})).toEqual(["alpha", "gamma"]);
	});

	it("drops the named keys from validated data when the source carries no property metadata", () => {
		const omitted = Type.Omit(rawObject(), ["alpha"]);

		expect(omitted.__validator({ alpha: "a", beta: "b", gamma: "g" })).toEqual({ beta: "b", gamma: "g" });
	});

	it("filters the wire properties and required list to the surviving keys", () => {
		const omitted = wire(Type.Omit(rawObject(), ["alpha"]));

		expect(omitted.properties).toEqual({ beta: { type: "string" }, gamma: { type: "string" } });
		expect(omitted.required).toEqual(["beta"]);
	});
});
