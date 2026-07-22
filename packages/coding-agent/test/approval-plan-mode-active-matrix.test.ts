/**
 * plan mode with planModeActive true/false for write and exec.
 */
import { describe, expect, it } from "bun:test";
import { resolveApproval } from "../src/tools/approval";

describe("resolveApproval planModeActive matrix", () => {
	it("write denied without planModeActive", () => {
		const r = resolveApproval(
			{ name: "write", approval: "write" },
			{},
			"plan",
			{},
			{ planModeActive: false },
		);
		expect(r.policy).toBe("deny");
	});

	it("write prompts with planModeActive", () => {
		const r = resolveApproval(
			{ name: "write", approval: "write" },
			{},
			"plan",
			{},
			{ planModeActive: true },
		);
		expect(r.policy).toBe("prompt");
	});

	it("exec denied even with planModeActive", () => {
		const r = resolveApproval(
			{ name: "bash", approval: "exec" },
			{},
			"plan",
			{},
			{ planModeActive: true },
		);
		expect(r.policy).toBe("deny");
	});

	it("read allowed under plan", () => {
		const r = resolveApproval(
			{ name: "read", approval: "read" },
			{},
			"plan",
			{},
			{ planModeActive: false },
		);
		expect(r.policy).toBe("allow");
	});
});
