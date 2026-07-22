/**
 * requiresApproval: yolo never required; ask always required for default tools.
 * Why: fail-closed ask vs yolo must not invert on plain tools without userConfig.
 */
import { describe, expect, it } from "bun:test";
import { requiresApproval } from "../src/tools/approval";

describe("requiresApproval yolo and ask matrix", () => {
	const tools = ["bash", "read", "write", "edit", "grep", "glob", "fetch"].map((name) => ({
		name,
	}));

	for (const tool of tools) {
		it(`yolo ${tool.name} not required`, () => {
			expect(requiresApproval(tool, {}, "yolo")).toEqual({ required: false });
		});

		it(`ask ${tool.name} required`, () => {
			const r = requiresApproval(tool, {}, "ask");
			expect(r.required).toBe(true);
		});
	}

	it("userConfig deny throws", () => {
		expect(() =>
			requiresApproval({ name: "bash" }, {}, "yolo", { bash: "deny" }),
		).toThrow();
	});
});
