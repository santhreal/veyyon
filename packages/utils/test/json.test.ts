import { describe, expect, it } from "bun:test";
import { stringifyJson, tryParseJson } from "../src/json";
import { collectPackageSources, MEMBER_ROOTS, memberRootOf, type PackageSource } from "./support/package-sources";

describe("tryParseJson", () => {
	it("parses valid JSON to the exact value", () => {
		expect(tryParseJson<{ a: number; b: (boolean | null)[] }>('{"a":1,"b":[true,null]}')).toEqual({
			a: 1,
			b: [true, null],
		});
		expect(tryParseJson<string>('"plain string"')).toBe("plain string");
		expect(tryParseJson<number>("42")).toBe(42);
	});

	it("returns null for malformed input instead of throwing", () => {
		expect(tryParseJson("{a:1}")).toBeNull();
		expect(tryParseJson("")).toBeNull();
		expect(tryParseJson("[1,")).toBeNull();
	});

	it("distinguishes a parsed null literal only by identity of use", () => {
		// Documented sharp edge: "null" parses to null, indistinguishable from failure.
		expect(tryParseJson("null")).toBeNull();
	});
});

describe("stringifyJson", () => {
	it("matches JSON.stringify for plain values, including the space argument", () => {
		const value = { a: 1, nested: { b: ["x"] } };
		expect(stringifyJson(value)).toBe(JSON.stringify(value));
		expect(stringifyJson(value, 2)).toBe(JSON.stringify(value, null, 2));
	});

	it("serializes bigints as decimal strings where JSON.stringify throws", () => {
		expect(() => JSON.stringify({ n: 123n })).toThrow();
		expect(stringifyJson({ n: 123n })).toBe('{"n":"123"}');
		expect(stringifyJson({ big: 9007199254740993n })).toBe('{"big":"9007199254740993"}');
	});

	it("returns undefined for undefined input, like JSON.stringify", () => {
		expect(stringifyJson(undefined)).toBeUndefined();
	});
});

describe("tryParseJson source lock", () => {
	// tryParseJson is the ONE owner of "parse JSON, return null on failure". Any
	// production source that hand-rolls that exact shape — a `try` containing
	// `JSON.parse` whose `catch` returns null — has re-created the owner and must
	// call it instead. A `catch` that returns anything else (`{}`, `undefined`, a
	// repaired value, a rethrow) is a different contract and is deliberately not
	// matched. The 200-char window keeps the match local to one try/catch so a
	// JSON.parse and an unrelated catch far below it do not read as a clone.
	const TRYPARSE_CLONE =
		/JSON\.parse\([\s\S]{0,200}?\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\n\s*)?return null;?\s*\}/;
	// Only the owner is allowed to write the shape.
	const EXEMPT = new Set(["utils/src/json.ts"]);

	// The sweep is the shared collector, which walks every declared member at whatever depth it
	// sits. The walk here read `<root>/<package>/src`, one level under each root, so
	// `hosts/terminal/engine`, `natives/bridge/bindings`, `python/veybot/web` and `kernel` itself
	// contributed nothing while the roots assertion below still listed them.
	function sourceFiles(): Promise<PackageSource[]> {
		return collectPackageSources({ dirs: ["src"] });
	}

	it("catches the clone shape but not other catch contracts", () => {
		expect(TRYPARSE_CLONE.test("try {\n\treturn JSON.parse(x) as T;\n} catch {\n\treturn null;\n}")).toBe(true);
		expect(TRYPARSE_CLONE.test("try { const v = JSON.parse(x); return v; } catch (e) { return null }")).toBe(true);
		expect(TRYPARSE_CLONE.test("try { return JSON.parse(x); } catch { return {}; }")).toBe(false);
		expect(TRYPARSE_CLONE.test("try { return JSON.parse(x); } catch { return undefined; }")).toBe(false);
		expect(TRYPARSE_CLONE.test("try { return JSON.parse(x); } catch { throw new Error('bad'); }")).toBe(false);
	});

	// And the sweep opens every root the workspace declares. A root it never walked contributes no
	// file, so a clone under it is exempt by absence and the empty list below still reads green.
	it("reads a module under every root the workspace declares", async () => {
		const keys = (await sourceFiles()).map(({ rel }) => rel);
		const roots = new Set(keys.map(memberRootOf));

		expect([...roots].sort()).toEqual([...MEMBER_ROOTS].sort());
		expect(keys).toContain("utils/src/json.ts");
	});

	it("no production source rebuilds tryParseJson", async () => {
		const offenders: string[] = [];
		for (const { rel, text } of await sourceFiles()) {
			if (EXEMPT.has(rel)) continue;
			if (TRYPARSE_CLONE.test(text)) offenders.push(rel);
		}
		expect(offenders, "try/JSON.parse/catch-return-null — call tryParseJson from @veyyon/utils instead").toEqual([]);
	});
});
