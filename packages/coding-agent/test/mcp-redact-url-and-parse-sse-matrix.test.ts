/**
 * redactUrlForLog strips credential-bearing query params; unparseable URLs
 * drop the query. parseSSE returns first JSON data: line, skips [DONE].
 */
import { describe, expect, it } from "bun:test";
import { parseSSE, redactUrlForLog } from "@veyyon/coding-agent/mcp/json-rpc";

describe("redactUrlForLog matrix", () => {
	it("redacts key/token/secret/auth query params", () => {
		const out = redactUrlForLog("https://host/path?exaApiKey=secret&ok=1&token=t&x=y");
		expect(out).toContain("ok=1");
		expect(out).toContain("x=y");
		expect(out).not.toContain("secret");
		expect(out).not.toContain("token=t");
		// URLSearchParams encodes brackets: [redacted] → %5Bredacted%5D
		expect(out).toContain("exaApiKey=%5Bredacted%5D");
		expect(out).toContain("token=%5Bredacted%5D");
	});

	it("leaves non-sensitive params", () => {
		expect(redactUrlForLog("https://host/?q=1&page=2")).toBe("https://host/?q=1&page=2");
	});

	it("unparseable URL drops query", () => {
		expect(redactUrlForLog("not a url?key=leak")).toBe("not a url");
	});

	it("no query unchanged", () => {
		expect(redactUrlForLog("https://host/path")).toBe("https://host/path");
	});
});

describe("parseSSE matrix", () => {
	it("parses first data JSON object", () => {
		expect(parseSSE('data: {"a":1}\n\n')).toEqual({ a: 1 });
	});

	it("skips [DONE] and takes next", () => {
		expect(parseSSE('data: [DONE]\ndata: {"ok":true}\n')).toEqual({ ok: true });
	});

	it("skips non-JSON data lines", () => {
		expect(parseSSE('data: keep-alive\ndata: {"n":2}\n')).toEqual({ n: 2 });
	});

	it("falls back to whole-body JSON", () => {
		expect(parseSSE('{"fallback":true}')).toEqual({ fallback: true });
	});

	it("empty / garbage is nullish", () => {
		// tryParseJson empty body returns null, not undefined
		expect(parseSSE("")).toBeNull();
		expect(parseSSE("data: \n") == null).toBe(true);
	});
});
