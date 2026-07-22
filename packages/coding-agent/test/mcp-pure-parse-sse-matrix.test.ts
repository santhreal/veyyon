/**
 * parseSSE matrix: data lines, DONE, keep-alives, JSON fallback.
 */
import { describe, expect, it } from "bun:test";
import { parseSSE } from "../src/mcp/json-rpc";

describe("parseSSE matrix", () => {
	it("first JSON data line", () => {
		expect(parseSSE("data: {\"a\":1}\ndata: {\"a\":2}")).toEqual({ a: 1 });
	});

	it("skips DONE", () => {
		expect(parseSSE("data: [DONE]\ndata: {\"ok\":true}")).toEqual({ ok: true });
	});

	it("skips non-json data", () => {
		expect(parseSSE("data: not-json\ndata: {\"x\":1}")).toEqual({ x: 1 });
	});

	it("skips keep-alive comments", () => {
		expect(parseSSE(": keep\ndata: {\"y\":2}")).toEqual({ y: 2 });
	});

	it("fallback full body JSON", () => {
		expect(parseSSE('{"result":true}')).toEqual({ result: true });
	});

	it("empty-ish returns nullish", () => {
		const r = parseSSE("");
		expect(r === null || r === undefined).toBe(true);
	});
});
