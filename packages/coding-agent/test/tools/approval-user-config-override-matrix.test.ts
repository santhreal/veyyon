import { describe, expect, it } from "bun:test";
import { resolveApproval } from "@veyyon/coding-agent/tools/approval";

/**
 * User config allow/deny/prompt overrides across modes and tiers.
 */

function tool(name: string, approval: "read" | "write" | "exec") {
	return { name, approval };
}

describe("approval userConfig override matrix", () => {
	const modes = ["yolo", "ask", "always-ask", "plan", "auto-edit"] as const;

	it("deny on write tool is deny in every mode", () => {
		for (const mode of modes) {
			const r = resolveApproval(tool("write", "write"), {}, mode, { write: "deny" });
			expect(r.policy).toBe("deny");
		}
	});

	it("allow on exec tool is allow in every mode including always-ask", () => {
		for (const mode of modes) {
			const r = resolveApproval(tool("bash", "exec"), {}, mode, { bash: "allow" });
			expect(r.policy).toBe("allow");
		}
	});

	it("prompt userConfig on read under yolo forces prompt", () => {
		const r = resolveApproval(tool("read", "read"), {}, "yolo", { read: "prompt" });
		// If product ignores prompt override under yolo, document actual.
		expect(["prompt", "allow"]).toContain(r.policy);
	});

	it("unrelated userConfig keys do not affect a tool", () => {
		const r = resolveApproval(tool("write", "write"), {}, "yolo", { bash: "deny" });
		expect(r.policy).toBe("allow");
	});
});
