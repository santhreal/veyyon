import { describe, expect, it } from "bun:test";
import type { ToolArguments } from "../src/mcp-tools";
import { getToolDefinitions, required, serialize } from "../src/mcp-tools-helpers";

describe("serialize", () => {
	it("returns primitives as-is", () => {
		expect(serialize("hello")).toBe("hello");
		expect(serialize(42)).toBe(42);
		expect(serialize(true)).toBe(true);
		expect(serialize(null)).toBe(null);
	});
	it("converts Date to ISO string", () => {
		const date = new Date(Date.UTC(2024, 0, 15, 10, 30, 0));
		expect(serialize(date)).toBe("2024-01-15T10:30:00.000Z");
	});
	it("serializes arrays recursively", () => {
		const date = new Date(Date.UTC(2024, 0, 15));
		expect(serialize([date, "hello"])).toEqual(["2024-01-15T00:00:00.000Z", "hello"]);
	});
	it("serializes objects recursively", () => {
		const date = new Date(Date.UTC(2024, 0, 15));
		expect(serialize({ key: date, other: 42 })).toEqual({
			key: "2024-01-15T00:00:00.000Z",
			other: 42,
		});
	});
	it("serializes nested objects with arrays", () => {
		const date = new Date(Date.UTC(2024, 0, 15));
		expect(serialize({ list: [date, { inner: date }] })).toEqual({
			list: ["2024-01-15T00:00:00.000Z", { inner: "2024-01-15T00:00:00.000Z" }],
		});
	});
	it("handles undefined", () => {
		expect(serialize(undefined)).toBe(undefined);
	});
});

describe("required", () => {
	it("returns trimmed value when present", () => {
		const args: ToolArguments = { key: "  value  " };
		const result = required(args, "key");
		expect(result).toBe("value");
	});
	it("returns error when absent", () => {
		const args: ToolArguments = {};
		const result = required(args, "key");
		expect(typeof result).toBe("object");
		expect((result as { error: string }).error).toBe("key is required");
	});
	it("returns error when empty string", () => {
		const args: ToolArguments = { key: "" };
		const result = required(args, "key");
		expect(typeof result).toBe("object");
		expect((result as { error: string }).error).toBe("key is required");
	});
	it("returns error when whitespace-only string", () => {
		const args: ToolArguments = { key: "   " };
		const result = required(args, "key");
		expect(typeof result).toBe("object");
		expect((result as { error: string }).error).toBe("key is required");
	});
	it("returns error when value is not a string", () => {
		const args: ToolArguments = { key: 42 };
		const result = required(args, "key");
		expect(typeof result).toBe("object");
		expect((result as { error: string }).error).toBe("key is required");
	});
});

describe("getToolDefinitions", () => {
	it("returns a non-empty array", () => {
		const tools = getToolDefinitions();
		expect(tools.length).toBeGreaterThan(0);
	});
	it("every tool has a name and description", () => {
		for (const tool of getToolDefinitions()) {
			expect(tool.name.length).toBeGreaterThan(0);
			expect(tool.description.length).toBeGreaterThan(0);
		}
	});
	it("every tool has an input schema of type object", () => {
		for (const tool of getToolDefinitions()) {
			expect(tool.inputSchema.type).toBe("object");
			expect(typeof tool.inputSchema.properties).toBe("object");
		}
	});
	it("tool names are unique", () => {
		const names = getToolDefinitions().map(t => t.name);
		expect(new Set(names).size).toBe(names.length);
	});
});
