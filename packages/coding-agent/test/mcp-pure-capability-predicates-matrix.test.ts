/**
 * serverSupports* capability predicates matrix.
 */
import { describe, expect, it } from "bun:test";
import {
	serverSupportsPrompts,
	serverSupportsResourceSubscriptions,
	serverSupportsResources,
	serverSupportsTools,
} from "../src/mcp/client";
import type { MCPServerCapabilities } from "../src/mcp/types";

describe("MCP capability predicates matrix", () => {
	const empty: MCPServerCapabilities = {};

	it("empty supports nothing", () => {
		expect(serverSupportsTools(empty)).toBe(false);
		expect(serverSupportsResources(empty)).toBe(false);
		expect(serverSupportsPrompts(empty)).toBe(false);
		expect(serverSupportsResourceSubscriptions(empty)).toBe(false);
	});

	it("tools empty object is support", () => {
		expect(serverSupportsTools({ tools: {} })).toBe(true);
	});

	it("resources empty object is support", () => {
		expect(serverSupportsResources({ resources: {} })).toBe(true);
		expect(serverSupportsResourceSubscriptions({ resources: {} })).toBe(false);
	});

	it("resources subscribe flag", () => {
		expect(serverSupportsResourceSubscriptions({ resources: { subscribe: true } })).toBe(true);
		expect(serverSupportsResourceSubscriptions({ resources: { subscribe: false } })).toBe(false);
	});

	it("prompts empty object is support", () => {
		expect(serverSupportsPrompts({ prompts: {} })).toBe(true);
	});

	it("full capabilities", () => {
		const full: MCPServerCapabilities = {
			tools: {},
			resources: { subscribe: true },
			prompts: {},
		};
		expect(serverSupportsTools(full)).toBe(true);
		expect(serverSupportsResources(full)).toBe(true);
		expect(serverSupportsResourceSubscriptions(full)).toBe(true);
		expect(serverSupportsPrompts(full)).toBe(true);
	});
});
