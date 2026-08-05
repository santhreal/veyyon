/**
 * resolveApproval tier × mode matrix with exact policy outcomes.
 */
import { describe, expect, it } from "bun:test";
import { type ApprovalMode, resolveApproval } from "../src/tools/approval";
import { APPROVAL_MODE_VALUES } from "../src/tools/approval-modes";

const tiers = ["read", "write", "exec"] as const;
const modes: readonly ApprovalMode[] = APPROVAL_MODE_VALUES;

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

	it("auto allows all annotated tiers", () => {
		for (const t of tiers) {
			const r = resolveApproval(tool(t, t), {}, "auto", {});
			expect(r.policy).toBe("allow");
			expect(r.tier).toBe(t);
		}
	});

	it("ask prompts every tier, reads included", () => {
		expect(resolveApproval(tool("r", "read"), {}, "ask", {}).policy).toBe("prompt");
		expect(resolveApproval(tool("w", "write"), {}, "ask", {}).policy).toBe("prompt");
		expect(resolveApproval(tool("e", "exec"), {}, "ask", {}).policy).toBe("prompt");
	});

	/**
	 * Spelled out on its own because it is the rung's whole point and the easiest
	 * thing to regress: "ask about everything" has to include a plain read, or a
	 * `read` of `~/.ssh/id_rsa` slips past the rung an operator picked precisely
	 * to stop it.
	 */
	it("ask prompts a READ-tier tool rather than exempting it", () => {
		const r = resolveApproval(tool("read", "read"), {}, "ask", {});

		expect(r.policy).toBe("prompt");
		expect(r.tier).toBe("read");
	});

	it("always-ask alias prompts every tier just like ask", () => {
		expect(resolveApproval(tool("r", "read"), {}, "always-ask", {}).policy).toBe("prompt");
		expect(resolveApproval(tool("w", "write"), {}, "always-ask", {}).policy).toBe("prompt");
		expect(resolveApproval(tool("e", "exec"), {}, "always-ask", {}).policy).toBe("prompt");
	});

	it("ask-command allows read+write; prompts exec", () => {
		expect(resolveApproval(tool("r", "read"), {}, "ask-command", {}).policy).toBe("allow");
		expect(resolveApproval(tool("w", "write"), {}, "ask-command", {}).policy).toBe("allow");
		expect(resolveApproval(tool("e", "exec"), {}, "ask-command", {}).policy).toBe("prompt");
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
		const r = resolveApproval(tool("mystery", undefined), {}, "ask", {});
		expect(r.tier).toBe("exec");
		expect(r.policy).toBe("prompt");
	});
});
