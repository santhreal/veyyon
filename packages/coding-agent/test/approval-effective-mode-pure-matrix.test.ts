/**
 * resolveEffectiveApprovalMode: cliAutoApprove wins; planModeActive caps; else configured.
 * Why: session plan-mode must not silently keep yolo; CLI yolo must override plan.
 */
import { describe, expect, it } from "bun:test";
import { resolveEffectiveApprovalMode } from "../src/tools/approval";

describe("resolveEffectiveApprovalMode pure matrix", () => {
	const configs = [undefined, "yolo", "ask", "plan", "auto-edit", "write"] as const;

	it("cliAutoApprove forces yolo regardless of config or plan", () => {
		for (const c of configs) {
			expect(resolveEffectiveApprovalMode(c, { cliAutoApprove: true, planModeActive: true })).toBe("yolo");
			expect(resolveEffectiveApprovalMode(c, { cliAutoApprove: true })).toBe("yolo");
		}
	});

	it("planModeActive forces plan when not cli yolo", () => {
		for (const c of configs) {
			expect(resolveEffectiveApprovalMode(c, { planModeActive: true })).toBe("plan");
		}
	});

	it("configured passed through when neither flag", () => {
		expect(resolveEffectiveApprovalMode("ask")).toBe("ask");
		expect(resolveEffectiveApprovalMode("plan")).toBe("plan");
		expect(resolveEffectiveApprovalMode("auto-edit")).toBe("auto-edit");
		expect(resolveEffectiveApprovalMode("yolo")).toBe("yolo");
		expect(resolveEffectiveApprovalMode(undefined)).toBe("yolo");
	});

	it("cli wins over plan when both set", () => {
		expect(resolveEffectiveApprovalMode("ask", { cliAutoApprove: true, planModeActive: true })).toBe("yolo");
	});
});
