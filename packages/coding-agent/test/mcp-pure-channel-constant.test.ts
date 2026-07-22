/**
 * MCP_CONNECTION_STATUS_EVENT_CHANNEL exact value.
 */
import { describe, expect, it } from "bun:test";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL } from "../src/mcp/startup-events";

describe("MCP_CONNECTION_STATUS_EVENT_CHANNEL", () => {
	it("exact bus name", () => {
		expect(MCP_CONNECTION_STATUS_EVENT_CHANNEL).toBe("mcp:connection-status");
	});
});
