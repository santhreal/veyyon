/**
 * An MCP error the server could not attribute to a request is SURFACED, never dropped.
 *
 * WHY THIS SUITE EXISTS. JSON-RPC 2.0 requires `"id": null` on an error found before the
 * request's id could be read: a parse error, an invalid envelope. `mcp/types.ts` typed the
 * response id as `string | number`, so that case was not expressible, and both streaming
 * transports dispatched on it being non-null:
 *
 *     if ("id" in message && message.id != null) { ...resolve the matching request... }
 *     if ("method" in message) { ...it must be a notification... }
 *
 * A `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}` matched neither.
 * It has no `method`, so it fell out of the notification branch too, and was dropped in silence.
 * Every caller then waited out its own timeout and reported that the server had not answered --
 * when the server HAD answered, and had named the problem. That is a silent fallback in the
 * Law 10 sense: the intended mechanism failed and the code quietly did something else.
 *
 * It was not hypothetical. Veyyon's own memory server emits exactly that shape
 * (`err(null, -32700, "Parse error")` in `@veyyon/mnemopi`), so veyyon talking to veyyon lost
 * parse errors. The collision that hid it for so long was a naming one: mnemopi's response type
 * declared `id: string | number | null` and the client's declared `string | number`, and both
 * were called `JsonRpcResponse`.
 *
 * These cases are on the shared predicate and the fan-out helper rather than on a live transport,
 * because that is where the decision is made; the transports call these and nothing else.
 */
import { describe, expect, it } from "bun:test";
import type { JsonRpcMessage } from "@veyyon/coding-agent/mcp/types";
import {
	describeJsonRpcError,
	isUnattributableError,
	type RejectablePendingRequest,
	rejectAllPending,
} from "@veyyon/coding-agent/mcp/unattributable-error";

/** A pending request that records what it was rejected with. */
function pendingRequest(): RejectablePendingRequest & { rejectedWith: Error[] } {
	const rejectedWith: Error[] = [];
	return { rejectedWith, reject: error => void rejectedWith.push(error) };
}

describe("isUnattributableError", () => {
	/**
	 * The exact frame that used to vanish, byte for byte as a server sends it.
	 *
	 * `-32700` is the JSON-RPC parse-error code and is what `@veyyon/mnemopi`'s own MCP server
	 * emits, so this is the in-repo reproduction rather than an invented shape.
	 */
	it("recognizes a null-id parse error", () => {
		const frame = {
			jsonrpc: "2.0",
			id: null,
			error: { code: -32700, message: "Parse error" },
		} as unknown as JsonRpcMessage;

		expect(isUnattributableError(frame)).toBe(true);
	});

	/** An ordinary error response belongs to ONE request and must keep going down the normal path. */
	it("does not claim an error that names its request", () => {
		const frame = {
			jsonrpc: "2.0",
			id: 7,
			error: { code: -32601, message: "Method not found" },
		} as unknown as JsonRpcMessage;

		expect(isUnattributableError(frame)).toBe(false);
	});

	/** A successful response is never this, whatever its id. */
	it("does not claim a successful response", () => {
		const frame = { jsonrpc: "2.0", id: 7, result: { ok: true } } as unknown as JsonRpcMessage;

		expect(isUnattributableError(frame)).toBe(false);
	});

	/**
	 * A null id with a RESULT is not something the spec produces, and treating it as a failure
	 * would invent an error nobody reported. The predicate requires `error` for that reason.
	 */
	it("does not claim a null-id message carrying a result", () => {
		const frame = { jsonrpc: "2.0", id: null, result: { ok: true } } as unknown as JsonRpcMessage;

		expect(isUnattributableError(frame)).toBe(false);
	});

	/** A notification has no id at all; absent and null are different states. */
	it("does not claim a notification", () => {
		const frame = { jsonrpc: "2.0", method: "notifications/message", params: {} } as JsonRpcMessage;

		expect(isUnattributableError(frame)).toBe(false);
	});

	/**
	 * A server-to-client REQUEST carries a method and an id, and one with a null id is malformed
	 * rather than an error report. Pinned because both dispatchers check this predicate BEFORE
	 * their server-request branch, so a false positive here would steal a real request.
	 */
	it("does not claim a message that carries a method", () => {
		const frame = {
			jsonrpc: "2.0",
			id: null,
			method: "sampling/createMessage",
		} as unknown as JsonRpcMessage;

		expect(isUnattributableError(frame)).toBe(false);
	});

	/** `error: null` is not an error; a shape check that only tested the KEY would pass here. */
	it("does not claim a null-id message whose error is null", () => {
		const frame = { jsonrpc: "2.0", id: null, error: null } as unknown as JsonRpcMessage;

		expect(isUnattributableError(frame)).toBe(false);
	});
});

describe("describeJsonRpcError", () => {
	/**
	 * The exact operator-facing bytes, because this string is what a user reads and what the
	 * handbook's troubleshooting section quotes. Both transports already formatted attributed
	 * errors this way and the unattributable path must not read differently.
	 */
	it("formats the code and message the way every transport already did", () => {
		expect(describeJsonRpcError({ code: -32700, message: "Parse error" })).toBe("MCP error -32700: Parse error");
	});
});

describe("rejectAllPending", () => {
	/**
	 * The fix, stated directly: a connection that cannot parse what we send is broken for EVERY
	 * request on it, so all of them fail rather than all of them hanging.
	 */
	it("fails every in-flight request with the server's code and message", () => {
		const first = pendingRequest();
		const second = pendingRequest();
		const pending = new Map<string | number, RejectablePendingRequest>([
			[1, first],
			["tools/call-2", second],
		]);

		const failed = rejectAllPending(pending, { code: -32700, message: "Parse error" });

		expect(failed).toBe(2);
		expect(first.rejectedWith.map(error => error.message)).toEqual(["MCP error -32700: Parse error"]);
		expect(second.rejectedWith.map(error => error.message)).toEqual(["MCP error -32700: Parse error"]);
	});

	/**
	 * The map is emptied, so a later close cannot reject the same promise a second time.
	 *
	 * Both transports reject everything still pending when the connection closes, and a request
	 * left in the map would be rejected twice: harmless for the caller, but it hides how many
	 * requests the parse error actually killed in the log line that reports it.
	 */
	it("empties the map so a later close cannot reject the same request again", () => {
		const only = pendingRequest();
		const pending = new Map<string | number, RejectablePendingRequest>([[1, only]]);

		rejectAllPending(pending, { code: -32700, message: "Parse error" });

		expect(pending.size).toBe(0);
		expect(only.rejectedWith).toHaveLength(1);
	});

	/**
	 * Nothing in flight is a real outcome, not a reason to stay quiet.
	 *
	 * The count is what the transports log, and zero still means the connection reported that it
	 * cannot read what we send.
	 */
	it("reports zero when nothing was in flight", () => {
		expect(rejectAllPending(new Map(), { code: -32700, message: "Parse error" })).toBe(0);
	});

	/**
	 * Per-request cleanup runs BEFORE the rejection.
	 *
	 * The SSE transport clears a timeout and removes an abort listener for each pending request.
	 * If that ran after `reject`, a caller resuming synchronously on the rejection could observe a
	 * timer that was still armed, and on the SSE path that timer is what turns into a spurious
	 * "Request timeout" after the real error was already reported.
	 */
	it("runs per-request cleanup before rejecting", () => {
		const order: string[] = [];
		const request = {
			reject: () => void order.push("reject"),
		};
		const pending = new Map<string | number, typeof request>([[1, request]]);

		rejectAllPending(pending, { code: -32700, message: "Parse error" }, () => void order.push("cleanup"));

		expect(order).toEqual(["cleanup", "reject"]);
	});

	/** Cleanup sees each request, not just the first, so no listener is left attached. */
	it("runs cleanup for every request", () => {
		const seen: Array<string | number> = [];
		const pending = new Map<string | number, RejectablePendingRequest & { id: string | number }>([
			[1, { id: 1, reject: () => {} }],
			[2, { id: 2, reject: () => {} }],
			["three", { id: "three", reject: () => {} }],
		]);

		rejectAllPending(pending, { code: -32700, message: "Parse error" }, request => void seen.push(request.id));

		expect(seen).toEqual([1, 2, "three"]);
	});
});
