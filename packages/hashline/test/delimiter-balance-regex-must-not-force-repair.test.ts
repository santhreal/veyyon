/**
 * `computeDelimiterBalance` is language-light: brackets inside strings,
 * line comments and block comments are skipped, but a regex literal is
 * counted as ordinary source. The apply.ts header says that misclassification
 * "can only suppress a repair (the safe direction), never force one."
 *
 * That claim is the contract. A `}` inside `/}/` that is counted as a real
 * closer makes an otherwise-balanced SWAP look delimiter-short, which is
 * exactly the signal `findDroppedSuffixClosers` uses to SPARE a deleted
 * `}`. Sparing it duplicates the function closer. If this test is red, the
 * scanner forced a repair from a regex — the unsafe direction.
 *
 * Nested template literals are the other scanner hole: backtick state is a
 * single flag, so a nested `` `outer ${`inner}` } ` `` can leak a `}` into
 * code balance. Same rule: leak may suppress, must not duplicate a closer.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(src: string, patch: string): { text: string; warnings: string[] } {
	const result = applyEdits(src, parsePatch(patch).edits);
	return { text: result.text, warnings: result.warnings ?? [] };
}

describe("a regex closer is not a structural closer", () => {
	it("does not spare the function's } just because the payload contains /}/", () => {
		const src = ["function f() {", "  const re = /x/;", "  return 1;", "}"].join("\n");
		const { text } = apply(src, ["SWAP 2.=4:", "+  const re = /}/;", "+  return 2;", "+}"].join("\n"));
		expect(text.split("\n").filter(line => line === "}")).toHaveLength(1);
		expect(text).toBe(["function f() {", "  const re = /}/;", "  return 2;", "}"].join("\n"));
	});

	it("does not drop a restated } as a duplicate-suffix when the regex is the only extra closer", () => {
		const src = ["export function g() {", "  use(/x/);", "}"].join("\n");
		const { text } = apply(src, ["SWAP 2.=3:", "+  use(/}/);", "+}"].join("\n"));
		expect(text).toBe(["export function g() {", "  use(/}/);", "}"].join("\n"));
	});

	it("still ignores a closer that lives in a line comment, which is the documented skip", () => {
		const src = ["function f() {", "  return 1;", "}"].join("\n");
		const { text } = apply(src, ["SWAP 2.=3:", "+  return 2; // trailing }", "+}"].join("\n"));
		expect(text.split("\n").filter(line => line.trim() === "}")).toHaveLength(1);
		expect(text).toBe(["function f() {", "  return 2; // trailing }", "}"].join("\n"));
	});

	it("still ignores a closer inside a double-quoted string", () => {
		const src = ["function f() {", '  return "}";', "}"].join("\n");
		const { text } = apply(src, ["SWAP 2.=3:", '+  return "still }";', "+}"].join("\n"));
		expect(text.split("\n").filter(line => line === "}")).toHaveLength(1);
	});
});

describe("a nested template must not force a closer spare", () => {
	it("does not duplicate the function closer when the payload nests backticks", () => {
		const src = ["function f() {", "  return `a`;", "}"].join("\n");
		const payload = "  return `outer ${`inner}`}`";
		const { text } = apply(src, `SWAP 2.=3:\n+${payload}\n+}`);
		expect(text.split("\n").filter(line => line === "}")).toHaveLength(1);
		expect(text).toBe(["function f() {", payload, "}"].join("\n"));
	});
});
