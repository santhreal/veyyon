/**
 * serverSupports* predicates: tools/resources/prompts/subscriptions from
 * capabilities objects. Fail-closed on empty/missing.
 */
import { describe, expect, it } from "bun:test";
import {
	serverSupportsPrompts,
	serverSupportsResourceSubscriptions,
	serverSupportsResources,
	serverSupportsTools,
} from "@veyyon/coding-agent/mcp/client";

describe("MCP server capability predicates matrix", () => {
	it("tools", () => {
		expect(serverSupportsTools({})).toBe(false);
		expect(serverSupportsTools({ tools: {} })).toBe(true);
		expect(serverSupportsTools({ tools: { listChanged: true } })).toBe(true);
	});

	it("resources", () => {
		expect(serverSupportsResources({})).toBe(false);
		expect(serverSupportsResources({ resources: {} })).toBe(true);
	});

	it("resource subscriptions", () => {
		expect(serverSupportsResourceSubscriptions({})).toBe(false);
		expect(serverSupportsResourceSubscriptions({ resources: {} })).toBe(false);
		expect(
			serverSupportsResourceSubscriptions({ resources: { subscribe: true } }),
		).toBe(true);
	});

	it("prompts", () => {
		expect(serverSupportsPrompts({})).toBe(false);
		expect(serverSupportsPrompts({ prompts: {} })).toBe(true);
	});
});
