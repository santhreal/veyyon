/**
 * WHY THIS EXISTS. `isArkErrors` replaced `value instanceof type.errors` in the tool-argument
 * validator, the config-file reader and the theme loader. The reason is cost: `type.errors` is
 * arktype's VALUE, so an instance check drags the library's 362ms module evaluation into every
 * module that asks the question. The replacement is structural, and a structural check is only
 * worth having if it answers exactly as the instance check did.
 *
 * THE CLASS THIS CLOSES. A predicate that stands in for `instanceof` and is wrong in either
 * direction: a rejection read as a valid result (the caller then treats an error list as data),
 * or a valid result read as a rejection (a working tool call refused). Both directions are here,
 * against real arktype output rather than a hand-built shape, plus the values most likely to be
 * confused for an error list -- a plain array, an array carrying some other `summary`, and the
 * validated arrays and objects a schema actually returns.
 *
 * WHAT IT DOES NOT CATCH. A future arktype that stops putting a string `summary` on `ArkErrors`,
 * or starts returning validated values that carry one. Nothing short of the instance check can
 * see that, and the launch cost is why the instance check is not used.
 */

import { describe, expect, it } from "bun:test";
import { isArkErrors } from "@veyyon/ai/utils/schema";
import { type } from "arktype";

const person = type({ name: "string", "age?": "number" });
const names = type("string[]");

describe("an arktype rejection is recognized without loading arktype", () => {
	it("recognizes what a schema returns for input it rejected", () => {
		const rejected = person({ name: 42 });

		expect(rejected).toBeInstanceOf(type.errors);
		expect(isArkErrors(rejected)).toBe(true);
	});

	it("recognizes a rejection from an array schema, which is itself array-shaped", () => {
		const rejected = names(["ok", 7]);

		expect(rejected).toBeInstanceOf(type.errors);
		expect(isArkErrors(rejected)).toBe(true);
	});

	it("does not mistake a validated object for a rejection", () => {
		const accepted = person({ name: "ada", age: 36 });

		expect(accepted).not.toBeInstanceOf(type.errors);
		expect(isArkErrors(accepted)).toBe(false);
	});

	it("does not mistake a validated array for a rejection", () => {
		const accepted = names(["ada", "grace"]);

		expect(accepted).not.toBeInstanceOf(type.errors);
		expect(isArkErrors(accepted)).toBe(false);
	});

	it("does not mistake a plain array of anything for a rejection", () => {
		expect(isArkErrors([])).toBe(false);
		expect(isArkErrors(["summary"])).toBe(false);
		expect(isArkErrors([{ summary: "not mine" }])).toBe(false);
	});

	/**
	 * The one shape that could fool it: an array carrying its own string `summary`. Nothing in
	 * this tree produces one, and a caller that starts to would be handing the validator a value
	 * it never validated.
	 */
	it("reads an array carrying a string summary as a rejection, which is the known limit", () => {
		const impostor = Object.assign(["something"], { summary: "mine" });

		expect(isArkErrors(impostor)).toBe(true);
	});

	it("does not mistake a primitive, null or a plain object for a rejection", () => {
		expect(isArkErrors(undefined)).toBe(false);
		expect(isArkErrors(null)).toBe(false);
		expect(isArkErrors("summary")).toBe(false);
		expect(isArkErrors({ summary: "mine" })).toBe(false);
	});
});
