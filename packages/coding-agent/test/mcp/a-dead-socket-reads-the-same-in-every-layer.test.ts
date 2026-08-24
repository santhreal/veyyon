/**
 * WHY: two rule sets read the same sentence. `mcp/tool-bridge.ts` kept nine literals of its own
 * (`econnrefused`, `econnreset`, `epipe`, `enetunreach`, `ehostunreach`, `fetch failed`,
 * `network error`, plus the two transport-state phrases it now asks their owner about) beside the
 * error registry's transport vocabulary, and the two disagreed: `ENETUNREACH` and `EHOSTUNREACH`
 * reconnected an MCP session and were a permanent failure to a provider call.
 *
 * Class closed: the socket vocabulary has one owner (`DEAD_SOCKET_ERRNOS` /
 * `DEAD_SOCKET_PHRASE_SOURCES` in the network domain), every errno it lists reads the same in the
 * provider ladder and in the MCP reconnect decision, and each surviving layer keeps only the rules
 * that are its own — the MCP session shape (404/502/503, the transports' own wording) here, the
 * wider transient set (a live peer answering 500, a request held past its deadline) there. A second
 * local vocabulary turns this suite red, because the sentences that belong to the wider set only are
 * asserted NOT to reconnect an MCP session.
 *
 * Not caught here: whether the reconnect itself succeeds, and the attempt bound around it. Both are
 * pinned by `mcp-reconnect.test.ts`, which drives `MCPTool.execute`.
 */
import { describe, expect, it } from "bun:test";
import {
	DEAD_SOCKET_ERRNOS,
	DEAD_SOCKET_PHRASE_SOURCES,
	isTransientErrorText,
	namesDeadSocket,
} from "@veyyon/ai/error/flags";
import { isProviderRetryableError } from "@veyyon/ai/error/retryable";
import type { MCPReconnect } from "@veyyon/coding-agent/mcp/tool-bridge";
import { MCPTool, mcpFailureWarrantsReconnect } from "@veyyon/coding-agent/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolCallResult, MCPTransport } from "@veyyon/coding-agent/mcp/types";

const TOOL_DEF = { name: "do_stuff", inputSchema: { type: "object" as const } };

function mockTransport(requestFn: () => Promise<unknown>): MCPTransport {
	return {
		connected: true,
		request: requestFn as MCPTransport["request"],
		async notify() {},
		async close() {},
	};
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

function toolCallResult(text: string): MCPToolCallResult {
	return { content: [{ type: "text", text }], isError: false };
}

/** The wording a phrase source accepts, with the regex separator spelled as a space. */
function phraseSample(source: string): string {
	return source.replace(/\.\?/g, " ");
}

describe("the socket vocabulary is one list", () => {
	it("reads every errno the owner lists the same way in both layers", () => {
		expect(DEAD_SOCKET_ERRNOS.length).toBeGreaterThan(0);

		for (const errno of DEAD_SOCKET_ERRNOS) {
			const sentence = `connect ${errno} 10.0.0.1:443`;
			expect(namesDeadSocket(sentence)).toBe(true);
			expect(isTransientErrorText(sentence)).toBe(true);
			expect(mcpFailureWarrantsReconnect(new Error(sentence))).toBe(true);
			expect(isProviderRetryableError(new Error(sentence))).toBe(true);
		}
	});

	it("reads every prose rendering the owner lists the same way in both layers", () => {
		expect(DEAD_SOCKET_PHRASE_SOURCES.length).toBeGreaterThan(0);

		for (const source of DEAD_SOCKET_PHRASE_SOURCES) {
			const sentence = `server said: ${phraseSample(source)}`;
			expect(namesDeadSocket(sentence)).toBe(true);
			expect(mcpFailureWarrantsReconnect(new Error(sentence))).toBe(true);
			expect(isProviderRetryableError(new Error(sentence))).toBe(true);
		}
	});

	it("does not read a socket out of an identifier that merely contains an errno", () => {
		expect(namesDeadSocket("bad argument EPIPELINE")).toBe(false);
		expect(namesDeadSocket("unknown model claude-ETIMEDOUT-9")).toBe(false);
		expect(mcpFailureWarrantsReconnect(new Error("tool myECONNRESETtool is unknown"))).toBe(false);
	});
});

describe("each layer keeps only the rules that are its own", () => {
	// A live server that answers is not a dead socket. These reconnect nothing, and a second local
	// vocabulary in the bridge is exactly what would make them true again.
	const ALIVE_BUT_FAILING = [
		"HTTP 500: internal error",
		"socket hang up",
		"Request timeout after 30000ms",
		"overloaded",
		"429 Too Many Requests",
		"service unavailable",
	];

	for (const message of ALIVE_BUT_FAILING) {
		it(`does not reconnect an MCP session for: ${message}`, () => {
			expect(namesDeadSocket(message)).toBe(false);
			expect(mcpFailureWarrantsReconnect(new Error(message))).toBe(false);
		});
	}

	// The MCP session shape: a restarted server answers the old session id with 404, a proxy in front
	// of it with 502 or 503. Those are this layer's own rules, and the shared owner says nothing
	// about them.
	const STALE_SESSION = ["HTTP 404: session not found", "http 502: bad gateway", "HTTP 503: unavailable"];

	for (const message of STALE_SESSION) {
		it(`reconnects on the MCP session shape, which the shared owner does not name: ${message}`, () => {
			expect(namesDeadSocket(message)).toBe(false);
			expect(mcpFailureWarrantsReconnect(new Error(message))).toBe(true);
		});
	}

	it("reconnects on the transports' own wording, owned next to the strings", () => {
		expect(mcpFailureWarrantsReconnect(new Error('server "x" is not connected'))).toBe(true);
		expect(mcpFailureWarrantsReconnect(new Error('server "x" closed its connection'))).toBe(true);
	});

	it("never reconnects for a value that is not an Error", () => {
		expect(mcpFailureWarrantsReconnect("ECONNREFUSED")).toBe(false);
		expect(mcpFailureWarrantsReconnect({ message: "ECONNREFUSED" })).toBe(false);
		expect(mcpFailureWarrantsReconnect(null)).toBe(false);
	});
});

describe("an unreachable host reconnects the real tool call", () => {
	it("retries once through a fresh connection and ends", async () => {
		let failures = 0;
		let successes = 0;
		let reconnects = 0;
		const unreachable = mockTransport(async () => {
			failures++;
			throw new Error("connect EHOSTUNREACH 10.0.0.1:443");
		});
		const reopened = mockTransport(async () => {
			successes++;
			return toolCallResult("ok");
		});
		const reconnect: MCPReconnect = async () => {
			reconnects++;
			return makeConnection(reopened, "test-server-reopened");
		};

		const tool = new MCPTool(makeConnection(unreachable), TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, () => {}, {} as Parameters<MCPTool["execute"]>[3]);

		expect(reconnects).toBe(1);
		expect(failures).toBe(1);
		expect(successes).toBe(1);
		expect(result.content[0]).toEqual({ type: "text", text: "ok" });
	});
});
