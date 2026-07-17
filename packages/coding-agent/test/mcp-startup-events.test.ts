import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import {
	isMcpConnectionStatusEvent,
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	sanitizeMcpStatusError,
} from "@veyyon/pi-coding-agent/mcp/startup-events";

// Cross-module contract guard.
//
// The MCP status lifecycle spans two modules that never import each other:
//   - sdk.ts emits McpConnectionStatusEvent payloads on MCP_CONNECTION_STATUS_EVENT_CHANNEL.
//   - interactive-mode.ts subscribes to that channel and renders boot health in
//     the location line's right zone (see interactive-mode-mcp-connecting.test.ts).
//
// They agree only through this shared module. Drift in the channel or payload
// guard silently leaves the quiet zone stale.
describe("mcp/startup-events — connection-status cross-module contract", () => {
	it("pins the wire channel string sdk(emit) and interactive-mode(subscribe) share", () => {
		expect(MCP_CONNECTION_STATUS_EVENT_CHANNEL).toBe("mcp:connection-status");
	});

	it("sanitizeMcpStatusError strips control chars and shortens home paths (shared by /mcp list)", () => {
		const raw = `failed at\t${os.homedir()}/.omp/mcp.log\n${"x".repeat(200)}`;
		const out = sanitizeMcpStatusError(raw);
		expect(out).not.toContain(os.homedir());
		expect(out).not.toContain("\n");
		expect(out).not.toContain("\t");
		expect(out).toContain("~/.omp/mcp.log");
	});

	it("accepts well-formed payloads and rejects malformed ones", () => {
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: ["a"] })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "connected", serverName: "a" })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "a", error: "boom" })).toBe(true);

		expect(isMcpConnectionStatusEvent(null)).toBe(false);
		expect(isMcpConnectionStatusEvent("connecting")).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: "a" })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: [1] })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connected" })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "a" })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "unknown", serverName: "a" })).toBe(false);
	});
});
