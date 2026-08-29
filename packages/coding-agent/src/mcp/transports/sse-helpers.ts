export interface MCPTimeoutOperation {
	signal?: AbortSignal;
	clear: () => void;
	isTimeoutAbort: (error: unknown) => boolean;
}

export interface PendingLegacySseRequest {
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
	operation: MCPTimeoutOperation;
	abortHandler?: () => void;
}

/** Legacy MCP HTTP+SSE transport from protocol revision 2024-11-05. */
