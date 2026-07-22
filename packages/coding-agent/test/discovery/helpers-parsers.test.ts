import { afterEach, describe, expect, it } from "bun:test";
import {
	compareSkillOrder,
	expandEnvVarsDeep,
	getExtensionNameFromPath,
	parseArrayOrCSV,
	parseBoolean,
	parseCSV,
	parseModelList,
	resolveCopilotHome,
} from "@veyyon/coding-agent/discovery/helpers";

/**
 * The discovery layer parses agent/skill/plugin frontmatter through a set of small pure
 * helpers. Several had no direct test even though every provider adapter leans on them, so a
 * regression (a dropped trim, a broken CSV split, a lost env default) would silently mis-parse
 * config across every integration. Pinned:
 *   - parseBoolean: only real booleans and the strings "true"/"false" (trim + lowercase),
 *     everything else undefined;
 *   - parseCSV: comma-split, each entry trimmed, empties dropped;
 *   - parseArrayOrCSV: an array keeps only its string members (undefined if none), a string
 *     goes through parseCSV, anything else undefined;
 *   - parseModelList: parseArrayOrCSV then a second trim/non-empty filter;
 *   - getExtensionNameFromPath: index.{ts,js} names resolve to the parent dir, otherwise the
 *     basename minus its extension (a leading-dot dotfile keeps its name);
 *   - compareSkillOrder: case-insensitive name, then exact name, then path;
 *   - resolveCopilotHome: COPILOT_HOME (trimmed, non-blank) wins, else <home>/.copilot;
 *   - expandEnvVarsDeep: recursively substitutes ${VAR} / ${VAR:-default}, leaving an
 *     unresolved reference literal.
 */

describe("parseBoolean", () => {
	it("accepts real booleans and the strings true/false case- and whitespace-insensitively", () => {
		expect(parseBoolean(true)).toBe(true);
		expect(parseBoolean(false)).toBe(false);
		expect(parseBoolean(" TRUE ")).toBe(true);
		expect(parseBoolean("False")).toBe(false);
	});

	it("returns undefined for any other string or non-boolean value", () => {
		expect(parseBoolean("yes")).toBeUndefined();
		expect(parseBoolean(1)).toBeUndefined();
		expect(parseBoolean(undefined)).toBeUndefined();
	});
});

describe("parseCSV / parseArrayOrCSV", () => {
	it("splits on commas, trimming each entry and dropping empties", () => {
		expect(parseCSV("a, b ,,c")).toEqual(["a", "b", "c"]);
		expect(parseCSV("  ")).toEqual([]);
		expect(parseCSV("solo")).toEqual(["solo"]);
	});

	it("keeps only string members of an array and routes a string through parseCSV", () => {
		expect(parseArrayOrCSV(["a", 1, "b"])).toEqual(["a", "b"]);
		expect(parseArrayOrCSV("x,y")).toEqual(["x", "y"]);
	});

	it("returns undefined for an empty array, empty string, or a non-array/non-string value", () => {
		expect(parseArrayOrCSV([])).toBeUndefined();
		expect(parseArrayOrCSV("")).toBeUndefined();
		expect(parseArrayOrCSV(5)).toBeUndefined();
	});
});

describe("parseModelList", () => {
	it("parses an array or CSV and applies a second trim/non-empty filter", () => {
		expect(parseModelList(" a , b ")).toEqual(["a", "b"]);
		expect(parseModelList(["  m1  ", ""])).toEqual(["m1"]);
	});

	it("returns undefined for an all-blank or non-parseable value", () => {
		expect(parseModelList("   ")).toBeUndefined();
		expect(parseModelList(undefined)).toBeUndefined();
	});
});

describe("getExtensionNameFromPath", () => {
	it("resolves an index.{ts,js} entry to its parent directory name", () => {
		expect(getExtensionNameFromPath("/a/b/my-ext/index.ts")).toBe("my-ext");
		expect(getExtensionNameFromPath("C:\\x\\plug\\index.js")).toBe("plug");
	});

	it("uses the basename minus its extension, keeping a leading-dot dotfile intact", () => {
		expect(getExtensionNameFromPath("/a/b/foo.js")).toBe("foo");
		expect(getExtensionNameFromPath("bar")).toBe("bar");
		expect(getExtensionNameFromPath(".eslintrc")).toBe(".eslintrc");
	});
});

describe("compareSkillOrder", () => {
	it("orders by case-insensitive name, then exact name, then path", () => {
		expect(compareSkillOrder("Beta", "p1", "alpha", "p2")).toBe(1);
		// Same lowercased name: uppercase sorts before lowercase by exact-name compare.
		expect(compareSkillOrder("Foo", "p1", "foo", "p2")).toBe(-1);
		// Identical names: fall through to path compare.
		expect(compareSkillOrder("x", "a", "x", "b")).toBe(-1);
		expect(compareSkillOrder("x", "a", "x", "a")).toBe(0);
	});
});

describe("resolveCopilotHome", () => {
	const original = process.env.COPILOT_HOME;
	afterEach(() => {
		if (original === undefined) delete process.env.COPILOT_HOME;
		else process.env.COPILOT_HOME = original;
	});

	it("prefers a trimmed non-blank COPILOT_HOME, otherwise <home>/.copilot", () => {
		delete process.env.COPILOT_HOME;
		expect(resolveCopilotHome("/home/u")).toBe("/home/u/.copilot");
		process.env.COPILOT_HOME = "  /custom/copilot  ";
		expect(resolveCopilotHome("/home/u")).toBe("/custom/copilot");
		process.env.COPILOT_HOME = "   ";
		expect(resolveCopilotHome("/home/u")).toBe("/home/u/.copilot");
	});
});

describe("expandEnvVarsDeep", () => {
	// Build the literal placeholder strings via concatenation so the env-var syntax under
	// test does not trip the noTemplateCurlyInString lint (these are intentionally NOT
	// template strings — they are the raw input the function must expand).
	const D = "$";
	const foo = `${D}{FOO}`;
	const barDefault = `${D}{BAR:-def}`;
	const unresolved = `${D}{VEYYON_TEST_UNSET_VAR_XYZ}`;

	it("recursively substitutes VAR and VAR-with-default refs, leaving an unresolved ref literal", () => {
		const result = expandEnvVarsDeep({ a: foo, b: [barDefault, 5], c: { d: unresolved } }, { FOO: "vfoo" });
		expect(result).toEqual({ a: "vfoo", b: ["def", 5], c: { d: unresolved } });
	});
});
