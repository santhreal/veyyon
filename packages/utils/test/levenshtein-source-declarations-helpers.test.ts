import { describe, expect, it } from "bun:test";
import { damerauLevenshteinDistance, levenshteinDistance, nearestNames } from "../src/levenshtein";
import {
	type DeclaringModule,
	declarersOfName,
	declarersOfStringValue,
	exportedDeclarationsIn,
	stringConstantsIn,
	stringConstantValue,
} from "../src/source-declarations";

describe("levenshteinDistance", () => {
	it("returns 0 for identical strings", () => {
		expect(levenshteinDistance("hello", "hello")).toBe(0);
	});

	it("returns length of b for empty a", () => {
		expect(levenshteinDistance("", "hello")).toBe(5);
	});

	it("returns length of a for empty b", () => {
		expect(levenshteinDistance("hello", "")).toBe(5);
	});

	it("returns 0 for both empty", () => {
		expect(levenshteinDistance("", "")).toBe(0);
	});

	it("computes single substitution", () => {
		expect(levenshteinDistance("cat", "bat")).toBe(1);
	});

	it("computes single insertion", () => {
		expect(levenshteinDistance("cat", "cats")).toBe(1);
	});

	it("computes single deletion", () => {
		expect(levenshteinDistance("cats", "cat")).toBe(1);
	});

	it("computes multiple edits", () => {
		expect(levenshteinDistance("kitten", "sitting")).toBe(3);
	});

	it("computes completely different strings", () => {
		expect(levenshteinDistance("abc", "xyz")).toBe(3);
	});
});

describe("damerauLevenshteinDistance", () => {
	it("returns 0 for identical strings", () => {
		expect(damerauLevenshteinDistance("hello", "hello")).toBe(0);
	});

	it("returns length for empty string", () => {
		expect(damerauLevenshteinDistance("", "hello")).toBe(5);
		expect(damerauLevenshteinDistance("hello", "")).toBe(5);
	});

	it("handles transposition as single edit", () => {
		// "ab" -> "ba" is 1 transposition in Damerau-Levenshtein, 2 in regular Levenshtein
		expect(damerauLevenshteinDistance("ab", "ba")).toBe(1);
	});

	it("computes single substitution", () => {
		expect(damerauLevenshteinDistance("cat", "bat")).toBe(1);
	});

	it("computes kitten to sitting", () => {
		expect(damerauLevenshteinDistance("kitten", "sitting")).toBe(3);
	});
});

describe("nearestNames", () => {
	it("returns empty for empty needle", () => {
		expect(nearestNames("", ["a", "b"])).toEqual([]);
	});

	it("returns empty for whitespace-only needle", () => {
		expect(nearestNames("   ", ["a", "b"])).toEqual([]);
	});

	it("returns exact match first", () => {
		expect(nearestNames("bash", ["bash", "cat", "ls"])).toEqual(["bash"]);
	});

	it("is case-insensitive for exact match", () => {
		expect(nearestNames("BASH", ["bash", "cat"])).toEqual(["bash"]);
	});

	it("returns substring matches", () => {
		const result = nearestNames("bash", ["bash_tool", "rebash", "cat"]);
		expect(result).toContain("bash_tool");
		expect(result).toContain("rebash");
	});

	it("returns close fuzzy matches", () => {
		const result = nearestNames("bsh", ["bash", "cat", "ls"], 3);
		expect(result).toContain("bash");
	});

	it("respects limit", () => {
		const result = nearestNames("a", ["a1", "a2", "a3", "a4", "a5", "a6", "a7"], 3);
		expect(result.length).toBeLessThanOrEqual(3);
	});

	it("deduplicates results", () => {
		const result = nearestNames("bash", ["bash", "bash", "bash"]);
		expect(result).toEqual(["bash"]);
	});

	it("returns empty when no matches", () => {
		expect(nearestNames("xyz", ["abc", "def"])).toEqual([]);
	});

	it("trims input needle", () => {
		expect(nearestNames("  bash  ", ["bash", "cat"])).toEqual(["bash"]);
	});
});

describe("stringConstantsIn", () => {
	it("extracts exported string constant", () => {
		const source = 'export const GREETING = "hello";';
		const result = stringConstantsIn(source);
		expect(result.length).toBe(1);
		expect(result[0]?.name).toBe("GREETING");
		expect(result[0]?.value).toBe("hello");
		expect(result[0]?.exported).toBe(true);
	});

	it("extracts non-exported string constant", () => {
		const source = 'const SECRET = "world";';
		const result = stringConstantsIn(source);
		expect(result.length).toBe(1);
		expect(result[0]?.name).toBe("SECRET");
		expect(result[0]?.exported).toBe(false);
	});

	it("extracts single-quoted strings", () => {
		const source = "const NAME = 'test';";
		const result = stringConstantsIn(source);
		expect(result[0]?.value).toBe("test");
	});

	it("extracts backtick strings", () => {
		const source = "const MSG = `hello`;";
		const result = stringConstantsIn(source);
		expect(result[0]?.value).toBe("hello");
	});

	it("handles escape sequences", () => {
		const source = 'const MSG = "hello\\nworld";';
		const result = stringConstantsIn(source);
		expect(result[0]?.value).toBe("hello\nworld");
	});

	it("handles typed constant", () => {
		const source = "const TIMEOUT: number = 5000;";
		const result = stringConstantsIn(source);
		// This is a number, not a string, so it should not be extracted
		expect(result.length).toBe(0);
	});

	it("handles as const", () => {
		const source = 'export const NAME = "test" as const;';
		const result = stringConstantsIn(source);
		expect(result[0]?.value).toBe("test");
	});

	it("returns empty for no constants", () => {
		expect(stringConstantsIn("just some code")).toEqual([]);
	});

	it("handles multiple constants", () => {
		const source = 'const A = "a";\nconst B = "b";';
		const result = stringConstantsIn(source);
		expect(result.length).toBe(2);
	});
});

describe("stringConstantValue", () => {
	it("returns value for existing constant", () => {
		const source = 'export const FOO = "bar";';
		expect(stringConstantValue(source, "FOO")).toBe("bar");
	});

	it("returns undefined for missing constant", () => {
		expect(stringConstantValue("const FOO = 'bar';", "BAZ")).toBeUndefined();
	});

	it("returns undefined for no constants", () => {
		expect(stringConstantValue("just code", "FOO")).toBeUndefined();
	});
});

describe("exportedDeclarationsIn", () => {
	it("extracts exported function", () => {
		const source = "export function foo() { return 1; }";
		const result = exportedDeclarationsIn(source);
		expect(result).toContain("foo");
	});

	it("extracts exported const", () => {
		const source = "export const FOO = 1;";
		const result = exportedDeclarationsIn(source);
		expect(result).toContain("FOO");
	});

	it("extracts exported class", () => {
		const source = "export class MyClass {}";
		const result = exportedDeclarationsIn(source);
		expect(result).toContain("MyClass");
	});

	it("extracts exported interface", () => {
		const source = "export interface MyInterface {}";
		const result = exportedDeclarationsIn(source);
		expect(result).toContain("MyInterface");
	});

	it("extracts exported type", () => {
		const source = "export type MyType = string;";
		const result = exportedDeclarationsIn(source);
		expect(result).toContain("MyType");
	});

	it("extracts async function", () => {
		const source = "export async function fetchData() {}";
		const result = exportedDeclarationsIn(source);
		expect(result).toContain("fetchData");
	});

	it("extracts generator function", () => {
		const source = "export function* generator() {}";
		const result = exportedDeclarationsIn(source);
		expect(result).toContain("generator");
	});

	it("does not extract non-exported declarations", () => {
		const source = "function private() {}";
		const result = exportedDeclarationsIn(source);
		expect(result).not.toContain("private");
	});

	it("extracts export { } clause", () => {
		const source = "export { foo, bar };";
		const result = exportedDeclarationsIn(source);
		expect(result).toContain("foo");
		expect(result).toContain("bar");
	});

	it("handles empty source", () => {
		expect(exportedDeclarationsIn("")).toEqual([]);
	});
});

describe("declarersOfStringValue", () => {
	it("returns module paths that declare the value", () => {
		const modules: DeclaringModule[] = [
			{ file: "a.ts", source: 'const FOO = "hello";' },
			{ file: "b.ts", source: 'const BAR = "world";' },
		];
		expect(declarersOfStringValue(modules, "hello")).toEqual(["a.ts"]);
	});

	it("returns empty when no module declares the value", () => {
		const modules: DeclaringModule[] = [{ file: "a.ts", source: 'const FOO = "hello";' }];
		expect(declarersOfStringValue(modules, "nonexistent")).toEqual([]);
	});

	it("returns multiple modules when they declare the same value", () => {
		const modules: DeclaringModule[] = [
			{ file: "a.ts", source: 'const FOO = "hello";' },
			{ file: "b.ts", source: 'const BAR = "hello";' },
		];
		expect(declarersOfStringValue(modules, "hello")).toEqual(["a.ts", "b.ts"]);
	});
});

describe("declarersOfName", () => {
	it("returns module paths that export the name", () => {
		const modules: DeclaringModule[] = [
			{ file: "a.ts", source: "export function foo() {}" },
			{ file: "b.ts", source: "export function bar() {}" },
		];
		expect(declarersOfName(modules, "foo")).toEqual(["a.ts"]);
	});

	it("returns empty when no module exports the name", () => {
		const modules: DeclaringModule[] = [{ file: "a.ts", source: "export function foo() {}" }];
		expect(declarersOfName(modules, "bar")).toEqual([]);
	});
});
