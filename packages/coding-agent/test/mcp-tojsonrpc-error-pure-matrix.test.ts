/**
 * toJsonRpcError preserves string messages (product fix), Error.message/code,
 * and object {code,message}; else Internal error -32603.
 */
import { describe, expect, it } from "bun:test";
import { toJsonRpcError } from "@veyyon/coding-agent/mcp/types";

describe("toJsonRpcError pure matrix", () => {
	it("preserves non-empty strings", () => {
		expect(toJsonRpcError("plain string")).toEqual({ code: -32603, message: "plain string" });
		expect(toJsonRpcError("timeout after 30s")).toEqual({
			code: -32603,
			message: "timeout after 30s",
		});
	});

	it("empty string → Internal error", () => {
		expect(toJsonRpcError("")).toEqual({ code: -32603, message: "Internal error" });
	});

	it("Error message and optional code", () => {
		expect(toJsonRpcError(new Error("boom"))).toEqual({ code: -32603, message: "boom" });
		const e = new Error("coded") as Error & { code: number };
		e.code = -32000;
		expect(toJsonRpcError(e)).toEqual({ code: -32000, message: "coded" });
	});

	it("plain object with code+message", () => {
		expect(toJsonRpcError({ code: -32600, message: "Invalid Request" })).toEqual({
			code: -32600,
			message: "Invalid Request",
		});
	});

	it("object missing fields → Internal error", () => {
		expect(toJsonRpcError({ code: 1 })).toEqual({ code: -32603, message: "Internal error" });
		expect(toJsonRpcError({ message: "x" })).toEqual({
			code: -32603,
			message: "Internal error",
		});
	});

	it("null/undefined/number → Internal error", () => {
		expect(toJsonRpcError(null)).toEqual({ code: -32603, message: "Internal error" });
		expect(toJsonRpcError(undefined)).toEqual({ code: -32603, message: "Internal error" });
		expect(toJsonRpcError(42)).toEqual({ code: -32603, message: "Internal error" });
	});
});
