/**
 * requiresApproval: deny throws; prompt returns required true; allow required false.
 * Why: fail-closed deny must throw; prompt must not throw.
 */
import { describe, expect, it } from "bun:test";
import { requiresApproval } from "../src/tools/approval";

function tool(name: string, tier: "read" | "write" | "exec") {
	// `tier` is already the narrow ToolTier union; `as const` is invalid on a
	// reference (TS1355) and unnecessary, so pass it through directly.
	return { name, approval: tier };
}

describe("requiresApproval throw and prompt matrix", () => {
	it("plan mode denies write with Plan autonomy message", () => {
		expect(() => requiresApproval(tool("write_file", "write"), {}, "plan", {}, { planModeActive: false })).toThrow(
			/Plan autonomy|non-mutating/,
		);
	});

	it("user deny always throws naming tool", () => {
		expect(() => requiresApproval(tool("bash", "exec"), {}, "yolo", { bash: "deny" })).toThrow(/bash/);
		try {
			requiresApproval(tool("bash", "exec"), {}, "yolo", { bash: "deny" });
		} catch (e) {
			expect(String(e)).toContain("tools.approval.bash: deny");
		}
	});

	it("ask mode write returns required true", () => {
		const r = requiresApproval(tool("edit", "write"), {}, "ask", {});
		expect(r.required).toBe(true);
	});

	it("yolo mode write returns required false", () => {
		const r = requiresApproval(tool("edit", "write"), {}, "yolo", {});
		expect(r.required).toBe(false);
	});

	it("yolo mode exec returns required false", () => {
		const r = requiresApproval(tool("bash", "exec"), {}, "yolo", {});
		expect(r.required).toBe(false);
	});

	it("auto-edit allows write, prompts exec", () => {
		expect(requiresApproval(tool("w", "write"), {}, "auto-edit", {}).required).toBe(false);
		expect(requiresApproval(tool("e", "exec"), {}, "auto-edit", {}).required).toBe(true);
	});

	it("read runs unasked on every rung above ask, and asks on ask", () => {
		for (const mode of ["plan", "ask-command", "auto", "yolo"] as const) {
			expect(requiresApproval(tool("read", "read"), {}, mode, {}).required).toBe(false);
		}
		// `ask` is the exception and the point of the rung: it asks about reads too.
		expect(requiresApproval(tool("read", "read"), {}, "ask", {}).required).toBe(true);
	});
});
