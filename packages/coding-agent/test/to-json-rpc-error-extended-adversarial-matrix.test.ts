/**
 * toJsonRpcError extended adversarial: nested, symbols, arrays, code edge values.
 * Why: MCP transport errors must stay JSON-RPC shaped under hostile throws.
 */
import { describe, expect, it } from "bun:test";
import { toJsonRpcError } from "../src/mcp/types";

describe("toJsonRpcError extended adversarial matrix", () => {
	const strings = [
		"a",
		"x".repeat(5000),
		"unicode 🚀",
		"line\nbreak",
		"tab\there",
		" quote ",
	];
	for (const [i, s] of strings.entries()) {
		it(`string #${i}`, () => {
			expect(toJsonRpcError(s)).toEqual({ code: -32603, message: s });
		});
	}

	it("Error with empty message uses empty then fallback path", () => {
		const e = new Error("");
		const r = toJsonRpcError(e);
		expect(r.code).toBe(-32603);
		expect(typeof r.message).toBe("string");
	});

	const codes = [-32700, -32600, -32601, -32602, -32603, -32000, -32099, 0, 1, 42, 99999];
	for (const code of codes) {
		it(`Error code ${code}`, () => {
			const e = new Error(`m${code}`) as Error & { code: number };
			e.code = code;
			expect(toJsonRpcError(e)).toEqual({ code, message: `m${code}` });
		});
		it(`object code ${code}`, () => {
			expect(toJsonRpcError({ code, message: `o${code}` })).toEqual({
				code,
				message: `o${code}`,
			});
		});
	}

	it("array/function/symbol/boolean → Internal error", () => {
		for (const v of [[], [1], () => 1, Symbol("s"), true, false, 0, -1, NaN]) {
			expect(toJsonRpcError(v)).toEqual({ code: -32603, message: "Internal error" });
		}
	});
});
