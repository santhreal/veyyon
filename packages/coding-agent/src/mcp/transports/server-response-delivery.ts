import { errorMessage, logger } from "@veyyon/utils";

/**
 * Report a JSON-RPC response that never reached the server.
 *
 * Both the streamable-HTTP and the SSE transport answer server-to-client
 * requests (sampling, elicitation) by POSTing a response back. Both swallowed a
 * failed POST, one of them under the comment "best-effort response delivery".
 *
 * It is not best-effort from the server's side. The server asked a question, we
 * did the work to answer it, and then dropped the answer. The server waits on a
 * reply that is never coming, so the operator sees an MCP tool that hangs with
 * nothing anywhere connecting the hang to the send that failed (Law 10).
 *
 * This is the one place that report is written, so the two transports cannot
 * drift into describing the same failure differently. Delivery is still not
 * retried beyond each transport's existing auth retry, because a dead
 * connection cannot be talked into life from here.
 */
export function reportUndeliveredServerResponse(details: {
	/** The server's URL, which is what identifies it in a config with several. */
	url: string;
	/** The JSON-RPC id the server is waiting on. */
	requestId: string | number;
	/** Whether the undelivered payload was a result or an error response. */
	kind: "result" | "error";
	cause: unknown;
}): void {
	logger.warn("Could not deliver a response to an MCP server request; the server is still waiting for it", {
		server: details.url,
		requestId: details.requestId,
		responseKind: details.kind,
		error: errorMessage(details.cause),
		fix: "The server may have disconnected. If its tool calls hang, reconnect it with `/mcp`.",
	});
}
