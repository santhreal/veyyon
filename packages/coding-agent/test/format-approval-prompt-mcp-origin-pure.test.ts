/**
 * formatApprovalPrompt: MCP tools without approval annotation get Origin line.
 * Why: MCP tools default to exec and must be labeled so operators see origin.
 */
import { describe, expect, it } from "bun:test";
import { formatApprovalPrompt } from "../src/tools/approval";

describe("formatApprovalPrompt MCP origin pure", () => {
	it("mcp__ tool without approval adds Origin line", () => {
		const body = formatApprovalPrompt({ name: "mcp__server__tool" }, {});
		expect(body).toBe("Allow tool: mcp__server__tool\nOrigin: MCP server tool");
	});

	it("mcp__ tool with approval omits Origin", () => {
		const body = formatApprovalPrompt({ name: "mcp__server__tool", approval: "read" }, {});
		expect(body).toBe("Allow tool: mcp__server__tool");
		expect(body).not.toContain("Origin");
	});

	it("non-mcp tool never Origin", () => {
		const body = formatApprovalPrompt({ name: "bash" }, {});
		expect(body).toBe("Allow tool: bash");
	});

	it("reason line after name", () => {
		const body = formatApprovalPrompt({ name: "bash" }, {}, "exec tier");
		expect(body).toBe("Allow tool: bash\nReason: exec tier");
	});

	it("formatApprovalDetails string appended", () => {
		const body = formatApprovalPrompt(
			{
				name: "write",
				formatApprovalDetails: () => "path: /tmp/x",
			},
			{},
		);
		expect(body).toBe("Allow tool: write\npath: /tmp/x");
	});

	it("formatApprovalDetails array skips empty strings", () => {
		const body = formatApprovalPrompt(
			{
				name: "write",
				formatApprovalDetails: () => ["line1", "", "line2"],
			},
			{},
		);
		expect(body).toBe("Allow tool: write\nline1\nline2");
	});

	it("mcp + reason + details order", () => {
		const body = formatApprovalPrompt(
			{
				name: "mcp__s__t",
				formatApprovalDetails: () => ["d1"],
			},
			{},
			"why",
		);
		expect(body).toBe(
			"Allow tool: mcp__s__t\nOrigin: MCP server tool\nReason: why\nd1",
		);
	});
});
