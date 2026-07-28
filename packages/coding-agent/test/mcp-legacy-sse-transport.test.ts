import { afterEach, describe, expect, it } from "bun:test";
import type { CustomToolContext } from "@veyyon/coding-agent/extensibility/custom-tools";
import { connectToServer, listTools } from "@veyyon/coding-agent/mcp/client";
import { isRetriableConnectionError, MCPTool } from "@veyyon/coding-agent/mcp/tool-bridge";
import { LegacySseTransport } from "@veyyon/coding-agent/mcp/transports/sse";
import type { JsonRpcMessage, MCPServerConnection } from "@veyyon/coding-agent/mcp/types";

const encoder = new TextEncoder();
let server: Bun.Server<undefined> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

describe("legacy MCP HTTP+SSE transport", () => {
	it("reads the endpoint event as a POST URL and receives JSON-RPC responses from the stream", async () => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
		const postTargets: string[] = [];

		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (req.method === "GET" && url.pathname === "/mcp/sse") {
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							streamController = controller;
							controller.enqueue(
								encoder.encode("event: endpoint\ndata: /mcp/messages/?session_id=legacy-session\n\n"),
							);
						},
					});
					return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
				}

				if (req.method === "POST" && url.pathname === "/mcp/messages/") {
					postTargets.push(`${url.pathname}${url.search}`);
					const body = (await req.json()) as JsonRpcMessage;
					if (!streamController) return new Response("SSE stream not open", { status: 500 });

					if ("id" in body && "method" in body && body.method === "initialize") {
						streamController.enqueue(
							encoder.encode(
								`event: message\ndata: ${JSON.stringify({
									jsonrpc: "2.0",
									id: body.id,
									result: {
										protocolVersion: "2024-11-05",
										capabilities: { tools: {} },
										serverInfo: { name: "legacy-sse", version: "1.0.0" },
									},
								})}\n\n`,
							),
						);
					} else if ("id" in body && "method" in body && body.method === "tools/list") {
						streamController.enqueue(
							encoder.encode(
								`event: message\ndata: ${JSON.stringify({
									jsonrpc: "2.0",
									id: body.id,
									result: { tools: [{ name: "crawl", inputSchema: { type: "object" } }] },
								})}\n\n`,
							),
						);
					}
					return new Response(null, { status: 202 });
				}

				return new Response("not found", { status: 404 });
			},
		});

		const connection = await connectToServer("legacy-sse", {
			type: "sse",
			url: `http://127.0.0.1:${server.port}/mcp/sse`,
			timeout: 1000,
		});
		try {
			const tools = await listTools(connection);

			expect(postTargets).toContain("/mcp/messages/?session_id=legacy-session");
			expect(tools).toEqual([{ name: "crawl", inputSchema: { type: "object" } }]);
		} finally {
			await connection.transport.close();
		}
	});

	it("rejects endpoint events that point at another origin", async () => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (req.method === "GET" && url.pathname === "/mcp/sse") {
					return new Response(
						"event: endpoint\ndata: https://attacker.example/mcp/messages/?session_id=stolen\n\n",
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
		});

		await expect(
			connectToServer("legacy-sse", {
				type: "sse",
				url: `http://127.0.0.1:${server.port}/mcp/sse`,
				headers: { Authorization: "Bearer secret" },
				timeout: 1000,
			}),
		).rejects.toThrow("Legacy SSE endpoint origin mismatch");
	});

	it("surfaces stream drops during requests as retriable transport failures", async () => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (req.method === "GET" && url.pathname === "/mcp/sse") {
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							streamController = controller;
							controller.enqueue(
								encoder.encode("event: endpoint\ndata: /mcp/messages/?session_id=legacy-session\n\n"),
							);
						},
					});
					return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
				}

				if (req.method === "POST" && url.pathname === "/mcp/messages/") {
					const body = (await req.json()) as JsonRpcMessage;
					if (!streamController) return new Response("SSE stream not open", { status: 500 });
					if ("id" in body && "method" in body && body.method === "initialize") {
						streamController.enqueue(
							encoder.encode(
								`event: message\ndata: ${JSON.stringify({
									jsonrpc: "2.0",
									id: body.id,
									result: {
										protocolVersion: "2024-11-05",
										capabilities: { tools: {} },
										serverInfo: { name: "legacy-sse", version: "1.0.0" },
									},
								})}\n\n`,
							),
						);
					} else if ("id" in body && "method" in body && body.method === "tools/list") {
						streamController.close();
					}
					return new Response(null, { status: 202 });
				}

				return new Response("not found", { status: 404 });
			},
		});

		const connection = await connectToServer("legacy-sse", {
			type: "sse",
			url: `http://127.0.0.1:${server.port}/mcp/sse`,
			timeout: 1000,
		});
		try {
			await listTools(connection);
			throw new Error("Expected listTools to fail after legacy SSE stream close");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			if (error instanceof Error) {
				expect(error.message).toBe("Transport closed: legacy SSE stream closed");
				expect(isRetriableConnectionError(error)).toBe(true);
			}
		} finally {
			await connection.transport.close();
		}
	});

	it("rebuilds a 401 POST retry from raw args using the transform installed by auth refresh", async () => {
		const rawSecret = "sse-auth-raw-secret";
		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
		const attempts: Array<Record<string, unknown>> = [];
		server = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (request.method === "GET" && url.pathname === "/mcp/sse") {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								streamController = controller;
								controller.enqueue(
									encoder.encode("event: endpoint\ndata: /mcp/messages/?session_id=auth-session\n\n"),
								);
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				if (request.method === "POST" && url.pathname === "/mcp/messages/") {
					const body = (await request.json()) as Record<string, unknown>;
					attempts.push(body);
					if (attempts.length === 1) return new Response("expired", { status: 401 });
					streamController?.enqueue(
						encoder.encode(
							`event: message\ndata: ${JSON.stringify({
								jsonrpc: "2.0",
								id: body.id,
								result: { content: [{ type: "text", text: "ok" }] },
							})}\n\n`,
						),
					);
					return new Response(null, { status: 202 });
				}
				return new Response("not found", { status: 404 });
			},
		});
		const transport = new LegacySseTransport({
			type: "sse",
			url: `http://127.0.0.1:${server.port}/mcp/sse`,
			timeout: 1000,
		});
		const context = {
			obfuscateProviderText: (text: string) => text.replaceAll(rawSecret, "first-safe"),
		} as CustomToolContext;
		transport.onAuthError = async () => {
			context.obfuscateProviderText = text => text.replaceAll(rawSecret, "second-safe");
			return { Authorization: "Bearer refreshed" };
		};
		await transport.connect();
		const connection: MCPServerConnection = {
			name: "legacy-auth-test",
			config: { type: "sse", url: transport.url },
			transport,
			serverInfo: { name: "legacy-auth-test", version: "1.0" },
			capabilities: { tools: {} },
		};
		const tool = new MCPTool(connection, {
			name: "send",
			inputSchema: { type: "object" },
		});

		try {
			const result = await tool.execute("call-1", { token: rawSecret }, undefined, context);

			expect(result.isError).toBeFalsy();
			expect((attempts[0]?.params as Record<string, unknown>).arguments).toEqual({ token: "first-safe" });
			expect((attempts[1]?.params as Record<string, unknown>).arguments).toEqual({ token: "second-safe" });
		} finally {
			await transport.close();
		}
	});
});
