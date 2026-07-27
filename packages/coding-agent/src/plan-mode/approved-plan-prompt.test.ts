import { describe, expect, it } from "bun:test";
import { prompt } from "@veyyon/utils";
import { planModePrompts } from "../prompts/plan-mode/rows";

const PLAN_FILE_PATH = "local://durable-plan.md";
const PLAN_SENTINEL = "SENTINEL_HEADROOM_COMPRESSED_PLAN_CONTENT";

describe("approved plan execution prompts", () => {
	it("requires reading the durable plan file without inlining plan content", () => {
		const approved = prompt.render(planModePrompts["plan-mode/approved"].text, {
			planContent: PLAN_SENTINEL,
			planFilePath: PLAN_FILE_PATH,
			contextPreserved: false,
		});
		const reference = prompt.render(planModePrompts["plan-mode/reference"].text, {
			planContent: PLAN_SENTINEL,
			planFilePath: PLAN_FILE_PATH,
		});
		const compact = prompt.render(planModePrompts["plan-mode/compact-instructions"].text, {
			planFilePath: PLAN_FILE_PATH,
		});

		for (const rendered of [approved, reference, compact]) {
			expect(rendered).toContain(PLAN_FILE_PATH);
		}
		for (const rendered of [approved, reference, compact]) {
			expect(rendered).not.toContain(PLAN_SENTINEL);
		}
		expect(approved).toContain("MUST read `local://durable-plan.md`");
		expect(reference).toContain("MUST read `local://durable-plan.md`");
	});
});
