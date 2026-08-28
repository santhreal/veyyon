/** A JSON-RPC error the server could not attribute to a request, and what a transport does with it. could be read: a parse error, an invalid envelope. Every transport here dispatched on */
import type { JsonRpcMessage, JsonRpcResponse } from "./types";

/** One in-flight request, as each transport's pending map holds it. */
export interface RejectablePendingRequest {
	reject(error: Error): void;
}

/** The message is a response carrying an error that names no request. Requires `error` rather than accepting any null-id response: a null id with a `result` is not */
export function isUnattributableError(message: JsonRpcMessage): message is JsonRpcResponse {
	return "id" in message && message.id === null && "error" in message && message.error != null;
}

/** The operator-facing text for a JSON-RPC error, in the one format every transport already used. */
export function describeJsonRpcError(error: { code: number; message: string }): string {
	return `MCP error ${error.code}: ${error.message}`;
}

/** Fail every in-flight request with the server's error, and empty the map. @returns how many requests were failed, so a caller can log something truthful. Zero is a real outcome, not a no-op to hide: a server that reports a parse error while nothing is in flight */
export function rejectAllPending<TRequest extends RejectablePendingRequest>(
	pending: Map<string | number, TRequest>,
	error: { code: number; message: string },
	onEach?: (request: TRequest) => void,
): number {
	const failed = Array.from(pending.values());
	pending.clear();
	for (const request of failed) {
		onEach?.(request);
		request.reject(new Error(describeJsonRpcError(error)));
	}
	return failed.length;
}
