/**
 * patternProperties on an OPEN object do not engage the unknown-label gate.
 *
 * WHY THIS SUITE EXISTS. `rejectUnknownSections` is a closure check
 * (`additionalProperties: false` on a conjunct), not "the schema mentioned
 * some names". An open object with `patternProperties: { "^x-": ... }` still
 * accepts `y-foo` as a top-level key, so rejecting that label at yield time
 * would be a false positive the assembled-output validator would then accept.
 */
import { describe, expect, it } from "bun:test";
import { buildOutputValidator } from "@veyyon/coding-agent/tools/output-schema-validator";

describe("open object + patternProperties does not reject unknown labels", () => {
	it("y-foo is known because the object is open, even though it misses ^x-", () => {
		const { validator } = buildOutputValidator({
			type: "object",
			patternProperties: { "^x-": { type: "string" } },
		});
		expect(validator?.rejectUnknownSections).toBe(false);
		expect(validator?.isKnownSection("y-foo")).toBe(true);
		expect(validator?.isKnownSection("x-foo")).toBe(true);
	});
});

describe("closed object + patternProperties still rejects non-matching labels", () => {
	it("additionalProperties false + ^x- rejects y-foo", () => {
		const { validator } = buildOutputValidator({
			type: "object",
			additionalProperties: false,
			patternProperties: { "^x-": { type: "string" } },
		});
		expect(validator?.rejectUnknownSections).toBe(true);
		expect(validator?.isKnownSection("x-bar")).toBe(true);
		expect(validator?.isKnownSection("y-bar")).toBe(false);
	});
});
