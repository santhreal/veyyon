import { describe, expect, it } from "bun:test";
import { supportsFreeformApplyPatch } from "../src/providers/openai-responses-helpers";
import type { Model } from "../src/types";

function makeModel(applyPatchToolType?: string): Model<"openai-responses"> {
	return {
		id: "gpt-4o",
		provider: "openai",
		api: "openai-responses",
		applyPatchToolType,
	} as unknown as Model<"openai-responses">;
}

describe("supportsFreeformApplyPatch", () => {
	it("returns true when applyPatchToolType is 'freeform'", () => {
		expect(supportsFreeformApplyPatch(makeModel("freeform"))).toBe(true);
	});
	it("returns false when applyPatchToolType is undefined", () => {
		expect(supportsFreeformApplyPatch(makeModel(undefined))).toBe(false);
	});
	it("returns false when applyPatchToolType is 'strict'", () => {
		expect(supportsFreeformApplyPatch(makeModel("strict"))).toBe(false);
	});
	it("returns false when applyPatchToolType is some other value", () => {
		expect(supportsFreeformApplyPatch(makeModel("custom"))).toBe(false);
	});
});
