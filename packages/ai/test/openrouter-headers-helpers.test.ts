import { describe, expect, it } from "bun:test";
import { getOpenRouterHeaders } from "../src/utils/openrouter-headers";

describe("getOpenRouterHeaders", () => {
	it("returns an object with expected header keys", () => {
		const headers = getOpenRouterHeaders();
		expect(headers).toHaveProperty("User-Agent");
		expect(headers).toHaveProperty("HTTP-Referer");
		expect(headers).toHaveProperty("X-OpenRouter-Title");
		expect(headers).toHaveProperty("X-OpenRouter-Categories");
		expect(headers).toHaveProperty("X-OpenRouter-Cache");
		expect(headers).toHaveProperty("X-OpenRouter-Cache-TTL");
	});

	it("User-Agent starts with Veyyon/", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["User-Agent"]).toMatch(/^Veyyon\//);
	});

	it("HTTP-Referer is veyyon.dev", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["HTTP-Referer"]).toBe("https://veyyon.dev/");
	});

	it("X-OpenRouter-Title is Veyyon", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["X-OpenRouter-Title"]).toBe("Veyyon");
	});

	it("X-OpenRouter-Categories is cli-agent", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["X-OpenRouter-Categories"]).toBe("cli-agent");
	});

	it("X-OpenRouter-Cache is true", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["X-OpenRouter-Cache"]).toBe("true");
	});

	it("X-OpenRouter-Cache-TTL is 3600", () => {
		const headers = getOpenRouterHeaders();
		expect(headers["X-OpenRouter-Cache-TTL"]).toBe("3600");
	});

	it("returns a new object each call", () => {
		const a = getOpenRouterHeaders();
		const b = getOpenRouterHeaders();
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
	});

	it("all values are strings", () => {
		const headers = getOpenRouterHeaders();
		for (const value of Object.values(headers)) {
			expect(typeof value).toBe("string");
		}
	});
});
