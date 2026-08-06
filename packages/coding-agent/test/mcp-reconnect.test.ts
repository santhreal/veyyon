import { describe, expect, it } from "bun:test";
import type { MCPReconnect } from "@veyyon/coding-agent/mcp/tool-bridge";
import { DeferredMCPTool, isRetriableConnectionError, MCPTool } from "@veyyon/coding-agent/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolCallResult, MCPTransport } from "@veyyon/coding-agent/mcp/types";
import { ToolAbortError } from "@veyyon/coding-agent/tools/tool-errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock transport where `request` is controlled by the caller. */
function mockTransport(requestFn: (...args: Parameters<MCPTransport["request"]>) => Promise<unknown>): MCPTransport {
	return {
		connected: true,
		request: requestFn as MCPTransport["request"],
		async notify() {},
		async close() {},
	};
}

const TOOL_DEF = { name: "do_stuff", inputSchema: { type: "object" as const } };

function toolCallResult(text: string, isError = false): MCPToolCallResult {
	return { content: [{ type: "text", text }], isError };
}

function makeConnection(transport: MCPTransport, name = "test-server"): MCPServerConnection {
	return {
		name,
		config: { type: "stdio" as const, command: "echo" },
		transport,
		serverInfo: { name: "test", version: "1.0" },
		capabilities: { tools: {} },
	};
}

/**
 * The full text a failing MCP tool hands the MODEL.
 *
 * Asserted whole rather than by substring, because the two halves are what make
 * it useful and either can be lost independently: the identification (which tool,
 * which server, which underlying failure) and the model's own next step. Before
 * this, the model got `MCP error: ECONNRESET` and its only two options were to
 * retry the identical call forever or abandon the task.
 */
function modelFacingFailure(detail: string, server = "test-server", tool = TOOL_DEF.name): string {
	return (
		`MCP tool "${tool}" on server "${server}" failed: ${detail}\n` +
		"Next step: retry this call at most once. A transport, auth or configuration failure returns the same error " +
		"on every attempt, so a retry loop costs turns and changes nothing. If a second attempt fails, stop calling " +
		"this tool and tell the operator what failed, which server it was on, and the fix named above."
	);
}

// ---------------------------------------------------------------------------
// isRetriableConnectionError
// ---------------------------------------------------------------------------

describe("isRetriableConnectionError", () => {
	const retriable = [
		"ECONNREFUSED",
		"ECONNRESET",
		"EPIPE",
		"ENETUNREACH",
		"EHOSTUNREACH",
		"fetch failed",
		"Transport not connected",
		"network error",
		"HTTP 404: Not Found",
		"HTTP 502: Bad Gateway",
		"HTTP 503: Service Unavailable",
		"Transport closed",
	];

	for (const msg of retriable) {
		it(`matches: ${msg}`, () => {
			expect(isRetriableConnectionError(new Error(msg))).toBe(true);
		});
	}

	const nonRetriable = [
		"MCP error -32603: Server still initializing",
		"HTTP 401: Unauthorized",
		"HTTP 403: Forbidden",
		"HTTP 400: Bad Request",
		"Request timeout after 30000ms",
		"SSE response timeout after 30000ms",
		"Tool not found: do_stuff",
	];

	for (const msg of nonRetriable) {
		it(`does not match: ${msg}`, () => {
			expect(isRetriableConnectionError(new Error(msg))).toBe(false);
		});
	}

	it("returns false for non-Error values", () => {
		expect(isRetriableConnectionError("ECONNREFUSED")).toBe(false);
		expect(isRetriableConnectionError(null)).toBe(false);
		expect(isRetriableConnectionError(undefined)).toBe(false);
		expect(isRetriableConnectionError({ message: "ECONNREFUSED" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// MCPTool.execute retry behavior
// ---------------------------------------------------------------------------

describe("MCPTool.execute retry on connection error", () => {
	const noop = () => {};
	const noCtx = {} as Parameters<MCPTool["execute"]>[3];

	it("retries once on retriable error when reconnect succeeds", async () => {
		let callCount = 0;
		const failTransport = mockTransport(async () => {
			callCount++;
			throw new Error("ECONNREFUSED");
		});
		const successTransport = mockTransport(async () => {
			callCount++;
			return toolCallResult("ok");
		});

		const oldConn = makeConnection(failTransport);
		const newConn = makeConnection(successTransport, "test-server-new");
		const reconnect: MCPReconnect = async () => newConn;

		const tool = new MCPTool(oldConn, TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(callCount).toBe(2); // 1 fail + 1 retry
		expect(result.details?.isError).toBeFalsy();
		expect(result.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("retries on transport closed and rebinding succeeds", async () => {
		let oldCalls = 0;
		let newCalls = 0;
		let reconnects = 0;
		const closedTransport = mockTransport(async () => {
			oldCalls++;
			throw new Error("Transport closed");
		});
		const reopenedTransport = mockTransport(async () => {
			newCalls++;
			return toolCallResult("ok");
		});

		const oldConn = makeConnection(closedTransport);
		const newConn = makeConnection(reopenedTransport, "test-server-transport-closed");
		const reconnect: MCPReconnect = async () => {
			reconnects++;
			return newConn;
		};

		const tool = new MCPTool(oldConn, TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(reconnects).toBe(1);
		expect(oldCalls).toBe(1);
		expect(newCalls).toBe(1);
		expect(result.details?.isError).toBeFalsy();
		expect(result.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("reuses refreshed connection on later call", async () => {
		let oldCalls = 0;
		let newCalls = 0;
		let reconnects = 0;
		const oldTransport = mockTransport(async () => {
			oldCalls++;
			throw new Error("ECONNREFUSED");
		});
		const newTransport = mockTransport(async () => {
			newCalls++;
			return toolCallResult("ok");
		});

		const oldConn = makeConnection(oldTransport);
		const newConn = makeConnection(newTransport, "test-server-rebound");
		const reconnect: MCPReconnect = async () => {
			reconnects++;
			return newConn;
		};

		const tool = new MCPTool(oldConn, TOOL_DEF, reconnect);
		const first = await tool.execute("call-1", {}, noop, noCtx);
		const second = await tool.execute("call-2", {}, noop, noCtx);

		expect(oldCalls).toBe(1);
		expect(newCalls).toBe(2);
		expect(reconnects).toBe(1);
		expect(first.details?.isError).toBeFalsy();
		expect(second.details?.isError).toBeFalsy();
		expect(first.content[0]).toEqual({ type: "text", text: "ok" });
		expect(second.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("returns error result when reconnect returns null", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("ECONNRESET");
		});
		const reconnect: MCPReconnect = async () => null;

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: modelFacingFailure("ECONNRESET") });
	});

	it("does not retry on non-retriable error", async () => {
		let reconnectCalled = false;
		const failTransport = mockTransport(async () => {
			throw new Error("MCP error -32603: Internal error");
		});
		const reconnect: MCPReconnect = async () => {
			reconnectCalled = true;
			return null;
		};

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(reconnectCalled).toBe(false);
		expect(result.details?.isError).toBe(true);
	});

	it("does not retry when no reconnect callback", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("ECONNREFUSED");
		});

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF); // no reconnect
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: modelFacingFailure("ECONNREFUSED") });
	});

	it("returns error from retry when retry also fails", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("ECONNREFUSED");
		});
		const retryFailTransport = mockTransport(async () => {
			throw new Error("HTTP 503: Service Unavailable");
		});
		const reconnect: MCPReconnect = async () => makeConnection(retryFailTransport);

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.isError).toBe(true);
		expect(result.content[0]).toEqual({
			type: "text",
			text: modelFacingFailure("HTTP 503: Service Unavailable"),
		});
	});

	it("preserves provider info from new connection on successful retry", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("fetch failed");
		});
		const successTransport = mockTransport(async () => toolCallResult("ok"));

		const oldConn = makeConnection(failTransport);
		oldConn._source = { provider: "old-provider", providerName: "Old", path: "/old", level: "user" };
		const newConn = makeConnection(successTransport);
		newConn._source = { provider: "new-provider", providerName: "New", path: "/new", level: "user" };

		const tool = new MCPTool(oldConn, TOOL_DEF, async () => newConn);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.provider).toBe("new-provider");
		expect(result.details?.providerName).toBe("New");
	});

	it("falls back to original provider when new connection has no source", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("fetch failed");
		});
		const successTransport = mockTransport(async () => toolCallResult("ok"));

		const oldConn = makeConnection(failTransport);
		oldConn._source = { provider: "orig", providerName: "Original", path: "/orig", level: "user" };
		const newConn = makeConnection(successTransport);
		// newConn has no _source

		const tool = new MCPTool(oldConn, TOOL_DEF, async () => newConn);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.provider).toBe("orig");
		expect(result.details?.providerName).toBe("Original");
	});

	it("rebuilds reconnect attempts from raw args with the then-current transform", async () => {
		const rawSecret = "reconnect-raw-secret";
		const sentArgs: unknown[] = [];
		const firstTransport = mockTransport(async (_method, params) => {
			sentArgs.push(params?.arguments);
			throw new Error("ECONNRESET");
		});
		const secondTransport = mockTransport(async (_method, params) => {
			sentArgs.push(params?.arguments);
			return toolCallResult("ok");
		});
		const context = {
			obfuscateProviderText: (text: string) => text.replaceAll(rawSecret, "first-safe"),
		} as Parameters<MCPTool["execute"]>[3];
		const rawArgs = { nested: { token: rawSecret } };
		const tool = new MCPTool(makeConnection(firstTransport), TOOL_DEF, async () => {
			context.obfuscateProviderText = text => text.replaceAll(rawSecret, "second-safe");
			return makeConnection(secondTransport);
		});

		await tool.execute("call-1", rawArgs, noop, context);

		expect(sentArgs).toEqual([{ nested: { token: "first-safe" } }, { nested: { token: "second-safe" } }]);
		expect(rawArgs).toEqual({ nested: { token: rawSecret } });
	});
});

describe("DeferredMCPTool.execute provider boundary", () => {
	it("rebuilds reconnect attempts from raw args with the then-current transform", async () => {
		const rawSecret = "deferred-reconnect-raw-secret";
		const sentArgs: unknown[] = [];
		const firstConnection = makeConnection(
			mockTransport(async (_method, params) => {
				sentArgs.push(params?.arguments);
				throw new Error("Transport closed");
			}),
		);
		const secondConnection = makeConnection(
			mockTransport(async (_method, params) => {
				sentArgs.push(params?.arguments);
				return toolCallResult("ok");
			}),
		);
		const context = {
			obfuscateProviderText: (text: string) => text.replaceAll(rawSecret, "first-safe"),
		} as Parameters<DeferredMCPTool["execute"]>[3];
		const rawArgs = { nested: { token: rawSecret } };
		const tool = new DeferredMCPTool(
			"test-server",
			TOOL_DEF,
			async () => firstConnection,
			undefined,
			async () => {
				context.obfuscateProviderText = text => text.replaceAll(rawSecret, "second-safe");
				return secondConnection;
			},
		);

		await tool.execute("call-1", rawArgs, undefined, context);

		expect(sentArgs).toEqual([{ nested: { token: "first-safe" } }, { nested: { token: "second-safe" } }]);
		expect(rawArgs).toEqual({ nested: { token: rawSecret } });
	});
});

describe("reconnect abort propagation", () => {
	const noop = () => {};
	const noCtx = {} as Parameters<MCPTool["execute"]>[3];
	const noDeferredCtx = {} as Parameters<DeferredMCPTool["execute"]>[3];

	it("throws ToolAbortError when MCPTool reconnect is aborted", async () => {
		// KEPT as an identity assertion: the type is what the agent loop branches
		// on. Cancel a call whose server is unreachable and whose reconnect never
		// settles, and it must surface as an abort that stops the turn, not as a
		// tool result the model answers by calling the same dead server again.
		// Dropping the abort guard in front of the error-to-result conversion turns
		// this rejection into a resolved result, which is exactly the regression.
		const failTransport = mockTransport(async () => {
			throw new Error("ECONNRESET");
		});
		const { promise } = Promise.withResolvers<MCPServerConnection | null>();
		const reconnect: MCPReconnect = async () => promise;

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF, reconnect);
		const controller = new AbortController();
		const pending = tool.execute("call-1", {}, noop, noCtx, controller.signal);
		controller.abort();

		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
	});

	it("throws ToolAbortError when DeferredMCPTool reconnect is aborted", async () => {
		// Same identity contract on the deferred path, which reaches the reconnect
		// from a different failure (no connection yet) and shares the guard.
		const getConnection = async () => {
			throw new Error("MCP server not connected");
		};
		const { promise } = Promise.withResolvers<MCPServerConnection | null>();
		const reconnect: MCPReconnect = async () => promise;

		const tool = new DeferredMCPTool("test-server", TOOL_DEF, getConnection, undefined, reconnect);
		const controller = new AbortController();
		const pending = tool.execute("call-1", {}, noop, noDeferredCtx, controller.signal);
		controller.abort();

		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
	});
});
