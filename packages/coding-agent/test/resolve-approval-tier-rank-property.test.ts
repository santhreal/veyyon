/**
 * resolveApproval autonomy ladder property: exact policy for every mode×tier.
 * Signature: (tool, args, mode, userConfig, options).
 */
import { describe, expect, it } from "bun:test";
import { resolveApproval } from "@veyyon/coding-agent/tools/approval";

function tool(name: string, tier: "read" | "write" | "exec") {
	return { name, approval: tier };
}

describe("resolveApproval tier rank property", () => {
	const tiers = ["read", "write", "exec"] as const;

	it("yolo allows all annotated tiers", () => {
		for (const t of tiers) {
			const r = resolveApproval(tool(t, t), {}, "yolo", {});
			expect(r.policy).toBe("allow");
			expect(r.tier).toBe(t);
		}
	});

	it("auto-edit allows read+write, prompts exec", () => {
		expect(resolveApproval(tool("r", "read"), {}, "auto-edit", {}).policy).toBe("allow");
		expect(resolveApproval(tool("w", "write"), {}, "auto-edit", {}).policy).toBe("allow");
		expect(resolveApproval(tool("e", "exec"), {}, "auto-edit", {}).policy).toBe("prompt");
	});

	it("ask/always-ask allow only read", () => {
		for (const mode of ["ask", "always-ask"] as const) {
			expect(resolveApproval(tool("r", "read"), {}, mode, {}).policy).toBe("allow");
			expect(resolveApproval(tool("w", "write"), {}, mode, {}).policy).toBe("prompt");
			expect(resolveApproval(tool("e", "exec"), {}, mode, {}).policy).toBe("prompt");
		}
	});

	it("plan without planModeActive denies write/exec", () => {
		const opts = { planModeActive: false };
		expect(resolveApproval(tool("r", "read"), {}, "plan", {}, opts).policy).toBe("allow");
		expect(resolveApproval(tool("w", "write"), {}, "plan", {}, opts).policy).toBe("deny");
		expect(resolveApproval(tool("e", "exec"), {}, "plan", {}, opts).policy).toBe("deny");
	});

	it("user deny beats yolo", () => {
		const r = resolveApproval(tool("bash", "exec"), {}, "yolo", { bash: "deny" });
		expect(r.policy).toBe("deny");
	});

	it("bypassAllApprovals upgrades prompt not deny", () => {
		const p = resolveApproval(tool("e", "exec"), {}, "ask", {}, { bypassAllApprovals: true });
		expect(p.policy).toBe("allow");
		const d = resolveApproval(tool("bash", "exec"), {}, "yolo", { bash: "deny" }, {
			bypassAllApprovals: true,
		});
		expect(d.policy).toBe("deny");
	});

	it("unannotated defaults to exec tier", () => {
		const r = resolveApproval({ name: "mystery" }, {}, "always-ask", {});
		expect(r.tier).toBe("exec");
		expect(r.policy).toBe("prompt");
	});
});
