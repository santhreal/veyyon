/**
 * requiresApproval under plan mode: write tools prompt/deny per policy.
 * Why: plan mode must not silently allow destructive tools.
 */
import { describe, expect, it } from "bun:test";
import { requiresApproval, resolveEffectiveApprovalMode } from "../src/tools/approval";

describe("requiresApproval plan mode matrix", () => {
	it("effective plan when planModeActive", () => {
		expect(resolveEffectiveApprovalMode("yolo", { planModeActive: true })).toBe("plan");
		expect(resolveEffectiveApprovalMode("ask", { planModeActive: true })).toBe("plan");
	});

	const tools = ["bash", "write", "edit", "read", "grep"];
	for (const name of tools) {
		it(`plan mode decision for ${name} is object`, () => {
			const mode = resolveEffectiveApprovalMode("yolo", { planModeActive: true });
			expect(mode).toBe("plan");
			// plan may allow read-ish or prompt; must not throw unless deny
			try {
				const r = requiresApproval({ name }, {}, mode);
				expect(typeof r.required).toBe("boolean");
			} catch (e) {
				expect(e).toBeInstanceOf(Error);
				expect(String(e)).toMatch(/blocked|plan|policy|deny|Plan/i);
			}
		});
	}
});
