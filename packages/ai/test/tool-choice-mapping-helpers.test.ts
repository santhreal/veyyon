import { describe, expect, it } from "bun:test";
import { mapAnthropicToolChoice, mapGoogleToolChoice } from "../src/stream-helpers";

describe("mapAnthropicToolChoice", () => {
	it("returns undefined for undefined input", () => {
		expect(mapAnthropicToolChoice(undefined)).toBeUndefined();
	});
	it("maps 'required' to 'any'", () => {
		expect(mapAnthropicToolChoice("required")).toBe("any");
	});
	it("passes 'auto' through", () => {
		expect(mapAnthropicToolChoice("auto")).toBe("auto");
	});
	it("passes 'none' through", () => {
		expect(mapAnthropicToolChoice("none")).toBe("none");
	});
	it("passes 'any' through", () => {
		expect(mapAnthropicToolChoice("any")).toBe("any");
	});
	it("returns undefined for unknown string", () => {
		expect(mapAnthropicToolChoice("unknown" as never)).toBeUndefined();
	});
	it("maps tool type with name to {type:'tool', name}", () => {
		expect(mapAnthropicToolChoice({ type: "tool", name: "myTool" })).toEqual({ type: "tool", name: "myTool" });
	});
	it("returns undefined for tool type without name", () => {
		expect(mapAnthropicToolChoice({ type: "tool", name: "" })).toBeUndefined();
	});
	it("maps function type with function.name to {type:'tool', name}", () => {
		expect(mapAnthropicToolChoice({ type: "function", function: { name: "myFunc" } })).toEqual({
			type: "tool",
			name: "myFunc",
		});
	});
	it("maps function type with name to {type:'tool', name}", () => {
		expect(mapAnthropicToolChoice({ type: "function", name: "myFunc" } as never)).toEqual({
			type: "tool",
			name: "myFunc",
		});
	});
	it("returns undefined for function type without name", () => {
		expect(mapAnthropicToolChoice({ type: "function", function: { name: "" } })).toBeUndefined();
	});
	it("returns undefined for unknown choice type", () => {
		expect(mapAnthropicToolChoice({ type: "unknown" } as never)).toBeUndefined();
	});
});

describe("mapGoogleToolChoice", () => {
	it("returns undefined for undefined input", () => {
		expect(mapGoogleToolChoice(undefined)).toBeUndefined();
	});
	it("maps 'required' to 'any'", () => {
		expect(mapGoogleToolChoice("required")).toBe("any");
	});
	it("passes 'auto' through", () => {
		expect(mapGoogleToolChoice("auto")).toBe("auto");
	});
	it("passes 'none' through", () => {
		expect(mapGoogleToolChoice("none")).toBe("none");
	});
	it("passes 'any' through", () => {
		expect(mapGoogleToolChoice("any")).toBe("any");
	});
	it("returns undefined for unknown string", () => {
		expect(mapGoogleToolChoice("unknown" as never)).toBeUndefined();
	});
	it("maps tool type with name to ANY mode with allowedFunctionNames", () => {
		expect(mapGoogleToolChoice({ type: "tool", name: "myTool" })).toEqual({
			mode: "ANY",
			allowedFunctionNames: ["myTool"],
		});
	});
	it("returns undefined for tool type without name", () => {
		expect(mapGoogleToolChoice({ type: "tool", name: "" })).toBeUndefined();
	});
	it("maps function type with function.name to ANY mode", () => {
		expect(mapGoogleToolChoice({ type: "function", function: { name: "myFunc" } })).toEqual({
			mode: "ANY",
			allowedFunctionNames: ["myFunc"],
		});
	});
	it("maps function type with name to ANY mode", () => {
		expect(mapGoogleToolChoice({ type: "function", name: "myFunc" } as never)).toEqual({
			mode: "ANY",
			allowedFunctionNames: ["myFunc"],
		});
	});
	it("returns undefined for function type without name", () => {
		expect(mapGoogleToolChoice({ type: "function", function: { name: "" } })).toBeUndefined();
	});
	it("returns undefined for unknown choice type", () => {
		expect(mapGoogleToolChoice({ type: "unknown" } as never)).toBeUndefined();
	});
});
