import { describe, expect, it } from "bun:test";
import { validateServerName } from "@veyyon/coding-agent/mcp/config-writer";
import { parseSSE, redactUrlForLog } from "@veyyon/coding-agent/mcp/json-rpc";
import { createMCPToolName, parseMCPToolName } from "@veyyon/coding-agent/mcp/tool-bridge";
import { toJsonRpcError } from "@veyyon/coding-agent/mcp/types";

/**
 * MCP naming, SSE parse, URL redaction, and JSON-RPC error mapping — product
 * exports only, exact strings.
 */

describe("MCP tool name round-trip", () => {
	it("create then parse returns lowercased segments for simple names without underscores", () => {
		// createMCPToolName lowercases and replaces non [a-z_] with _
		const name = createMCPToolName("github", "listIssues");
		expect(name).toBe("mcp__github_listissues");
		const parsed = parseMCPToolName(name);
		expect(parsed).toEqual({ serverName: "github", toolName: "listissues" });
	});

	it("createMCPToolName strips redundant server prefix from tool name", () => {
		// puppeteer + puppeteer_screenshot → mcp__puppeteer_screenshot
		const name = createMCPToolName("puppeteer", "puppeteer_screenshot");
		expect(name).toBe("mcp__puppeteer_screenshot");
		expect(parseMCPToolName(name)).toEqual({
			serverName: "puppeteer",
			toolName: "screenshot",
		});
	});

	it("createMCPToolName falls back when both parts sanitize empty", () => {
		const name = createMCPToolName("!!!", "@@@");
		expect(name).toBe("mcp__server_tool");
		expect(parseMCPToolName(name)).toEqual({ serverName: "server", toolName: "tool" });
	});

	it("createMCPToolName collapses runs of non-alnum into single underscores", () => {
		const name = createMCPToolName("My--Server", "Do...Thing");
		expect(name).toBe("mcp__my_server_do_thing");
	});

	it("parseMCPToolName returns null for non-mcp names", () => {
		expect(parseMCPToolName("bash")).toBeNull();
		expect(parseMCPToolName("")).toBeNull();
		expect(parseMCPToolName("notmcp__x_y")).toBeNull();
	});

	it("parse splits server on the first underscore after mcp__", () => {
		// Documented limitation: underscores in server names are not round-trippable.
		const name = createMCPToolName("my_server", "do_thing");
		const parsed = parseMCPToolName(name);
		expect(parsed).not.toBeNull();
		expect(parsed!.serverName).toBe("my");
		expect(parsed!.toolName.startsWith("server_")).toBe(true);
	});
});

describe("MCP validateServerName", () => {
	it("accepts simple alnum and hyphen names", () => {
		expect(validateServerName("github")).toBeUndefined();
		expect(validateServerName("my-server")).toBeUndefined();
	});

	it("rejects empty and path-like names", () => {
		expect(validateServerName("")).toBeDefined();
		expect(validateServerName("../evil")).toBeDefined();
		expect(validateServerName("has space")).toBeDefined();
	});
});

describe("MCP parseSSE adversarial", () => {
	it("skips keep-alives and returns first JSON object", () => {
		const text = 'data: ping\n\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n';
		expect(parseSSE(text)).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
	});

	it("returns null when no JSON data lines exist", () => {
		expect(parseSSE("data: :\ndata: ping\n")).toBeNull();
	});
});

describe("MCP redactUrlForLog", () => {
	it("strips secret query values", () => {
		const out = redactUrlForLog("https://example.com/mcp?token=supersecret&x=1");
		expect(out).not.toContain("supersecret");
		expect(out).toContain("example.com");
	});
});

describe("toJsonRpcError", () => {
	it("maps a plain Error to a message-bearing JSON-RPC error object", () => {
		const err = toJsonRpcError(new Error("boom"));
		expect(err).toBeDefined();
		const message =
			typeof err === "object" && err && "message" in err
				? String((err as { message: unknown }).message)
				: String(err);
		expect(message).toContain("boom");
	});

	it("maps a string throw-site value without inventing empty message", () => {
		const err = toJsonRpcError("plain-string-failure");
		expect(err).toBeDefined();
		const message =
			typeof err === "object" && err && "message" in err
				? String((err as { message: unknown }).message)
				: String(err);
		expect(message).toContain("plain-string-failure");
	});
});

describe("MCP parseSSE extra adversarial", () => {
	it("ignores non-data fields and still returns the data JSON", () => {
		const text = 'event: message\nid: 1\ndata: {"jsonrpc":"2.0","id":3,"result":{"v":1}}\n\n';
		expect(parseSSE(text)).toEqual({ jsonrpc: "2.0", id: 3, result: { v: 1 } });
	});

	it("returns null for malformed JSON data lines", () => {
		expect(parseSSE("data: {not-json\n\n")).toBeNull();
	});

	it("returns null for empty payload", () => {
		expect(parseSSE("")).toBeNull();
	});
});

describe("MCP redactUrlForLog extra", () => {
	it("redacts multiple secret-like query keys", () => {
		const out = redactUrlForLog("https://api.example.com/v1?api_key=AAA&token=BBB&ok=1");
		expect(out).not.toContain("AAA");
		expect(out).not.toContain("BBB");
		expect(out).toContain("api.example.com");
	});

	it("leaves urls without query secrets recognizable", () => {
		const out = redactUrlForLog("https://example.com/mcp");
		expect(out).toContain("example.com");
		expect(out).toContain("/mcp");
	});
});

describe("MCP parseMCPToolName edge cases", () => {
	it("returns null when mcp__ has no underscore separator for tool", () => {
		expect(parseMCPToolName("mcp__onlyserver")).toBeNull();
	});

	it("parses tool names that themselves contain underscores", () => {
		const name = createMCPToolName("svc", "do_the_thing");
		const parsed = parseMCPToolName(name);
		expect(parsed).toEqual({ serverName: "svc", toolName: "do_the_thing" });
	});
});
