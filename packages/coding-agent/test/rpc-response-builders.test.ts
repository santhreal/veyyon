import { describe, expect, it } from "bun:test";
import {
	rpcErrorResponse,
	rpcSuccessResponse,
	rpcUnknownCommandResponse,
} from "@veyyon/coding-agent/modes/rpc/rpc-mode";
import type { RpcSessionState } from "@veyyon/coding-agent/modes/rpc/rpc-types";

/**
 * Product-owned RPC frame builders. These are the single owners of id-echo and
 * unknown-command id-drop; corpus and dispatcher tests must call them rather
 * than re-implementing the shapes.
 */

/** A complete RpcSessionState (the get_state data payload requires every field);
 *  overrides let a test vary just the fields it asserts on. */
function sessionState(overrides: Partial<RpcSessionState> = {}): RpcSessionState {
	return {
		thinkingLevel: undefined,
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		sessionId: "s",
		autoCompactionEnabled: false,
		messageCount: 0,
		queuedMessageCount: 0,
		todoPhases: [],
		...overrides,
	};
}

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
		const state = sessionState({ sessionId: "s", messageCount: 0 });
		const frame = rpcSuccessResponse("state-1", "get_state", state);
		expect(frame.id).toBe("state-1");
		expect(frame.success).toBe(true);
		expect(frame.command).toBe("get_state");
		if (frame.success && frame.command === "get_state") {
			expect(frame.data).toEqual(state);
		}
	});

	it("rpcErrorResponse preserves caller-supplied id for known error paths", () => {
		const frame = rpcErrorResponse("parse-id", "parse", "Failed to parse command: null");
		expect(frame.id).toBe("parse-id");
		expect(frame.success).toBe(false);
		// Narrow to the error variant of the union before reading `error` (only the
		// success:false member carries it); the throw keeps the assertion non-vacuous.
		if (frame.success) throw new Error("expected an error frame");
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
