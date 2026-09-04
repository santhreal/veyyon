/**
 * The runtime half of the vocabulary agrees with its type half.
 *
 * WHY THIS SUITE EXISTS. A schema walker that reads `type` off a definition at run time has to know
 * which tags are real. The list the product's corpus test kept of its own drifted both ways: it named
 * an `"object"` kind the schema never had, and it did not name `"modelChain"` the day that kind
 * arrived. `SETTING_TYPES` and `isSettingType` are the one list every walker reads instead, and this
 * suite pins that list to the seven definition kinds `SettingDef` declares.
 *
 * WHAT IT DOES NOT CATCH. A definition kind added to the union without a row in the tag table is a
 * compile error in `SETTING_TYPE_ROWS`, not a runtime one; this suite sees the table only after it
 * compiles.
 */
import { describe, expect, it } from "bun:test";
import { isSettingType, SETTING_TYPES } from "../src/index";

describe("a type tag is one the vocabulary declares", () => {
	it("lists the seven definition kinds in declaration order", () => {
		expect([...SETTING_TYPES]).toEqual(["boolean", "string", "modelChain", "number", "enum", "array", "record"]);
	});

	it("recognises every listed tag and nothing else", () => {
		for (const tag of SETTING_TYPES) expect(isSettingType(tag)).toBe(true);
		expect(isSettingType("object")).toBe(false);
		expect(isSettingType("")).toBe(false);
		expect(isSettingType("toString")).toBe(false);
	});
});
