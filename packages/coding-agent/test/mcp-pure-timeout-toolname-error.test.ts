/**
 * Pure MCP contracts: timeout resolution, tool name create/parse, toJsonRpcError,
 * URL redaction, SSE parse, server name validation, server config validation.
 * No natives / no real transport.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createMCPToolName, parseMCPToolName } from "../src/mcp/tool-bridge";
import { describeMCPTimeout, isMCPTimeoutEnabled, resolveMCPTimeoutMs, createMCPTimeout } from "../src/mcp/timeout";
import { toJsonRpcError } from "../src/mcp/types";
import { parseSSE, redactUrlForLog } from "../src/mcp/json-rpc";
import { validateServerName } from "../src/mcp/config-writer";
import { isBrowserMCPServer, validateServerConfig } from "../src/mcp/config";

const prevTimeoutEnv = Bun.env.VEYYON_MCP_TIMEOUT_MS;

afterEach(() => {
	if (prevTimeoutEnv === undefined) delete Bun.env.VEYYON_MCP_TIMEOUT_MS;
	else Bun.env.VEYYON_MCP_TIMEOUT_MS = prevTimeoutEnv;
});

describe("resolveMCPTimeoutMs / describe / enabled", () => {
	it("defaults to 30000 when no env and no config", () => {
		delete Bun.env.VEYYON_MCP_TIMEOUT_MS;
		expect(resolveMCPTimeoutMs()).toBe(30_000);
	});

	it("configTimeout used when env absent", () => {
		delete Bun.env.VEYYON_MCP_TIMEOUT_MS;
		expect(resolveMCPTimeoutMs(5_000)).toBe(5_000);
		expect(resolveMCPTimeoutMs(0)).toBe(0);
	});

	it("env overrides config when finite non-negative", () => {
		Bun.env.VEYYON_MCP_TIMEOUT_MS = "12000";
		expect(resolveMCPTimeoutMs(5_000)).toBe(12_000);
		Bun.env.VEYYON_MCP_TIMEOUT_MS = "0";
		expect(resolveMCPTimeoutMs(5_000)).toBe(0);
	});

	it("invalid env is ignored and config/default wins", () => {
		Bun.env.VEYYON_MCP_TIMEOUT_MS = "nope";
		expect(resolveMCPTimeoutMs(9_000)).toBe(9_000);
		delete Bun.env.VEYYON_MCP_TIMEOUT_MS;
		Bun.env.VEYYON_MCP_TIMEOUT_MS = "-5";
		// negative is rejected by `value >= 0`
		expect(resolveMCPTimeoutMs(9_000)).toBe(9_000);
	});

	it("isMCPTimeoutEnabled is false only for 0", () => {
		expect(isMCPTimeoutEnabled(0)).toBe(false);
		expect(isMCPTimeoutEnabled(1)).toBe(true);
		expect(isMCPTimeoutEnabled(30_000)).toBe(true);
	});

	it("describeMCPTimeout exact strings", () => {
		expect(describeMCPTimeout(0)).toBe("disabled");
		expect(describeMCPTimeout(1500)).toBe("1500ms");
	});

	it("createMCPTimeout disabled path preserves caller signal and never times out", () => {
		const ac = new AbortController();
		const t = createMCPTimeout(0, ac.signal);
		expect(t.signal).toBe(ac.signal);
		expect(t.isTimeoutAbort(new DOMException("Aborted", "AbortError"))).toBe(false);
		t.clear();
	});
});

describe("createMCPToolName / parseMCPToolName", () => {
	it("builds mcp__server_tool form", () => {
		expect(createMCPToolName("github", "list_issues")).toBe("mcp__github_list_issues");
	});

	it("sanitizes non-alnum to underscores and lowercases", () => {
		expect(createMCPToolName("My Server", "Do-Thing")).toBe("mcp__my_server_do_thing");
	});

	it("strips redundant server prefix from tool name", () => {
		expect(createMCPToolName("exa", "exa_search")).toBe("mcp__exa_search");
	});

	it("falls back when parts empty after sanitize", () => {
		// pure symbols → fallback "server"/"tool"
		const name = createMCPToolName("@@@", "###");
		expect(name).toBe("mcp__server_tool");
	});

	it("parse round-trips the created form", () => {
		const created = createMCPToolName("svc", "op");
		expect(parseMCPToolName(created)).toEqual({ serverName: "svc", toolName: "op" });
	});

	it("parse returns null for non-mcp names", () => {
		expect(parseMCPToolName("bash")).toBeNull();
		expect(parseMCPToolName("mcp_missing_double")).toBeNull();
		expect(parseMCPToolName("mcp__onlyserver")).toBeNull();
	});

	it("colon in server name is sanitized to underscore", () => {
		const name = createMCPToolName("cloudflare:api", "call");
		expect(name.startsWith("mcp__")).toBe(true);
		expect(name).toContain("call");
		expect(name).not.toContain(":");
	});
});

describe("toJsonRpcError", () => {
	it("Error preserves message and optional numeric code", () => {
		expect(toJsonRpcError(new Error("boom"))).toEqual({ code: -32603, message: "boom" });
		const e = new Error("with code") as Error & { code: number };
		e.code = -32000;
		expect(toJsonRpcError(e)).toEqual({ code: -32000, message: "with code" });
	});

	it("string errors preserve non-empty message (not Internal error)", () => {
		expect(toJsonRpcError("transport reset")).toEqual({ code: -32603, message: "transport reset" });
		expect(toJsonRpcError("")).toEqual({ code: -32603, message: "Internal error" });
	});

	it("plain objects with code+message are preserved", () => {
		expect(toJsonRpcError({ code: -32600, message: "Invalid Request" })).toEqual({
			code: -32600,
			message: "Invalid Request",
		});
	});

	it("unknown shapes collapse to Internal error", () => {
		expect(toJsonRpcError(null)).toEqual({ code: -32603, message: "Internal error" });
		expect(toJsonRpcError(42)).toEqual({ code: -32603, message: "Internal error" });
		expect(toJsonRpcError({ code: "nope", message: 1 })).toEqual({ code: -32603, message: "Internal error" });
	});
});

describe("redactUrlForLog / parseSSE", () => {
	it("redacts sensitive query params", () => {
		const out = redactUrlForLog("https://api.example.com/mcp?exaApiKey=SECRET&q=1");
		// URLSearchParams encodes brackets: [redacted] → %5Bredacted%5D
		expect(out.includes("%5Bredacted%5D") || out.includes("[redacted]")).toBe(true);
		expect(out).not.toContain("SECRET");
		expect(out).toContain("q=1");
	});

	it("redacts token/secret/auth names case-insensitively", () => {
		for (const key of ["token", "TOKEN", "client_secret", "Authorization"]) {
			const out = redactUrlForLog(`https://x.test/?${key}=leak`);
			expect(out).not.toContain("leak");
			expect(out.includes("%5Bredacted%5D") || out.includes("[redacted]")).toBe(true);
		}
	});

	it("unparseable URL drops query string entirely", () => {
		expect(redactUrlForLog("not a url?token=secret")).toBe("not a url");
	});

	it("parseSSE returns first JSON data line", () => {
		const text = [": keep-alive", "data: {\"ok\":true,\"n\":1}", "data: {\"ok\":false}"].join("\n");
		expect(parseSSE(text)).toEqual({ ok: true, n: 1 });
	});

	it("parseSSE skips [DONE] and non-JSON data lines", () => {
		const text = ["data: [DONE]", "data: not-json", "data: {\"done\":true}"].join("\n");
		expect(parseSSE(text)).toEqual({ done: true });
	});

	it("parseSSE falls back to full-body JSON when no data lines", () => {
		expect(parseSSE('{"result":1}')).toEqual({ result: 1 });
	});
});

describe("validateServerName", () => {
	it("accepts alnum, dash, underscore, dot, colon", () => {
		for (const name of ["github", "a-b", "a_b", "a.b", "ns:svc", "cloudflare:cloudflare-api"]) {
			expect(validateServerName(name)).toBeUndefined();
		}
	});

	it("rejects empty, too long, bad chars, path segments", () => {
		expect(validateServerName("")).toBe("Server name cannot be empty");
		expect(validateServerName("a".repeat(101))).toContain("too long");
		expect(validateServerName("has space")).toContain("can only contain");
		expect(validateServerName("has/slash")).toContain("can only contain");
		expect(validateServerName(".")).toContain("path segment");
		expect(validateServerName("..")).toContain("path segment");
	});
});

describe("validateServerConfig / isBrowserMCPServer", () => {
	it("stdio requires command", () => {
		expect(validateServerConfig("s", { command: "npx" } as never)).toEqual([]);
		expect(validateServerConfig("s", {} as never)).toEqual([
			'Server "s": stdio server requires "command" field',
		]);
	});

	it("http/sse require url", () => {
		expect(validateServerConfig("h", { type: "http", url: "https://x" })).toEqual([]);
		expect(validateServerConfig("h", { type: "http" } as never)).toEqual([
			'Server "h": http server requires "url" field',
		]);
		expect(validateServerConfig("s", { type: "sse" } as never)).toEqual([
			'Server "s": sse server requires "url" field',
		]);
	});

	it("rejects command+url conflict", () => {
		const errors = validateServerConfig("bad", { command: "npx", url: "https://x" } as never);
		expect(errors.some(e => e.includes("both \"command\" and \"url\""))).toBe(true);
	});

	it("isBrowserMCPServer by name and package pattern", () => {
		expect(isBrowserMCPServer("playwright", { command: "node" })).toBe(true);
		expect(isBrowserMCPServer("puppeteer", { command: "node" })).toBe(true);
		expect(isBrowserMCPServer("other", { command: "npx", args: ["@playwright/mcp"] })).toBe(true);
		expect(isBrowserMCPServer("github", { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] })).toBe(
			false,
		);
		expect(isBrowserMCPServer("bb", { type: "http", url: "https://api.browserbase.com/mcp" })).toBe(true);
	});
});
