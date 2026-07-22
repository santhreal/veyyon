import { describe, expect, it } from "bun:test";
import {
	isJTDDiscriminator,
	isJTDElements,
	isJTDEnum,
	isJTDProperties,
	isJTDRef,
	isJTDType,
	isJTDValues,
} from "@veyyon/coding-agent/tools/jtd-utils";

/**
 * These seven guards discriminate which JSON Type Definition form a schema node is,
 * and downstream schema handling branches on them. They were untested. Two contracts
 * matter and are locked here: every guard must reject a non-object (null, string) so
 * a malformed schema cannot be walked as if it had a form, and the two guards that do
 * more than a key-presence check must actually enforce it:
 *
 *  - isJTDEnum requires `enum` to be an array (a string enum is not the enum form).
 *  - isJTDDiscriminator requires a string `discriminator` AND a non-null, non-array
 *    object `mapping`; a missing, null, array, or non-string field is not the
 *    discriminator form.
 *
 * The looser guards are form discriminators, not validators: isJTDType accepts any
 * object with a `type` key even if the value is not a real primitive, which this test
 * pins deliberately so a future "tightening" is a conscious choice.
 */

describe("isJTDType", () => {
	it("is true for any object with a type key and false for non-objects", () => {
		expect(isJTDType({ type: "string" })).toBe(true);
		// Deliberately loose: a form discriminator, not a primitive validator.
		expect(isJTDType({ type: "not-a-primitive" })).toBe(true);
		expect(isJTDType(null)).toBe(false);
		expect(isJTDType("string")).toBe(false);
		expect(isJTDType({})).toBe(false);
	});
});

describe("isJTDEnum", () => {
	it("requires enum to be an array", () => {
		expect(isJTDEnum({ enum: ["a", "b"] })).toBe(true);
		expect(isJTDEnum({ enum: [] })).toBe(true);
		expect(isJTDEnum({ enum: "a" })).toBe(false);
		expect(isJTDEnum(null)).toBe(false);
	});
});

describe("isJTDElements and isJTDValues", () => {
	it("check for the elements / values key respectively", () => {
		expect(isJTDElements({ elements: { type: "string" } })).toBe(true);
		expect(isJTDElements({})).toBe(false);
		expect(isJTDValues({ values: { type: "string" } })).toBe(true);
		expect(isJTDValues({})).toBe(false);
		expect(isJTDValues(null)).toBe(false);
	});
});

describe("isJTDProperties", () => {
	it("is true when either properties or optionalProperties is present", () => {
		expect(isJTDProperties({ properties: {} })).toBe(true);
		expect(isJTDProperties({ optionalProperties: {} })).toBe(true);
		expect(isJTDProperties({ type: "string" })).toBe(false);
		expect(isJTDProperties(null)).toBe(false);
	});
});

describe("isJTDDiscriminator", () => {
	it("requires a string discriminator and a plain-object mapping", () => {
		expect(isJTDDiscriminator({ discriminator: "t", mapping: {} })).toBe(true);
		expect(isJTDDiscriminator({ discriminator: "t", mapping: [] })).toBe(false);
		expect(isJTDDiscriminator({ discriminator: 1, mapping: {} })).toBe(false);
		expect(isJTDDiscriminator({ discriminator: "t" })).toBe(false);
		expect(isJTDDiscriminator({ discriminator: "t", mapping: null })).toBe(false);
		expect(isJTDDiscriminator(null)).toBe(false);
	});
});

describe("isJTDRef", () => {
	it("checks for the ref key and rejects non-objects", () => {
		expect(isJTDRef({ ref: "user" })).toBe(true);
		expect(isJTDRef({})).toBe(false);
		expect(isJTDRef(null)).toBe(false);
	});
});
