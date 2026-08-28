import { errorMessage, logger } from "@veyyon/utils";

/** Report a JSON-RPC response that never reached the server. Both the streamable-HTTP and the SSE transport answer server-to-client */
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
