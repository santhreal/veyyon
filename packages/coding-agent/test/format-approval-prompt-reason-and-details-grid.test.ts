/**
 * formatApprovalPrompt combinations of reason + string/array details.
 */
import { describe, expect, it } from "bun:test";
import { formatApprovalPrompt } from "../src/tools/approval";

describe("formatApprovalPrompt reason and details grid", () => {
	it("name only", () => {
		expect(formatApprovalPrompt({ name: "bash" }, {})).toBe("Allow tool: bash");
	});

	it("reason only", () => {
		expect(formatApprovalPrompt({ name: "bash" }, {}, "why")).toBe(
			"Allow tool: bash\nReason: why",
		);
	});

	it("string details", () => {
		expect(
			formatApprovalPrompt(
				{ name: "w", formatApprovalDetails: () => "path: /tmp" },
				{},
			),
		).toBe("Allow tool: w\npath: /tmp");
	});

	it("empty string details omitted", () => {
		expect(
			formatApprovalPrompt({ name: "w", formatApprovalDetails: () => "" }, {}),
		).toBe("Allow tool: w");
	});

	it("array details skips empties", () => {
		expect(
			formatApprovalPrompt(
				{ name: "w", formatApprovalDetails: () => ["a", "", "b"] },
				{},
			),
		).toBe("Allow tool: w\na\nb");
	});

	it("mcp origin + reason + details", () => {
		expect(
			formatApprovalPrompt(
				{
					name: "mcp__s__t",
					formatApprovalDetails: () => ["d"],
				},
				{},
				"r",
			),
		).toBe("Allow tool: mcp__s__t\nOrigin: MCP server tool\nReason: r\nd");
	});

	const tools = ["bash", "edit", "read", "write", "mcp__x__y"];
	for (const name of tools) {
		it(`name line for ${name}`, () => {
			expect(formatApprovalPrompt({ name }, {}).startsWith(`Allow tool: ${name}`)).toBe(
				true,
			);
		});
	}
});
