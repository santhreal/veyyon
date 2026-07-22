/**
 * toJsonRpcError string length 1..300 preserves exact message.
 */
import { describe, expect, it } from "bun:test";
import { toJsonRpcError } from "../src/mcp/types";

describe("toJsonRpcError string length 1 to 300 matrix", () => {
	for (let n = 1; n <= 300; n++) {
		it(`len=${n}`, () => {
			const s = "m".repeat(n);
			expect(toJsonRpcError(s)).toEqual({ code: -32603, message: s });
		});
	}
});
