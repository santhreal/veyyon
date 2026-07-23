/**
 * resolveApproval tier × mode matrix with exact policy outcomes.
 */
import { describe, expect, it } from "bun:test";
import { type ApprovalMode, resolveApproval } from "../src/tools/approval";

const tiers = ["read", "write", "exec"] as const;
const modes: ApprovalMode[] = ["plan", "ask", "always-ask", "auto-edit", "write", "yolo"];

function tool(name: string, approval: (typeof tiers)[number] | undefined) {
	return approval ? { name, approval } : { name };
}

describe("resolveApproval mode×tier matrix", () => {
	it("yolo allows all annotated tiers", () => {
		for (const t of tiers) {
			const r = resolveApproval(tool(t, t), {}, "yolo", {});
			expect(r.policy).toBe("allow");
			expect(r.tier).toBe(t);
		}
	});

	it("always-ask allows only read; prompts write and exec", () => {
		expect(resolveApproval(tool("r", "read"), {}, "always-ask", {}).policy).toBe("allow");
		expect(resolveApproval(tool("w", "write"), {}, "always-ask", {}).policy).toBe("prompt");
		expect(resolveApproval(tool("e", "exec"), {}, "always-ask", {}).policy).toBe("prompt");
	});

	it("auto-edit allows read+write; prompts exec", () => {
		expect(resolveApproval(tool("r", "read"), {}, "auto-edit", {}).policy).toBe("allow");
		expect(resolveApproval(tool("w", "write"), {}, "auto-edit", {}).policy).toBe("allow");
		expect(resolveApproval(tool("e", "exec"), {}, "auto-edit", {}).policy).toBe("prompt");
	});

	it("plan without planModeActive denies write and exec", () => {
		expect(resolveApproval(tool("r", "read"), {}, "plan", {}, { planModeActive: false }).policy).toBe("allow");
		expect(resolveApproval(tool("w", "write"), {}, "plan", {}, { planModeActive: false }).policy).toBe("deny");
		expect(resolveApproval(tool("e", "exec"), {}, "plan", {}, { planModeActive: false }).policy).toBe("deny");
	});

	it("user deny always wins over mode allow", () => {
		for (const mode of modes) {
			const r = resolveApproval(tool("bash", "exec"), {}, mode, { bash: "deny" });
			expect(r.policy).toBe("deny");
		}
	});

	it("unannotated tool defaults to exec tier", () => {
		const r = resolveApproval(tool("mystery", undefined), {}, "always-ask", {});
		expect(r.tier).toBe("exec");
		expect(r.policy).toBe("prompt");
	});
});
