/**
 * formatApprovalPrompt: name line, MCP origin, reason, string/array details.
 * Why: operator prompt must not drop reason or invent MCP origin for local tools.
 */
import { describe, expect, it } from "bun:test";
import { formatApprovalPrompt } from "../src/tools/approval";

describe("formatApprovalPrompt reason and details matrix", () => {
	it("bare tool name only", () => {
		expect(formatApprovalPrompt({ name: "bash" }, {})).toBe("Allow tool: bash");
	});

	it("MCP tool without approval gets Origin line", () => {
		const out = formatApprovalPrompt({ name: "mcp__srv__tool" }, {});
		expect(out).toBe("Allow tool: mcp__srv__tool\nOrigin: MCP server tool");
	});

	it("MCP tool with approval field skips Origin", () => {
		const out = formatApprovalPrompt({ name: "mcp__srv__tool", approval: "ask" as never }, {});
		expect(out).toBe("Allow tool: mcp__srv__tool");
	});

	it("reason line exact", () => {
		const out = formatApprovalPrompt({ name: "write" }, {}, "path outside workspace");
		expect(out).toBe("Allow tool: write\nReason: path outside workspace");
	});

	it("string formatApprovalDetails appended", () => {
		const out = formatApprovalPrompt(
			{
				name: "bash",
				formatApprovalDetails: () => "cmd: ls",
			},
			{},
		);
		expect(out).toBe("Allow tool: bash\ncmd: ls");
	});

	it("array formatApprovalDetails multi-line", () => {
		const out = formatApprovalPrompt(
			{
				name: "edit",
				formatApprovalDetails: () => ["file: a.ts", "lines: 1-3"],
			},
			{},
		);
		expect(out).toBe("Allow tool: edit\nfile: a.ts\nlines: 1-3");
	});

	it("empty string details omitted", () => {
		const out = formatApprovalPrompt({ name: "bash", formatApprovalDetails: () => "" }, {});
		expect(out).toBe("Allow tool: bash");
	});

	it("empty array entries skipped", () => {
		const out = formatApprovalPrompt({ name: "bash", formatApprovalDetails: () => ["", "keep", ""] }, {});
		expect(out).toBe("Allow tool: bash\nkeep");
	});

	const tools = ["bash", "read", "write", "edit", "grep", "glob", "mcp__a__b", "resolve"];
	for (const name of tools) {
		it(`name line for ${name}`, () => {
			expect(formatApprovalPrompt({ name }, {}).startsWith(`Allow tool: ${name}`)).toBe(true);
		});
	}
});
