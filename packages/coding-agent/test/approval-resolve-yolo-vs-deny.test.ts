/**
 * yolo allows exec; user deny still denies under yolo.
 */
import { describe, expect, it } from "bun:test";
import { resolveApproval } from "../src/tools/approval";

describe("resolveApproval yolo vs deny", () => {
	const tools = [
		{ name: "read", approval: "read" as const },
		{ name: "write", approval: "write" as const },
		{ name: "bash", approval: "exec" as const },
	];

	it("yolo allows all tiers", () => {
		for (const t of tools) {
			const r = resolveApproval(t, {}, "yolo", {});
			expect(r.policy).toBe("allow");
			expect(r.tier).toBe(t.approval);
		}
	});

	it("user deny beats yolo for each tool name", () => {
		for (const t of tools) {
			const r = resolveApproval(t, {}, "yolo", { [t.name]: "deny" });
			expect(r.policy).toBe("deny");
		}
	});

	it("user allow under always-ask for write", () => {
		const r = resolveApproval(
			{ name: "write", approval: "write" },
			{},
			"always-ask",
			{ write: "allow" },
		);
		expect(r.policy).toBe("allow");
	});
});
