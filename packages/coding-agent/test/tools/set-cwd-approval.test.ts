import { describe, expect, it } from "bun:test";
import { resolveApproval } from "@veyyon/coding-agent/tools/approval";
import { SetCwdTool } from "@veyyon/coding-agent/tools/set-cwd";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { Settings } from "@veyyon/coding-agent/config/settings";

function session(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		setCwd: async resolved => resolved,
	};
}

describe("set_cwd write-tier approval", () => {
	it("prompts in always-ask, allows in yolo, and denies under user deny", () => {
		const tool = new SetCwdTool(session("/tmp/old"));
		expect(tool.approval).toBe("write");

		expect(resolveApproval(tool, { path: "/tmp/new" }, "always-ask")).toMatchObject({
			policy: "prompt",
			tier: "write",
		});
		expect(resolveApproval(tool, { path: "/tmp/new" }, "yolo")).toMatchObject({
			policy: "allow",
			tier: "write",
		});
		expect(
			resolveApproval(tool, { path: "/tmp/new" }, "yolo", { set_cwd: "deny" }),
		).toMatchObject({
			policy: "deny",
			tier: "write",
		});
	});

	it("allows under bypassAllApprovals even when the mode would prompt", () => {
		const tool = new SetCwdTool(session("/tmp/old"));
		expect(resolveApproval(tool, { path: "/tmp/new" }, "always-ask", {}, { bypassAllApprovals: true })).toMatchObject(
			{
				policy: "allow",
				tier: "write",
			},
		);
		// Explicit deny still wins over bypass.
		expect(
			resolveApproval(tool, { path: "/tmp/new" }, "always-ask", { set_cwd: "deny" }, { bypassAllApprovals: true }),
		).toMatchObject({
			policy: "deny",
			tier: "write",
		});
	});

	it("formatApprovalDetails shows old → new working directory", () => {
		const tool = new SetCwdTool(session("/tmp/old-root"));
		expect(tool.formatApprovalDetails({ path: "/tmp/new-root" })).toEqual([
			"Working directory: /tmp/old-root → /tmp/new-root",
		]);
		expect(tool.formatApprovalDetails({ path: "relative/child" })).toEqual([
			"Working directory: /tmp/old-root → /tmp/old-root/relative/child",
		]);
	});
});
