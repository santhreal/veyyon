/**
 * A JSON-RPC error the server could not attribute to a request, and what a transport does with it.
 *
 * WHY THIS EXISTS. JSON-RPC 2.0 requires `"id": null` on an error found before the request's id
 * could be read: a parse error, an invalid envelope. Every transport here dispatched on
 * `message.id != null`, so such a reply matched neither the response branch nor the
 * server-request branch, fell through to the notification branch, had no `method`, and was
 * dropped without a word. The caller's promise then sat until its timeout and reported that the
 * server had not answered, when the server had answered and named the problem.
 *
 * That is a silent fallback: the intended mechanism (surface the server's error) failed and the
 * code quietly did something else. It was not hypothetical either. Veyyon's own memory server
 * emits exactly this shape (`err(null, -32700, "Parse error")` in `@veyyon/mnemopi`), so veyyon
 * talking to veyyon lost parse errors.
 *
 * A connection that cannot parse what we send is broken for every request on it, not just one, so
 * an unattributable error fails ALL of them with the server's own code and message.
 */
import type { JsonRpcMessage, JsonRpcResponse } from "./types";

/** One in-flight request, as each transport's pending map holds it. */
export interface RejectablePendingRequest {
	reject(error: Error): void;
}

/**
 * The message is a response carrying an error that names no request.
 *
 * Requires `error` rather than accepting any null-id response: a null id with a `result` is not
 * something the spec produces, and treating it as a failure would invent one.
 */
export function isUnattributableError(message: JsonRpcMessage): message is JsonRpcResponse {
	return "id" in message && message.id === null && "error" in message && message.error != null;
}

/** The operator-facing text for a JSON-RPC error, in the one format every transport already used. */
export function describeJsonRpcError(error: { code: number; message: string }): string {
	return `MCP error ${error.code}: ${error.message}`;
}

/**
 * Fail every in-flight request with the server's error, and empty the map.
 *
 * @returns how many requests were failed, so a caller can log something truthful. Zero is a real
 *   outcome, not a no-op to hide: a server that reports a parse error while nothing is in flight
 *   still told us the connection is broken.
 */
export function rejectAllPending<TRequest extends RejectablePendingRequest>(
	pending: Map<string | number, TRequest>,
	error: { code: number; message: string },
	onEach?: (request: TRequest) => void,
): number {
	const failed = [...pending.values()];
	pending.clear();
	for (const request of failed) {
		onEach?.(request);
		request.reject(new Error(describeJsonRpcError(error)));
	}
	return failed.length;
}
