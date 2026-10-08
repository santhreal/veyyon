/**
 * A server-to-client MCP request is answered by one function for every transport.
 *
 * WHY: the stdio, streamable-HTTP and SSE transports each mapped a request to its JSON-RPC response with
 * their own copy of the same three branches: no handler, a handler that returned, a handler that threw.
 * Three copies of a protocol mapping drift; one of them answering a missing handler with a different code,
 * or a `void` handler with `null` instead of `{}`, is invisible until a server rejects the reply.
 *
 * WHAT CLASS THIS CLOSES: every outcome of the handler, for both id kinds JSON-RPC allows, at
 * `answerServerRequest`, which each transport's dispatcher calls.
 *
 * WHAT IT DOES NOT CATCH: delivery of the answer, which `server-response-delivery.test.ts` covers.
 */
import { describe, expect, it } from "bun:test";
import { answerServerRequest, type JsonRpcRequest } from "@veyyon/coding-agent/mcp/types";

const request = (id: string | number, params?: Record<string, unknown>): JsonRpcRequest => ({
	jsonrpc: "2.0",
	id,
	method: "roots/list",
	params,
});

describe.each([7, "req-7"])("answerServerRequest (id %p)", id => {
	it("answers Method not found when the transport has no handler", async () => {
		expect(await answerServerRequest(undefined, request(id))).toEqual({
			jsonrpc: "2.0",
			id,
			error: { code: -32601, message: "Method not found" },
		});
	});

	it("passes the method and params to the handler and answers with its result", async () => {
		const calls: Array<[string, unknown]> = [];
		const answer = await answerServerRequest(
			async (method, params) => {
				calls.push([method, params]);
				return { roots: [{ uri: "file:///repo" }] };
			},
			request(id, { cursor: "c1" }),
		);
		expect(calls).toEqual([["roots/list", { cursor: "c1" }]]);
		expect(answer).toEqual({ jsonrpc: "2.0", id, result: { roots: [{ uri: "file:///repo" }] } });
	});

	it("answers an empty result when the handler returns nothing", async () => {
		expect(await answerServerRequest(async () => undefined, request(id))).toEqual({ jsonrpc: "2.0", id, result: {} });
	});

	it("keeps a falsy result the handler returned", async () => {
		expect(await answerServerRequest(async () => 0, request(id))).toEqual({ jsonrpc: "2.0", id, result: 0 });
	});

	it("answers with the code and message of a thrown JSON-RPC error", async () => {
		const thrown = Object.assign(new Error("Elicitation declined"), { code: -32042 });
		expect(
			await answerServerRequest(async () => {
				throw thrown;
			}, request(id)),
		).toEqual({ jsonrpc: "2.0", id, error: { code: -32042, message: "Elicitation declined" } });
	});

	it("answers Internal error code with the thrown sentence when the throw carries no code", async () => {
		expect(
			await answerServerRequest(async () => {
				throw "sampling is disabled";
			}, request(id)),
		).toEqual({ jsonrpc: "2.0", id, error: { code: -32603, message: "sampling is disabled" } });
	});
});
