import { describe, expect, it } from "bun:test";
import {
	rpcErrorResponse,
	rpcSuccessResponse,
	rpcUnknownCommandResponse,
} from "@veyyon/coding-agent/modes/rpc/rpc-mode";

/**
 * RPC response id/command matrix: many ids and command names.
 */

describe("rpc response id/command matrix", () => {
	const ids = [undefined, "a", "1", "uuid-like-abc", ""];
	const commands = ["ping", "get_state", "prompt", "write", "x"];

	it("success always has type response and success true", () => {
		for (const id of ids) {
			for (const cmd of commands) {
				const res = rpcSuccessResponse(id, cmd as never, { ok: true } as never) as {
					id?: string;
					type: string;
					command: string;
					success: boolean;
					data?: { ok: boolean };
				};
				expect(res.type).toBe("response");
				expect(res.success).toBe(true);
				expect(res.command).toBe(cmd);
				expect(res.id).toBe(id);
				expect(res.data).toEqual({ ok: true });
			}
		}
	});

	it("error always has success false and exact message", () => {
		for (const id of ids) {
			for (const cmd of commands) {
				const res = rpcErrorResponse(id, cmd, `err-${cmd}`);
				expect(res.type).toBe("response");
				expect(res.success).toBe(false);
				expect(res.command).toBe(cmd);
				expect(res.id).toBe(id);
				expect(res.error).toBe(`err-${cmd}`);
			}
		}
	});

	it("unknown always drops id", () => {
		for (const cmd of commands) {
			const res = rpcUnknownCommandResponse(cmd);
			expect(res.id).toBeUndefined();
			expect(res.success).toBe(false);
			expect(res.error).toBe(`Unknown command: ${cmd}`);
			expect(res.command).toBe(cmd);
		}
	});
});
