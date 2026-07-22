/**
 * toJsonRpcError matrix: every throw-site shape maps to exact code/message.
 */
import { describe, expect, it } from "bun:test";
import { toJsonRpcError } from "../src/mcp/types";

describe("toJsonRpcError matrix", () => {
	const cases: Array<{ name: string; input: unknown; code: number; message: string }> = [
		{ name: "Error", input: new Error("e"), code: -32603, message: "e" },
		{ name: "TypeError", input: new TypeError("t"), code: -32603, message: "t" },
		{ name: "string", input: "s", code: -32603, message: "s" },
		{ name: "empty string", input: "", code: -32603, message: "Internal error" },
		{ name: "null", input: null, code: -32603, message: "Internal error" },
		{ name: "undefined", input: undefined, code: -32603, message: "Internal error" },
		{ name: "number", input: 0, code: -32603, message: "Internal error" },
		{ name: "plain object", input: { code: -32000, message: "custom" }, code: -32000, message: "custom" },
		{ name: "object missing message", input: { code: -1 }, code: -32603, message: "Internal error" },
		{ name: "object missing code", input: { message: "m" }, code: -32603, message: "Internal error" },
	];

	for (const c of cases) {
		it(c.name, () => {
			expect(toJsonRpcError(c.input)).toEqual({ code: c.code, message: c.message });
		});
	}

	it("Error with non-numeric code property uses -32603", () => {
		const e = new Error("x") as Error & { code: string };
		e.code = "not-a-number";
		expect(toJsonRpcError(e)).toEqual({ code: -32603, message: "x" });
	});

	it("Error with numeric code uses that code", () => {
		const e = new Error("rpc") as Error & { code: number };
		e.code = -32601;
		expect(toJsonRpcError(e)).toEqual({ code: -32601, message: "rpc" });
	});
});
