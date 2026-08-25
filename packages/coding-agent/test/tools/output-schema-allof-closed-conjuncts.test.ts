/**
 * Closed `allOf` conjuncts AND together for incremental labels.
 *
 * WHY THIS SUITE EXISTS. `collectClosedTopLevelSchemas` walks root
 * `additionalProperties: false` AND every `allOf` child that is itself
 * closed. A label is known only if every closed conjunct accepts it. A
 * schema that closes the root and then `allOf`s a second closed object with
 * a disjoint property set has NO known incremental labels — every yield
 * label fails the intersection. Treating `allOf` as `oneOf` here would let
 * a subagent yield `{ type: ["a"] }` that the assembled-output validator
 * then rejects because the other conjunct required `b`.
 */
import { describe, expect, it } from "bun:test";
import { buildOutputValidator } from "@veyyon/coding-agent/tools/output-schema-validator";

describe("allOf of two closed objects with disjoint properties", () => {
	it("rejects both labels because neither is accepted by every conjunct", () => {
		const { validator } = buildOutputValidator({
			allOf: [
				{
					type: "object",
					additionalProperties: false,
					properties: { a: { type: "string" } },
					required: ["a"],
				},
				{
					type: "object",
					additionalProperties: false,
					properties: { b: { type: "number" } },
					required: ["b"],
				},
			],
		});
		expect(validator?.rejectUnknownSections).toBe(true);
		expect(validator?.isKnownSection("a")).toBe(false);
		expect(validator?.isKnownSection("b")).toBe(false);
	});
});

describe("allOf of two closed objects that share a property", () => {
	it("accepts only the intersection label", () => {
		const { validator } = buildOutputValidator({
			allOf: [
				{
					type: "object",
					additionalProperties: false,
					properties: {
						shared: { type: "string" },
						aOnly: { type: "string" },
					},
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						shared: { type: "string" },
						bOnly: { type: "number" },
					},
				},
			],
		});
		expect(validator?.isKnownSection("shared")).toBe(true);
		expect(validator?.isKnownSection("aOnly")).toBe(false);
		expect(validator?.isKnownSection("bOnly")).toBe(false);
	});
});

describe("root closed object plus an allOf closed child", () => {
	it("intersects root properties with the child", () => {
		const { validator } = buildOutputValidator({
			type: "object",
			additionalProperties: false,
			properties: {
				rootOnly: { type: "string" },
				shared: { type: "string" },
			},
			allOf: [
				{
					type: "object",
					additionalProperties: false,
					properties: {
						shared: { type: "string" },
						childOnly: { type: "string" },
					},
				},
			],
		});
		expect(validator?.rejectUnknownSections).toBe(true);
		expect(validator?.isKnownSection("shared")).toBe(true);
		expect(validator?.isKnownSection("rootOnly")).toBe(false);
		expect(validator?.isKnownSection("childOnly")).toBe(false);
	});
});
