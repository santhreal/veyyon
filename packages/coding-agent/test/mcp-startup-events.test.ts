import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import {
	formatMCPConnectingMessage,
	formatMCPConnectionStatusMessage,
	isMcpConnectionStatusEvent,
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	sanitizeMcpStatusError,
} from "@veyyon/pi-coding-agent/mcp/startup-events";

// Cross-module contract guard.
//
// The MCP status lifecycle spans two modules that never import each other:
//   - sdk.ts emits McpConnectionStatusEvent payloads on MCP_CONNECTION_STATUS_EVENT_CHANNEL.
//   - interactive-mode.ts subscribes to that channel and renders the aggregate
//     message via formatMCPConnectionStatusMessage.
//
// They agree only through this shared module. Drift in the channel, payload
// guard, or user-facing status text silently leaves the startup banner stale.
describe("mcp/startup-events — connection-status cross-module contract", () => {
	it("pins the wire channel string sdk(emit) and interactive-mode(subscribe) share", () => {
		expect(MCP_CONNECTION_STATUS_EVENT_CHANNEL).toBe("mcp:connection-status");
	});

	it("formats the initial connecting banner for a multi-server list", () => {
		expect(formatMCPConnectingMessage(["alpha", "beta", "gamma"])).toBe(
			"Connecting to MCP servers: alpha, beta, gamma…",
		);
	});

	it("formats a completion update when every server connects", () => {
		expect(
			formatMCPConnectionStatusMessage({
				pendingServers: [],
				connectedServers: ["alpha", "beta"],
				failedServers: [],
			}),
		).toBe("MCP: 2 connected (alpha, beta)");
	});

	it("collapses partial failures to counts + failed names + a detail pointer, not an error wall", () => {
		const message = formatMCPConnectionStatusMessage({
			pendingServers: [],
			connectedServers: ["alpha"],
			failedServers: [{ serverName: "broken", error: "missing command" }],
		});
		expect(message).toBe("MCP: 1 connected, 1 failed (broken) — /mcp list for detail");
		// The banner names *which* server failed but never dumps the error text —
		// that detail lives in `/mcp list` (Law 10: surfaced, not hidden, not spammed).
		expect(message).not.toContain("missing command");
	});

	it("collapses an all-failed terminal state to a count + names + detail pointer", () => {
		expect(
			formatMCPConnectionStatusMessage({
				pendingServers: [],
				connectedServers: [],
				failedServers: [
					{ serverName: "a", error: "boom" },
					{ serverName: "b", error: "kaboom" },
				],
			}),
		).toBe("MCP: all 2 servers failed (a, b) — /mcp list for detail");
	});

	it("keeps failed-server names sanitized and never leaks the error text into the banner", () => {
		const homePath = `${os.homedir()}/.omp`;
		const message = formatMCPConnectionStatusMessage({
			pendingServers: [],
			connectedServers: [],
			failedServers: [{ serverName: `${homePath}/broken\nserver`, error: `secret at ${os.homedir()}/x` }],
		});
		expect(message).not.toContain(os.homedir());
		expect(message).not.toContain("\n");
		expect(message).not.toContain("secret at");
		expect(message).toContain("~/.omp/broken server");
		expect(message).toContain("/mcp list for detail");
	});

	it("sanitizes pending server names while other servers settle", () => {
		const homePath = `${os.homedir()}/.omp`;
		const message = formatMCPConnectionStatusMessage({
			pendingServers: [`${homePath}/pending\n${"p".repeat(80)}`],
			connectedServers: ["alpha"],
			failedServers: [{ serverName: "broken", error: "missing command" }],
		});
		expect(message).not.toContain(os.homedir());
		expect(message).not.toContain("\n");
		expect(message).not.toContain("\t");
		expect(message).not.toContain("missing command");
		expect(message).toContain("MCP: 1 connected, 1 failed; still connecting ~/.omp/pending");
	});

	it("keeps pending servers visible while other servers settle", () => {
		expect(
			formatMCPConnectionStatusMessage({
				pendingServers: ["slow"],
				connectedServers: ["alpha"],
				failedServers: [{ serverName: "broken", error: "missing command" }],
			}),
		).toBe("MCP: 1 connected, 1 failed; still connecting slow…");
	});

	it("sanitizeMcpStatusError strips control chars and shortens home paths (shared by /mcp list)", () => {
		const raw = `failed at\t${os.homedir()}/.omp/mcp.log\n${"x".repeat(200)}`;
		const out = sanitizeMcpStatusError(raw);
		expect(out).not.toContain(os.homedir());
		expect(out).not.toContain("\n");
		expect(out).not.toContain("\t");
		expect(out).toContain("~/.omp/mcp.log");
	});

	it("terminates active connecting messages with a single U+2026 ellipsis", () => {
		const msg = formatMCPConnectingMessage(["x"]);
		expect(msg.endsWith("\u2026")).toBe(true);
		expect(msg.endsWith("...")).toBe(false);
		expect(msg.at(-1)).toBe("\u2026");
	});

	it("accepts well-formed payloads and rejects malformed ones", () => {
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: ["a", "b"] })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: [] })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "connected", serverName: "a" })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "a", error: "boom" })).toBe(true);

		expect(isMcpConnectionStatusEvent(null)).toBe(false);
		expect(isMcpConnectionStatusEvent(undefined)).toBe(false);
		expect(isMcpConnectionStatusEvent("mcp:connection-status")).toBe(false);
		expect(isMcpConnectionStatusEvent({})).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: "alpha" })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: ["ok", 3] })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connected", serverName: 1 })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "a" })).toBe(false);
	});
});
