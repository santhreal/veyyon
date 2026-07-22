import { describe, expect, it } from "bun:test";
import {
	rpcErrorResponse,
	rpcSuccessResponse,
	rpcUnknownCommandResponse,
} from "@veyyon/coding-agent/modes/rpc/rpc-mode";

/**
 * Product-owned RPC response builders: exact id/command/success/error fields.
 * Wire shape: { id?, type:"response", command, success, data?|error? }.
 */

describe("rpcSuccessResponse", () => {
	it("echoes id and command with success true and data payload", () => {
		const res = rpcSuccessResponse("id-1", "ping" as never, { ok: true } as never);
		expect(res).toEqual({
			id: "id-1",
			type: "response",
			command: "ping",
			success: true,
			data: { ok: true },
		} as never);
	});

	it("omits data when payload is undefined", () => {
		const res = rpcSuccessResponse("id-2", "status" as never);
		expect(res).toEqual({
			id: "id-2",
			type: "response",
			command: "status",
			success: true,
		} as never);
		expect("data" in res).toBe(false);
	});

	it("preserves numeric-looking string ids without coercion", () => {
		const res = rpcSuccessResponse("42", "status" as never, { ready: true } as never);
		expect((res as { id: string }).id).toBe("42");
	});
});

describe("rpcErrorResponse", () => {
	it("carries id, command, success false, and exact error message", () => {
		const res = rpcErrorResponse("e1", "write", "disk full");
		expect(res).toEqual({
			id: "e1",
			type: "response",
			command: "write",
			success: false,
			error: "disk full",
		});
	});

	it("allows undefined id without inventing one", () => {
		const res = rpcErrorResponse(undefined, "read", "missing");
		expect(res.id).toBeUndefined();
		expect(res.success).toBe(false);
		expect(res.error).toBe("missing");
		expect(res.command).toBe("read");
	});
});

describe("rpcUnknownCommandResponse", () => {
	it("drops request id and names the unknown command", () => {
		// Signature is (commandType) only — id is always dropped by design.
		const res = rpcUnknownCommandResponse("not-a-real-cmd");
		expect(res).toEqual({
			id: undefined,
			type: "response",
			command: "not-a-real-cmd",
			success: false,
			error: "Unknown command: not-a-real-cmd",
		});
	});

	it("surface contains Unknown command prefix for empty-looking types", () => {
		const res = rpcUnknownCommandResponse("ghost");
		expect(res.error).toBe("Unknown command: ghost");
		expect(res.id).toBeUndefined();
	});
});
