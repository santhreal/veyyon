/**
 * resolveEffectiveApprovalMode: cliAutoApprove wins; planModeActive caps; else configured.
 * Why: session plan-mode must not silently keep yolo; CLI yolo must override plan.
 *
 * This function picks the rung, it does not normalize it. A configured legacy
 * alias comes back out spelled exactly as it went in; `normalizeApprovalMode`
 * maps it to a rung later, downstream. The assertions below say what the
 * function returns rather than what the value eventually means.
 */
import { describe, expect, it } from "bun:test";
import { resolveEffectiveApprovalMode } from "../src/tools/approval";

describe("resolveEffectiveApprovalMode pure matrix", () => {
	const configs = [undefined, "yolo", "auto", "ask", "ask-command", "plan", "auto-edit", "write"] as const;

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
		expect(resolveEffectiveApprovalMode("ask-command")).toBe("ask-command");
		expect(resolveEffectiveApprovalMode("auto")).toBe("auto");
		expect(resolveEffectiveApprovalMode("plan")).toBe("plan");
		expect(resolveEffectiveApprovalMode("yolo")).toBe("yolo");
	});

	it("a legacy alias is passed through unchanged, not normalized here", () => {
		expect(resolveEffectiveApprovalMode("auto-edit")).toBe("auto-edit");
		expect(resolveEffectiveApprovalMode("write")).toBe("write");
		expect(resolveEffectiveApprovalMode("always-ask")).toBe("always-ask");
	});

	/**
	 * A LITERAL, not `DEFAULT_APPROVAL_MODE`. This asserted `toBe(DEFAULT_APPROVAL_MODE)`, so the
	 * expectation moved with the value it exists to pin: the shipped default was `yolo` and this case
	 * was green the whole time, while every rung, the tier ceiling and the critical floor were dead
	 * for anyone who had not opened /settings. What the ladder actually DOES on a fresh install is
	 * driven in `test/approval-ladder-fires-on-a-fresh-install.test.ts`; this only says which rung.
	 */
	it("nothing configured falls back to auto, the rung a fresh install runs on", () => {
		expect(resolveEffectiveApprovalMode(undefined)).toBe("auto");
	});

	it("cli wins over plan when both set", () => {
		expect(resolveEffectiveApprovalMode("ask", { cliAutoApprove: true, planModeActive: true })).toBe("yolo");
	});
});
