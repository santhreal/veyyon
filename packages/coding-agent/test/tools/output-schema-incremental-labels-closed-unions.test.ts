/**
 * Incremental yield labels must lockstep with the JSON Schema the validator
 * actually runs — including `$ref` inlining and closed `oneOf` unions.
 *
 * Closed `patternProperties` lives in
 * output-schema-open-pattern-properties-do-not-gate.test.ts.
 *
 * WHY THIS SUITE EXISTS. `buildOutputValidator` used to derive
 * `knownSectionLabels` / `rejectUnknownSections` from the wrapper object that
 * still held `{ $ref: "#/$defs/Closed", $defs: ... }`. AJV chased the ref at
 * `validate()` time, so a full payload was closed, but the yield gate saw no
 * `properties` / `additionalProperties` and let unknown labels through. Those
 * then failed only as parent-side `schema_violation` after the subagent had
 * already finished.
 *
 * `buildSectionValidators` walks `properties` with `for…in`. Inherited
 * enumerable keys on a prototype become fake section labels. Pin that they
 * do not.
 */
import { describe, expect, it } from "bun:test";
import { buildOutputValidator } from "@veyyon/coding-agent/tools/output-schema-validator";

describe("root $ref is inlined before incremental-label metadata is derived", () => {
	it("a closed $ref schema rejects unknown section labels and accepts the inlined property", () => {
		const { validator } = buildOutputValidator({
			$ref: "#/$defs/Closed",
			$defs: {
				Closed: {
					type: "object",
					additionalProperties: false,
					properties: {
						summary: { type: "string" },
						findings: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: { id: { type: "string" } },
								required: ["id"],
							},
						},
					},
					required: ["summary", "findings"],
				},
			},
		});
		expect(validator).toBeDefined();
		expect(validator?.rejectUnknownSections).toBe(true);
		expect(validator?.isKnownSection("summary")).toBe(true);
		expect(validator?.isKnownSection("findings")).toBe(true);
		expect(validator?.isKnownSection("other")).toBe(false);
		expect([...(validator?.knownSectionLabels ?? [])].sort()).toEqual(["findings", "summary"]);
	});
});

describe("closed oneOf unions gate labels disjunctively", () => {
	it("a label declared on any closed variant is known; a label on none is not", () => {
		const { validator } = buildOutputValidator({
			oneOf: [
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: { const: "a" },
						a: { type: "string" },
					},
					required: ["kind", "a"],
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: { const: "b" },
						b: { type: "number" },
					},
					required: ["kind", "b"],
				},
			],
		});
		expect(validator?.rejectUnknownSections).toBe(true);
		expect(validator?.isKnownSection("a")).toBe(true);
		expect(validator?.isKnownSection("b")).toBe(true);
		expect(validator?.isKnownSection("kind")).toBe(true);
		expect(validator?.isKnownSection("c")).toBe(false);
	});

	it("a oneOf with any open variant never rejects unknown labels", () => {
		const { validator } = buildOutputValidator({
			oneOf: [
				{
					type: "object",
					additionalProperties: false,
					properties: { a: { type: "string" } },
				},
				{
					type: "object",
					properties: { b: { type: "string" } },
				},
			],
		});
		expect(validator?.rejectUnknownSections).toBe(false);
		expect(validator?.isKnownSection("zzz")).toBe(true);
	});
});

describe("inherited enumerable keys on properties are not section labels", () => {
	it("a prototype `leaked` property is not a known incremental label", () => {
		const proto = { leaked: { type: "string" } };
		const properties = Object.assign(Object.create(proto), {
			summary: { type: "string" },
		});
		const { validator } = buildOutputValidator({
			type: "object",
			additionalProperties: false,
			properties,
			required: ["summary"],
		} as never);
		expect(validator?.isKnownSection("summary")).toBe(true);
		expect(validator?.isKnownSection("leaked")).toBe(false);
		expect(validator?.validateSection.has("leaked")).toBe(false);
		expect(validator?.knownSectionLabels).toEqual(["summary"]);
	});
});
