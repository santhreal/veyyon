/**
 * toJsonRpcError preserves non-empty strings (product fix contract).
 */
import { describe, expect, it } from "bun:test";
import { toJsonRpcError } from "../src/mcp/types";

describe("toJsonRpcError string preserve", () => {
	const msgs = [
		"transport reset",
		"ECONNRESET",
		"timeout after 30000ms",
		"MCP server closed",
		"a",
	];
	for (const msg of msgs) {
		it(JSON.stringify(msg), () => {
			expect(toJsonRpcError(msg)).toEqual({ code: -32603, message: msg });
		});
	}

	it("empty string becomes Internal error", () => {
		expect(toJsonRpcError("")).toEqual({ code: -32603, message: "Internal error" });
	});
});
