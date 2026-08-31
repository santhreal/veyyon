import { describe, expect, it } from "bun:test";
import { renderToolInventory } from "../src/dialect/inventory";

describe("renderToolInventory", () => {
	it("returns empty string for empty tools", () => {
		expect(renderToolInventory([], "deepseek/deepseek-chat")).toBe("");
	});
	it("renders tool with name and parameters", () => {
		const tool = {
			name: "getWeather",
			description: "Get the weather",
			parameters: { type: "object", properties: { city: { type: "string" } } },
		};
		const result = renderToolInventory([tool], "deepseek/deepseek-chat");
		expect(result).toContain("# Tool: getWeather");
		expect(result).toContain("Get the weather");
		expect(result).toContain("Parameters:");
	});
	it("renders multiple tools separated by newlines", () => {
		const tools = [
			{ name: "tool1", description: "First tool", parameters: { type: "object" } },
			{ name: "tool2", description: "Second tool", parameters: { type: "object" } },
		];
		const result = renderToolInventory(tools, "deepseek/deepseek-chat");
		expect(result).toContain("# Tool: tool1");
		expect(result).toContain("# Tool: tool2");
	});
	it("handles tool without description", () => {
		const tool = {
			name: "noop",
			parameters: { type: "object" },
		};
		const result = renderToolInventory([tool], "deepseek/deepseek-chat");
		expect(result).toContain("# Tool: noop");
	});
	it("demotes top-level headers in description", () => {
		const tool = {
			name: "complex",
			description: "# Top Level Header\n\nSome content",
			parameters: { type: "object" },
		};
		const result = renderToolInventory([tool], "deepseek/deepseek-chat");
		expect(result).toContain("## Top Level Header");
		expect(result).not.toMatch(/^# Top Level Header$/m);
	});
	it("does not demote headers inside code fences", () => {
		const tool = {
			name: "fenced",
			description: "```\n# Not a header\n```",
			parameters: { type: "object" },
		};
		const result = renderToolInventory([tool], "deepseek/deepseek-chat");
		expect(result).toContain("# Not a header");
	});
	it("does not demote non-top-level headers", () => {
		const tool = {
			name: "subheaders",
			description: "## Already Sub Header",
			parameters: { type: "object" },
		};
		const result = renderToolInventory([tool], "deepseek/deepseek-chat");
		expect(result).toContain("## Already Sub Header");
	});
	it("renders tool with examples for anthropic dialect", () => {
		const tool = {
			name: "search",
			description: "Search the web",
			parameters: { type: "object", properties: { query: { type: "string" } } },
			examples: [{ caption: "Basic search", call: { query: "hello" } }],
		};
		const result = renderToolInventory([tool], "anthropic/claude-3-5-sonnet");
		expect(result).toContain("# Tool: search");
		expect(result).toContain("<examples>");
	});
});
