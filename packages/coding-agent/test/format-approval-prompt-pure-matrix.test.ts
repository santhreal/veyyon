/**
 * formatApprovalPrompt exact line layout: tool name, MCP origin tag when
 * name starts with mcp__ and approval unset, reason, formatApprovalDetails.
 */
import { describe, expect, it } from "bun:test";
import { formatApprovalPrompt } from "@veyyon/coding-agent/tools/approval";

describe("formatApprovalPrompt pure matrix", () => {
	it("bare tool name only", () => {
		expect(formatApprovalPrompt({ name: "bash" }, {})).toBe("Allow tool: bash");
	});

	it("MCP origin when name is mcp__* and approval undefined", () => {
		const out = formatApprovalPrompt({ name: "mcp__github_list" }, { q: 1 });
		expect(out).toBe("Allow tool: mcp__github_list\nOrigin: MCP server tool");
	});

	it("MCP name with explicit approval skips origin tag", () => {
		const out = formatApprovalPrompt({ name: "mcp__github_list", approval: "prompt" as never }, {});
		expect(out).toBe("Allow tool: mcp__github_list");
	});

	it("reason line", () => {
		expect(formatApprovalPrompt({ name: "write" }, {}, "outside workspace")).toBe(
			"Allow tool: write\nReason: outside workspace",
		);
	});

	it("string formatApprovalDetails", () => {
		const out = formatApprovalPrompt(
			{
				name: "bash",
				formatApprovalDetails: () => "cmd: rm -rf /",
			},
			{ command: "rm -rf /" },
		);
		expect(out).toBe("Allow tool: bash\ncmd: rm -rf /");
	});

	it("array formatApprovalDetails skips empty strings", () => {
		const out = formatApprovalPrompt(
			{
				name: "edit",
				formatApprovalDetails: () => ["path: a.ts", "", "lines: 1-3"],
			},
			{},
		);
		expect(out).toBe("Allow tool: edit\npath: a.ts\nlines: 1-3");
	});

	it("MCP + reason + details stack in order", () => {
		const out = formatApprovalPrompt(
			{
				name: "mcp__srv_tool",
				formatApprovalDetails: () => "arg: 1",
			},
			{ a: 1 },
			"tier",
		);
		expect(out).toBe("Allow tool: mcp__srv_tool\nOrigin: MCP server tool\nReason: tier\narg: 1");
	});
});
