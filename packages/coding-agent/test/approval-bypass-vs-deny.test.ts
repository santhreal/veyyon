/**
 * bypassAllApprovals upgrades prompt to allow but not deny.
 */
import { describe, expect, it } from "bun:test";
import { resolveApproval } from "../src/tools/approval";

describe("resolveApproval bypass vs deny", () => {
	it("bypass allows always-ask exec", () => {
		const r = resolveApproval(
			{ name: "bash", approval: "exec" },
			{},
			"always-ask",
			{},
			{ bypassAllApprovals: true },
		);
		expect(r.policy).toBe("allow");
	});

	it("bypass does not override deny", () => {
		const r = resolveApproval(
			{ name: "bash", approval: "exec" },
			{},
			"always-ask",
			{ bash: "deny" },
			{ bypassAllApprovals: true },
		);
		expect(r.policy).toBe("deny");
	});

	it("bypass does not override plan write deny without planModeActive", () => {
		const r = resolveApproval(
			{ name: "write", approval: "write" },
			{},
			"plan",
			{},
			{ bypassAllApprovals: true, planModeActive: false },
		);
		// plan deny is hard deny — bypass should not open it
		expect(r.policy).toBe("deny");
	});
});
