import { describe, expect, it } from "bun:test";
import { getOpenRouterHeaders } from "../src/utils/openrouter-headers";
import { type ParsedBind, parseBind } from "../src/utils/parse-bind";

describe("parseBind", () => {
	it("parses host:port format", () => {
		expect(parseBind("0.0.0.0:8080")).toEqual({ hostname: "0.0.0.0", port: 8080 });
	});
	it("parses localhost:port format", () => {
		expect(parseBind("localhost:3000")).toEqual({ hostname: "localhost", port: 3000 });
	});
	it("defaults to 127.0.0.1 for port-only format", () => {
		expect(parseBind("8080")).toEqual({ hostname: "127.0.0.1", port: 8080 });
	});
	it("parses IPv6 address with port", () => {
		expect(parseBind("[::1]:8080")).toEqual({ hostname: "[::1]", port: 8080 });
	});
	it("trims whitespace before parsing", () => {
		expect(parseBind("  8080  ")).toEqual({ hostname: "127.0.0.1", port: 8080 });
	});
	it("throws for empty string", () => {
		expect(() => parseBind("")).toThrow();
	});
	it("throws for whitespace-only string", () => {
		expect(() => parseBind("   ")).toThrow();
	});
	it("throws for missing port", () => {
		expect(() => parseBind("localhost:")).toThrow();
	});
	it("throws for non-numeric port", () => {
		expect(() => parseBind("localhost:abc")).toThrow();
	});
	it("throws for port out of range (negative)", () => {
		expect(() => parseBind("localhost:-1")).toThrow();
	});
	it("throws for port out of range (>65535)", () => {
		expect(() => parseBind("localhost:65536")).toThrow();
	});
	it("throws for missing colon and non-numeric", () => {
		expect(() => parseBind("localhost")).toThrow();
	});
	it("throws for empty host", () => {
		expect(() => parseBind(":8080")).toThrow();
	});
	it("parses port 0", () => {
		expect(parseBind("0")).toEqual({ hostname: "127.0.0.1", port: 0 });
	});
	it("parses port 65535", () => {
		expect(parseBind("65535")).toEqual({ hostname: "127.0.0.1", port: 65535 });
	});
	it("parses full IPv6 with port", () => {
		expect(parseBind("[2001:db8::1]:443")).toEqual({ hostname: "[2001:db8::1]", port: 443 });
	});
});

describe("getOpenRouterHeaders", () => {
	it("returns object with User-Agent", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["User-Agent"]).toBeDefined();
		expect(headers["User-Agent"]).toContain("Veyyon/");
	});
	it("returns HTTP-Referer pointing to veyyon.dev", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["HTTP-Referer"]).toBe("https://veyyon.dev/");
	});
	it("returns X-OpenRouter-Title as Veyyon", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["X-OpenRouter-Title"]).toBe("Veyyon");
	});
	it("returns X-OpenRouter-Categories as cli-agent", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["X-OpenRouter-Categories"]).toBe("cli-agent");
	});
	it("enables caching", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["X-OpenRouter-Cache"]).toBe("true");
	});
	it("sets cache TTL", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["X-OpenRouter-Cache-TTL"]).toBe("3600");
	});
	it("returns exactly 6 headers", () => {
		const headers = getOpenRouterHeaders();
		expect(Object.keys(headers).length).toBe(6);
	});
});
