/**
 * isMcpConnectionStatusEvent accept/reject matrix.
 */
import { describe, expect, it } from "bun:test";
import { isMcpConnectionStatusEvent } from "../src/mcp/startup-events";

describe("isMcpConnectionStatusEvent matrix", () => {
	it("connecting", () => {
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: [] })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: ["a"] })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: [1] })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connecting" })).toBe(false);
	});

	it("connected", () => {
		expect(isMcpConnectionStatusEvent({ type: "connected", serverName: "x" })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "connected", serverName: 1 })).toBe(false);
	});

	it("failed", () => {
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "x", error: "e" })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "x", error: "e", foreign: true })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "x", error: "e", foreign: "yes" })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "x" })).toBe(false);
	});

	it("junk", () => {
		expect(isMcpConnectionStatusEvent(null)).toBe(false);
		expect(isMcpConnectionStatusEvent({})).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "nope" })).toBe(false);
	});
});
