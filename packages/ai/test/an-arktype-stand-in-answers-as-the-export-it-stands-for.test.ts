/**
 * WHY THIS EXISTS. Shipped source imports `type`, `scope` and `Type` from `utils/schema/arktype`, whose
 * exports are stand-ins that evaluate arktype on first use, so a launch that builds no schema does not
 * pay for the package. A stand-in is only a replacement if every way the product uses the export
 * answers the same: a call (`type({...})`, `scope({...})`), a property read (`type.enumerated`,
 * `type.raw`, `type.errors`), an instance check against a property (`x instanceof type.errors`) or
 * against the stand-in itself (`x instanceof Type`), and a `new`.
 *
 * THE CLASS. A stand-in that answers differently from the export it stands for. The stand-ins are
 * swept from the module's exports at run time, and each own property of the real export is compared by
 * identity, so a new stand-in or a property arktype adds is covered without an edit.
 *
 * WHAT IT DOES NOT CATCH. Reflection the stand-ins do not forward (`Object.keys`, `in`,
 * `Object.getPrototypeOf`), which nothing in the product applies to them. That the module defers the
 * package is a property of a fresh process, defended by
 * `packages/coding-agent/test/architecture/a-launch-evaluates-arktype-only-when-a-schema-is-built.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import * as deferred from "@veyyon/ai/utils/schema/arktype";
import * as real from "arktype";

/** The exports that load, configure or identify the package rather than stand in for one of its exports. */
const LOADERS = ["arktypeRelease", "configureArktype", "loadArktype"];

/** The stand-in exports, each paired with the export it stands for. */
function standIns(): Array<readonly [string, object, object]> {
	return Object.entries(deferred)
		.filter(([name]) => !LOADERS.includes(name))
		.map(([name, value]) => [name, value as object, Reflect.get(real, name) as object] as const);
}

describe("an arktype stand-in answers as the export it stands for", () => {
	it("stands in for type, scope and Type, each an export of the package", () => {
		expect(standIns().map(([name]) => name)).toEqual(["Type", "scope", "type"]);
		expect(standIns().filter(([, , original]) => typeof original !== "function")).toEqual([]);
	});

	it("loads the package's own module namespace", () => {
		expect(deferred.loadArktype()).toBe(real);
	});

	it("identifies by its release the schema implementation the package loads", () => {
		const manifest = require("arktype/package.json") as { version: string; dependencies: Record<string, string> };
		const pins = ["@ark/schema", "@ark/util"].map(name => [name, manifest.dependencies[name]] as const);

		deferred.loadArktype();

		expect(deferred.arktypeRelease()).toBe(manifest.version);
		expect(pins.filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version ?? ""))).toEqual([]);
		expect((globalThis as { $ark?: { version?: unknown } }).$ark?.version).toBe(manifest.dependencies["@ark/util"]);
	});

	for (const [name, standIn, original] of standIns()) {
		it(`reads every property of ${name} as the package's own value`, () => {
			const keys = Reflect.ownKeys(original);
			expect(keys).toContain("name");
			const differing = keys.filter(key => Reflect.get(standIn, key) !== Reflect.get(original, key)).map(String);
			expect(differing).toEqual([]);
		});
	}

	it("builds through type the schema the package builds", () => {
		const definition = { name: "string", "age?": "number.integer >= 0", tags: "string[]" } as const;
		const viaStandIn = deferred.type(definition);
		const viaPackage = real.type(definition);

		expect(viaStandIn.json).toEqual(viaPackage.json);
		expect(viaStandIn({ name: "ada", tags: [] })).toEqual({ name: "ada", tags: [] });
		expect(viaStandIn({ name: "ada", age: -1, tags: [] })).toBeInstanceOf(deferred.type.errors);
		expect(viaStandIn({ name: "ada", age: -1, tags: [] })).toBeInstanceOf(real.type.errors);
	});

	it("builds through the properties of type what the package builds", () => {
		expect(deferred.type.enumerated("a", "b").json).toEqual(real.type.enumerated("a", "b").json);
		expect(deferred.type.raw("string").json).toEqual(real.type.raw("string").json);
		expect(deferred.type("string").or("number").json).toEqual(real.type("string").or("number").json);
	});

	it("builds through scope the module the package builds", () => {
		const definition = { id: "string", item: { id: "id", "count?": "number" } } as const;
		const viaStandIn = deferred.scope(definition).export();
		const viaPackage = real.scope(definition).export();

		expect(viaStandIn.item.json).toEqual(viaPackage.item.json);
		expect(viaStandIn.item({ id: "x", count: "1" })).toBeInstanceOf(real.type.errors);
	});

	it("recognizes a schema as an instance of Type, as the package's Type does", () => {
		const schema = real.type("string");

		expect(schema instanceof deferred.Type).toBe(true);
		expect({} instanceof deferred.Type).toBe(false);
		expect(schema instanceof real.Type).toBe(true);
	});

	it("constructs through Type into the package's constructor", () => {
		const constructed = (construct: typeof real.Type): string => {
			try {
				new construct({ kind: "unit" }, {} as never);
				return "constructed";
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		};

		expect(constructed(deferred.Type)).toBe(constructed(real.Type));
		expect(constructed(deferred.Type)).not.toContain("is not a constructor");
	});
});
