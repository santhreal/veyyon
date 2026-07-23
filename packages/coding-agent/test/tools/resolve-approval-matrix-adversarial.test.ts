import { describe, expect, it } from "bun:test";
import { requiresApproval, resolveApproval, truncateForPrompt } from "@veyyon/coding-agent/tools/approval";

/**
 * resolveApproval matrix: yolo/ask/plan/always-ask × read/write/exec tiers,
 * user deny overrides, planModeActive lift. Exact policy strings.
 */

function tool(name: string, approval: "read" | "write" | "exec") {
	return { name, approval };
}

describe("resolveApproval matrix adversarial", () => {
	it("yolo allows exec and write", () => {
		expect(resolveApproval(tool("bash", "exec"), {}, "yolo").policy).toBe("allow");
		expect(resolveApproval(tool("write", "write"), {}, "yolo").policy).toBe("allow");
		expect(resolveApproval(tool("read", "read"), {}, "yolo").policy).toBe("allow");
	});

	it("always-ask prompts write and exec but allows read", () => {
		expect(resolveApproval(tool("write", "write"), {}, "always-ask").policy).toBe("prompt");
		expect(resolveApproval(tool("bash", "exec"), {}, "always-ask").policy).toBe("prompt");
		expect(resolveApproval(tool("read", "read"), {}, "always-ask").policy).toBe("allow");
	});

	it("ask mode allows read, prompts write and exec", () => {
		expect(resolveApproval(tool("read", "read"), {}, "ask").policy).toBe("allow");
		expect(resolveApproval(tool("write", "write"), {}, "ask").policy).toBe("prompt");
		expect(resolveApproval(tool("bash", "exec"), {}, "ask").policy).toBe("prompt");
	});

	it("user deny on a tool stays deny even under yolo", () => {
		const resolved = resolveApproval(tool("bash", "exec"), {}, "yolo", { bash: "deny" });
		expect(resolved.policy).toBe("deny");
	});

	it("user allow on exec under always-ask can allow without prompt", () => {
		const resolved = resolveApproval(tool("bash", "exec"), {}, "always-ask", { bash: "allow" });
		expect(resolved.policy).toBe("allow");
	});

	it("plan autonomy without planModeActive denies write", () => {
		const resolved = resolveApproval(
			tool("write", "write"),
			{},
			"plan",
			{},
			{
				planModeActive: false,
			},
		);
		expect(resolved.policy).toBe("deny");
		expect((resolved.reason ?? "").toLowerCase()).toMatch(/plan/);
	});

	it("plan autonomy with planModeActive lifts write to prompt", () => {
		const resolved = resolveApproval(
			tool("write", "write"),
			{},
			"plan",
			{},
			{
				planModeActive: true,
			},
		);
		expect(resolved.policy).toBe("prompt");
	});

	it("plan mode still allows read", () => {
		expect(resolveApproval(tool("read", "read"), {}, "plan").policy).toBe("allow");
	});

	it("bypassAllApprovals turns prompt into allow", () => {
		const resolved = resolveApproval(
			tool("write", "write"),
			{},
			"always-ask",
			{},
			{
				bypassAllApprovals: true,
			},
		);
		expect(resolved.policy).toBe("allow");
	});

	it("bypassAllApprovals does not lift an explicit user deny", () => {
		const resolved = resolveApproval(
			tool("bash", "exec"),
			{},
			"yolo",
			{ bash: "deny" },
			{
				bypassAllApprovals: true,
			},
		);
		expect(resolved.policy).toBe("deny");
	});
});

describe("requiresApproval", () => {
	it("returns required false when policy is allow", () => {
		expect(requiresApproval(tool("read", "read"), {}, "yolo").required).toBe(false);
	});

	it("returns required true when policy is prompt", () => {
		expect(requiresApproval(tool("write", "write"), {}, "always-ask").required).toBe(true);
	});

	it("throws when policy is deny", () => {
		expect(() => requiresApproval(tool("bash", "exec"), {}, "yolo", { bash: "deny" })).toThrow(/block|deny|policy/i);
	});
});

describe("truncateForPrompt", () => {
	it("returns short strings unchanged", () => {
		expect(truncateForPrompt("hello", 100)).toBe("hello");
	});

	it("elides long strings with a length marker", () => {
		const long = "x".repeat(500);
		const out = truncateForPrompt(long, 50);
		expect(out.length).toBeLessThan(long.length);
		expect(out).toMatch(/elided|…|\.\.\./);
		expect(out.startsWith("x".repeat(10))).toBe(true);
	});
});
