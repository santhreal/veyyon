import { describe, expect, it } from "bun:test";
import {
	rpcErrorResponse,
	rpcSuccessResponse,
	rpcUnknownCommandResponse,
} from "@veyyon/coding-agent/modes/rpc/rpc-mode";

/**
 * Product-owned RPC frame builders. These are the single owners of id-echo and
 * unknown-command id-drop; corpus and dispatcher tests must call them rather
 * than re-implementing the shapes.
 */
describe("rpc response builders (product)", () => {
	it("rpcUnknownCommandResponse always drops id and names the type", () => {
		const frame = rpcUnknownCommandResponse("definitely_not_a_command");
		expect(frame).toEqual({
			id: undefined,
			type: "response",
			command: "definitely_not_a_command",
			success: false,
			error: "Unknown command: definitely_not_a_command",
		});
	});

	it("rpcSuccessResponse echoes the request id on known commands", () => {
		const frame = rpcSuccessResponse("state-1", "get_state", {
			sessionId: "s",
			messageCount: 0,
		});
		expect(frame.id).toBe("state-1");
		expect(frame.success).toBe(true);
		expect(frame.command).toBe("get_state");
		if (frame.success && frame.command === "get_state") {
			expect(frame.data).toEqual({ sessionId: "s", messageCount: 0 });
		}
	});

	it("rpcErrorResponse preserves caller-supplied id for known error paths", () => {
		const frame = rpcErrorResponse("parse-id", "parse", "Failed to parse command: null");
		expect(frame.id).toBe("parse-id");
		expect(frame.success).toBe(false);
		expect(frame.error).toBe("Failed to parse command: null");
	});

	it("unknown-command path never uses the client request id (hard-coded drop)", () => {
		// Even if a caller mistakenly wanted to pass an id, the product helper
		// has no id parameter — the only way to get an id is rpcErrorResponse.
		const unknown = rpcUnknownCommandResponse("x");
		const withId = rpcErrorResponse("should-not-appear-on-unknown", "x", "Unknown command: x");
		expect(unknown.id).toBeUndefined();
		expect(withId.id).toBe("should-not-appear-on-unknown");
		// Product unknown path is not the generic error helper with a free id.
		expect(unknown).not.toEqual(withId);
	});
});
