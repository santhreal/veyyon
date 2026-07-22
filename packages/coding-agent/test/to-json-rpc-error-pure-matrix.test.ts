/**
 * toJsonRpcError: Error/string/object/unknown → exact code+message.
 * Why: string throws must not collapse to "Internal error" (hides cause).
 */
import { describe, expect, it } from "bun:test";
import { toJsonRpcError } from "@veyyon/coding-agent/mcp/types";

describe("toJsonRpcError pure matrix", () => {
	it("Error without code → -32603 + message", () => {
		expect(toJsonRpcError(new Error("boom"))).toEqual({ code: -32603, message: "boom" });
	});

	it("Error with numeric code preserves code", () => {
		const e = new Error("nf") as Error & { code: number };
		e.code = -32000;
		expect(toJsonRpcError(e)).toEqual({ code: -32000, message: "nf" });
	});

	it("non-empty string preserves message", () => {
		expect(toJsonRpcError("transport down")).toEqual({
			code: -32603,
			message: "transport down",
		});
	});

	it("empty string → Internal error", () => {
		expect(toJsonRpcError("")).toEqual({ code: -32603, message: "Internal error" });
	});

	it("plain object with code+message", () => {
		expect(toJsonRpcError({ code: 42, message: "x" })).toEqual({ code: 42, message: "x" });
	});

	it("object missing fields → Internal error", () => {
		expect(toJsonRpcError({ code: 1 })).toEqual({ code: -32603, message: "Internal error" });
		expect(toJsonRpcError({ message: "m" })).toEqual({ code: -32603, message: "Internal error" });
	});

	it("null/undefined/number → Internal error", () => {
		expect(toJsonRpcError(null)).toEqual({ code: -32603, message: "Internal error" });
		expect(toJsonRpcError(undefined)).toEqual({ code: -32603, message: "Internal error" });
		expect(toJsonRpcError(42)).toEqual({ code: -32603, message: "Internal error" });
	});
});
