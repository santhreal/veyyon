import { describe, expect, it } from "bun:test";
import { parseJsonWithRepair } from "@veyyon/utils/json-parse";

/**
 * The relaxed JSON parser recovers an unquoted (bareword) string value, e.g.
 * `{"method": toString}` becomes `{ method: "toString" }`. Only a curated set of
 * five JS-only atoms — `NaN`, `Infinity`, `-Infinity`, `+Infinity`, `undefined` —
 * must abort recovery, because a tool would otherwise run with a non-finite or
 * undefined argument masquerading as a string.
 *
 * Regression (own-key / prototype-membership class): the non-recoverable check
 * read `NON_RECOVERABLE_BAREWORDS[word]` directly. That set is a plain object, so
 * a bareword whose value collides with an `Object.prototype` member name
 * (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`,
 * `propertyIsEnumerable`, `toLocaleString`) resolved the inherited method
 * (a function, truthy) and was thrown as "Unexpected token" — so a perfectly
 * valid unquoted string value was rejected and the ENTIRE tool call was dropped
 * instead of parsed. `Object.hasOwn` restricts the abort to the five real atoms.
 *
 * These pin that prototype-named barewords recover as their literal string, while
 * the genuine non-finite/undefined atoms still throw.
 */
describe("relaxed JSON bareword recovery uses own-property membership for non-recoverable atoms", () => {
	const PROTOTYPE_NAMED_BAREWORDS = [
		"constructor",
		"toString",
		"valueOf",
		"hasOwnProperty",
		"isPrototypeOf",
		"propertyIsEnumerable",
		"toLocaleString",
	] as const;

	for (const word of PROTOTYPE_NAMED_BAREWORDS) {
		it(`recovers the unquoted value \`${word}\` as the literal string, not a rejected token`, () => {
			const parsed = parseJsonWithRepair<{ method: string }>(`{"method": ${word}}`);
			expect(parsed).toEqual({ method: word });
		});
	}

	it("recovers a prototype-named bareword nested among ordinary fields", () => {
		const parsed = parseJsonWithRepair<{ a: number; kind: string; ok: boolean }>(
			'{"a": 1, "kind": constructor, "ok": true}',
		);
		expect(parsed).toEqual({ a: 1, kind: "constructor", ok: true });
	});

	it("recovers a prototype-named bareword as an array element", () => {
		const parsed = parseJsonWithRepair<{ names: string[] }>('{"names": [toString, valueOf, plain]}');
		expect(parsed).toEqual({ names: ["toString", "valueOf", "plain"] });
	});

	it("still recovers an ordinary bareword that is not a prototype member", () => {
		const parsed = parseJsonWithRepair<{ path: string }>('{"path": packages/foo/bar}');
		expect(parsed).toEqual({ path: "packages/foo/bar" });
	});

	// `NaN`, `Infinity`, `undefined` reach the bareword path and abort there with
	// "Unexpected token"; the signed forms `-Infinity`/`+Infinity` route to the
	// number parser first and abort there with "Invalid number". Either way the
	// contract is the same: a non-finite/undefined atom is never recovered.
	for (const atom of ["NaN", "Infinity", "undefined"] as const) {
		it(`still rejects the non-recoverable bareword atom \`${atom}\` so a tool never runs with it`, () => {
			expect(() => parseJsonWithRepair(`{"n": ${atom}}`)).toThrow(/Unexpected token/);
		});
	}
	for (const atom of ["-Infinity", "+Infinity"] as const) {
		it(`still rejects the signed non-recoverable atom \`${atom}\``, () => {
			expect(() => parseJsonWithRepair(`{"n": ${atom}}`)).toThrow(/Invalid number/);
		});
	}

	it("distinguishes the bareword `undefined` (rejected) from the string value `constructor` (recovered)", () => {
		// The two live one line apart in intent: `undefined` is a curated atom and
		// must abort; `constructor` only *looks* dangerous because of the prototype
		// chain and must recover. This proves the fix keeps both behaviors.
		expect(() => parseJsonWithRepair('{"x": undefined}')).toThrow(/Unexpected token/);
		expect(parseJsonWithRepair<{ x: string }>('{"x": constructor}')).toEqual({ x: "constructor" });
	});
});
