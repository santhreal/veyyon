/**
 * WHY THIS SUITE EXISTS AND WHICH CLASS IT CLOSES.
 *
 * Session evidence from live Cursor runs identified a 600-second watchdog stall:
 * Cursor log reported `cannot encode field agent.v1.GrepContentMatch.line_number to binary: invalid int32: 1753660800000`,
 * followed by a watchdog stall because the server-message handler rejection was logged and swallowed.
 *
 * When ripgrep/grep tool results contain lines with timestamp prefixes (e.g. `log.txt:1753660800000: [INFO] message`),
 * the regex parsed `1753660800000` as the line number. Because protobuf `GrepContentMatch.line_number` is an `int32`
 * (`-2147483648` to `2147483647`), protobuf binary serialization threw an unhandled error.
 *
 * In `packages/ai/src/providers/cursor.ts`, `handleServerMessage(...).catch(...)` caught the rejection,
 * logged a warning, and did not fail the turn or close the HTTP/2 stream. The server, waiting for the
 * exec response, never sent `turnEnded`, and the client waited for the 600-second watchdog.
 *
 * This suite proves:
 * 1. Grep line numbers are validated at the tool-result parsing boundary: timestamp-bearing or overflowing
 *    line numbers are not mapped into `GrepContentMatch` with invalid int32 values.
 * 2. Valid line numbers (1..2147483647) and count values are preserved accurately.
 * 3. Any async server-message handler failure immediately fails and closes the turn, rejecting with an
 *    actionable surfaced error without waiting for a watchdog.
 *
 * What it does not catch:
 * Upstream Cursor backend network outages or external TLS handshake timeouts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { buildGrepResultFromToolResult, streamCursor } from "@veyyon/ai/providers/cursor";
import { setCursorProviderModule } from "@veyyon/ai/providers/register-builtins";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	CursorExecHandlers,
	Model,
	ToolResultMessage,
} from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import {
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	GrepArgsSchema,
	GrepContentMatchSchema,
	GrepContentResultSchema,
	GrepFileMatchSchema,
	GrepResultSchema,
	GrepSuccessSchema,
	GrepUnionResultSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";

afterEach(() => {
	setCursorProviderModule();
});

function frameConnect(payload: Uint8Array): Buffer {
	const header = Buffer.alloc(5);
	header.writeUInt8(0, 0);
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, Buffer.from(payload)]);
}

function grepToolResult(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-grep-1",
		toolName: "grep",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

const testCursorModel = (baseUrl: string): Model<"cursor-agent"> =>
	buildModel({
		id: "cursor-composer-2.5",
		name: "Cursor Composer 2.5",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});

interface MockServer {
	baseUrl: string;
	close: () => Promise<void>;
}

function startMockCursorH2Server(onStream: (stream: http2.ServerHttp2Stream) => void): Promise<MockServer> {
	const server = http2.createServer();
	server.on("stream", onStream);

	const { promise, resolve } = Promise.withResolvers<MockServer>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const closed = () => {
			const done = Promise.withResolvers<void>();
			server.close(() => done.resolve());
			return done.promise;
		};
		resolve({ baseUrl: `http://127.0.0.1:${port}`, close: closed });
	});
	return promise;
}

describe("Cursor Grep line number validation at tool-result boundary", () => {
	it("ignores timestamp-bearing lines from GrepContentMatch and serializes cleanly to binary", () => {
		const rawOutput = [
			"server.log:1753660800000: [INFO] timestamp line that should not be a line number",
			"src/main.ts:42: const answer = 42;",
			"src/main.ts:2147483647: const maxInt32Line = true;",
			"data.txt:0: invalid zero line number",
			"data.txt:9999999999999: overflowing int32 line number",
		].join("\n");

		const result = buildGrepResultFromToolResult(
			{ pattern: "test", outputMode: "content" },
			grepToolResult(rawOutput),
		);

		expect(result.result.case).toBe("success");
		if (result.result.case !== "success") return;

		const union = result.result.value.workspaceResults["."];
		expect(union).toBeDefined();
		expect(union?.result.case).toBe("content");
		if (union?.result.case !== "content") return;

		const matches = union.result.value.matches;
		expect(matches).toHaveLength(1);
		const fileMatch = matches[0];
		expect(fileMatch?.file).toBe("src/main.ts");
		expect(fileMatch?.matches).toHaveLength(2);
		expect(fileMatch?.matches[0]?.lineNumber).toBe(42);
		expect(fileMatch?.matches[1]?.lineNumber).toBe(2147483647);

		// Must serialize to binary without throwing int32 encoding error
		const bytes = toBinary(GrepResultSchema, result);
		expect(bytes.length).toBeGreaterThan(0);
	});

	it("validates count mode numeric bounds and serializes cleanly", () => {
		const rawOutput = [
			"src/a.ts:5",
			"src/b.ts:0",
			"src/c.ts:1753660800000", // Out of int32 range -> rejected
			"src/d.ts:invalid",
		].join("\n");

		const result = buildGrepResultFromToolResult({ pattern: "test", outputMode: "count" }, grepToolResult(rawOutput));

		expect(result.result.case).toBe("success");
		if (result.result.case !== "success") return;

		const union = result.result.value.workspaceResults["."];
		expect(union?.result.case).toBe("count");
		if (union?.result.case !== "count") return;

		expect(union.result.value.counts).toHaveLength(2);
		expect(union.result.value.totalFiles).toBe(2);
		expect(union.result.value.totalMatches).toBe(5);

		const bytes = toBinary(GrepResultSchema, result);
		expect(bytes.length).toBeGreaterThan(0);
	});
});

describe("Cursor exec server message handler failure closes turn immediately", () => {
	it("fails the turn immediately when exec handler throws instead of hanging for watchdog", async () => {
		const server = await startMockCursorH2Server((serverStream: http2.ServerHttp2Stream) => {
			serverStream.respond({ ":status": 200, "content-type": "application/connect+proto" });

			const execMsg = create(AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 1,
						execId: "exec-test-1",
						message: {
							case: "grepArgs",
							value: create(GrepArgsSchema, { pattern: "throw-test" }),
						},
					}),
				},
			});

			serverStream.write(frameConnect(toBinary(AgentServerMessageSchema, execMsg)));
			// Server intentionally leaves stream open waiting for client response
		});

		try {
			const execHandlers: CursorExecHandlers = {
				grep: async () => ({
					result: create(GrepResultSchema, {
						result: {
							case: "success",
							value: create(GrepSuccessSchema, {
								pattern: "p",
								path: "",
								outputMode: "content",
								workspaceResults: {
									".": create(GrepUnionResultSchema, {
										result: {
											case: "content",
											value: create(GrepContentResultSchema, {
												matches: [
													create(GrepFileMatchSchema, {
														file: "log.txt",
														matches: [
															create(GrepContentMatchSchema, {
																lineNumber: 1753660800000,
																content: "overflow",
																contentTruncated: false,
																isContextLine: false,
															}),
														],
													}),
												],
												totalLines: 1,
												totalMatchedLines: 1,
												clientTruncated: false,
												ripgrepTruncated: false,
											}),
										},
									}),
								},
							}),
						},
					}),
				}),
			};

			const context: Context = { messages: [{ role: "user", content: "grep something", timestamp: 1 }] };
			const stream = streamCursor(testCursorModel(server.baseUrl), context, {
				apiKey: "test-key",
				execHandlers,
			});
			const events: AssistantMessageEvent[] = [];
			let finalMessage: AssistantMessage | undefined;
			for await (const event of stream) {
				events.push(event);
				if (event.type === "done") finalMessage = event.message;
				if (event.type === "error") finalMessage = event.error;
			}
			expect(finalMessage).toBeDefined();
			expect(finalMessage?.stopReason).toBe("error");
			expect(finalMessage?.errorMessage).toContain("GrepContentMatch.line_number");
			expect(events.some(e => e.type === "error")).toBe(true);
		} finally {
			await server.close();
		}
	});

	it("processes timestamp-bearing grep output through full production stream path and completes cleanly", async () => {
		const server = await startMockCursorH2Server((serverStream: http2.ServerHttp2Stream) => {
			serverStream.respond({ ":status": 200, "content-type": "application/connect+proto" });

			const execMsg = create(AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 2,
						execId: "exec-grep-2",
						message: {
							case: "grepArgs",
							value: create(GrepArgsSchema, { pattern: "timestamp-search" }),
						},
					}),
				},
			});

			serverStream.write(frameConnect(toBinary(AgentServerMessageSchema, execMsg)));

			let ended = false;
			serverStream.on("data", (chunk: Buffer) => {
				if (chunk.length >= 5 && !ended) {
					ended = true;
					// Client answered grep exec request: end the stream cleanly
					const turnEndedMsg = create(AgentServerMessageSchema, {
						message: {
							case: "interactionUpdate",
							value: {
								message: {
									case: "turnEnded",
									value: {},
								},
							},
						},
					});
					serverStream.write(frameConnect(toBinary(AgentServerMessageSchema, turnEndedMsg)));
					serverStream.end();
				}
			});
		});

		try {
			const execHandlers: CursorExecHandlers = {
				grep: async () => ({
					role: "toolResult",
					toolCallId: "call-grep-2",
					toolName: "grep",
					content: [
						{
							type: "text",
							text: [
								"log.txt:1753660800000: [INFO] Timestamp match that previously caused overflow",
								"src/app.ts:10: const active = true;",
							].join("\n"),
						},
					],
					isError: false,
					timestamp: 1,
				}),
			};

			const context: Context = { messages: [{ role: "user", content: "run grep", timestamp: 1 }] };
			const stream = streamCursor(testCursorModel(server.baseUrl), context, {
				apiKey: "test-key",
				execHandlers,
			});
			let finalMessage: AssistantMessage | undefined;
			for await (const event of stream) {
				if (event.type === "done") finalMessage = event.message;
				if (event.type === "error") finalMessage = event.error;
			}
			expect(finalMessage).toBeDefined();
			expect(finalMessage?.stopReason).toBe("stop");
		} finally {
			await server.close();
		}
	});

	it("awaits in-flight exec handlers when turnEnded arrives concurrently and completes cleanly after handler resolves", async () => {
		const handlerGate = Promise.withResolvers<ToolResultMessage>();
		let serverReceivedClientResponse = false;

		const server = await startMockCursorH2Server((serverStream: http2.ServerHttp2Stream) => {
			serverStream.respond({ ":status": 200, "content-type": "application/connect+proto" });

			const execMsg = create(AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 3,
						execId: "exec-concurrent-1",
						message: {
							case: "grepArgs",
							value: create(GrepArgsSchema, { pattern: "concurrent-test" }),
						},
					}),
				},
			});

			const turnEndedMsg = create(AgentServerMessageSchema, {
				message: {
					case: "interactionUpdate",
					value: {
						message: {
							case: "turnEnded",
							value: {},
						},
					},
				},
			});

			// Send exec message followed immediately by turnEnded
			serverStream.write(frameConnect(toBinary(AgentServerMessageSchema, execMsg)));
			serverStream.write(frameConnect(toBinary(AgentServerMessageSchema, turnEndedMsg)));

			serverStream.on("data", (chunk: Buffer) => {
				if (chunk.length >= 5) {
					serverReceivedClientResponse = true;
					serverStream.end();
				}
			});
		});

		try {
			const execHandlers: CursorExecHandlers = {
				grep: async () => handlerGate.promise,
			};

			const context: Context = { messages: [{ role: "user", content: "concurrent test", timestamp: 1 }] };
			const stream = streamCursor(testCursorModel(server.baseUrl), context, {
				apiKey: "test-key",
				execHandlers,
			});

			const streamSettled = Promise.withResolvers<AssistantMessage>();
			(async () => {
				try {
					for await (const event of stream) {
						if (event.type === "done") streamSettled.resolve(event.message);
						if (event.type === "error") streamSettled.reject(event.error);
					}
				} catch (err) {
					streamSettled.reject(err);
				}
			})();

			// Microtask tick: ensure initial frames are delivered
			await Promise.resolve();
			expect(serverReceivedClientResponse).toBe(false);

			// Now resolve the in-flight handler
			handlerGate.resolve({
				role: "toolResult",
				toolCallId: "call-concurrent-1",
				toolName: "grep",
				content: [{ type: "text", text: "src/main.ts:1: found" }],
				isError: false,
				timestamp: 1,
			});

			const finalMessage = await streamSettled.promise;
			expect(finalMessage).toBeDefined();
			expect(finalMessage.stopReason).toBe("stop");
			expect(serverReceivedClientResponse).toBe(true);
		} finally {
			await server.close();
		}
	});

	it("fails the turn and rejects false success when in-flight exec handler throws after turnEnded has arrived", async () => {
		const handlerGate = Promise.withResolvers<any>();

		const server = await startMockCursorH2Server((serverStream: http2.ServerHttp2Stream) => {
			serverStream.respond({ ":status": 200, "content-type": "application/connect+proto" });

			const execMsg = create(AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 4,
						execId: "exec-concurrent-fail",
						message: {
							case: "grepArgs",
							value: create(GrepArgsSchema, { pattern: "concurrent-fail-test" }),
						},
					}),
				},
			});

			const turnEndedMsg = create(AgentServerMessageSchema, {
				message: {
					case: "interactionUpdate",
					value: {
						message: {
							case: "turnEnded",
							value: {},
						},
					},
				},
			});

			// Send exec message followed immediately by turnEnded
			serverStream.write(frameConnect(toBinary(AgentServerMessageSchema, execMsg)));
			serverStream.write(frameConnect(toBinary(AgentServerMessageSchema, turnEndedMsg)));
		});

		try {
			const execHandlers: CursorExecHandlers = {
				grep: async () => handlerGate.promise,
			};

			const context: Context = { messages: [{ role: "user", content: "concurrent fail", timestamp: 1 }] };
			const stream = streamCursor(testCursorModel(server.baseUrl), context, {
				apiKey: "test-key",
				execHandlers,
			});

			const streamResultPromise = Promise.withResolvers<AssistantMessage>();
			(async () => {
				for await (const event of stream) {
					if (event.type === "done") streamResultPromise.resolve(event.message);
					if (event.type === "error") streamResultPromise.resolve(event.error);
				}
			})();

			// Microtask tick
			await Promise.resolve();

			// Resolve with an un-serializable int32 value that throws in toBinary during sendExecClientMessage
			handlerGate.resolve({
				result: create(GrepResultSchema, {
					result: {
						case: "success",
						value: create(GrepSuccessSchema, {
							pattern: "p",
							path: "",
							outputMode: "content",
							workspaceResults: {
								".": create(GrepUnionResultSchema, {
									result: {
										case: "content",
										value: create(GrepContentResultSchema, {
											matches: [
												create(GrepFileMatchSchema, {
													file: "log.txt",
													matches: [
														create(GrepContentMatchSchema, {
															lineNumber: 1753660800000,
															content: "overflow",
															contentTruncated: false,
															isContextLine: false,
														}),
													],
												}),
											],
											totalLines: 1,
											totalMatchedLines: 1,
											clientTruncated: false,
											ripgrepTruncated: false,
										}),
									},
								}),
							},
						}),
					},
				}),
			});

			const finalMessage = await streamResultPromise.promise;
			expect(finalMessage).toBeDefined();
			expect(finalMessage.stopReason).toBe("error");
			expect(finalMessage.errorMessage).toContain("GrepContentMatch.line_number");
		} finally {
			await server.close();
		}
	});

	it("propagates real HTTP/2 gRPC trailer status 8 (resource_exhausted) as CursorApiError 429", async () => {
		const server = await startMockCursorH2Server((serverStream: http2.ServerHttp2Stream) => {
			serverStream.respond(
				{ ":status": 200, "content-type": "application/connect+proto" },
				{ waitForTrailers: true },
			);
			serverStream.on("wantTrailers", () => {
				serverStream.sendTrailers({
					"grpc-status": "8",
					"grpc-message": encodeURIComponent("Resource exhausted: monthly quota exceeded"),
				});
			});
			serverStream.end();
		});

		try {
			const context: Context = { messages: [{ role: "user", content: "test", timestamp: 1 }] };
			const stream = streamCursor(testCursorModel(server.baseUrl), context, { apiKey: "test-key" });
			let finalMessage: AssistantMessage | undefined;
			for await (const event of stream) {
				if (event.type === "done") finalMessage = event.message;
				if (event.type === "error") finalMessage = event.error;
			}
			expect(finalMessage).toBeDefined();
			expect(finalMessage?.stopReason).toBe("error");
			expect(finalMessage?.errorStatus).toBe(429);
			expect(finalMessage?.errorMessage).toContain("Resource exhausted: monthly quota exceeded");
		} finally {
			await server.close();
		}
	});

	it("propagates real HTTP/2 gRPC trailer status 14 (unavailable) as CursorApiError 503", async () => {
		const server = await startMockCursorH2Server((serverStream: http2.ServerHttp2Stream) => {
			serverStream.respond(
				{ ":status": 200, "content-type": "application/connect+proto" },
				{ waitForTrailers: true },
			);
			serverStream.on("wantTrailers", () => {
				serverStream.sendTrailers({
					"grpc-status": "14",
					"grpc-message": encodeURIComponent("Service temporarily unavailable"),
				});
			});
			serverStream.end();
		});

		try {
			const context: Context = { messages: [{ role: "user", content: "test", timestamp: 1 }] };
			const stream = streamCursor(testCursorModel(server.baseUrl), context, { apiKey: "test-key" });
			let finalMessage: AssistantMessage | undefined;
			for await (const event of stream) {
				if (event.type === "done") finalMessage = event.message;
				if (event.type === "error") finalMessage = event.error;
			}
			expect(finalMessage).toBeDefined();
			expect(finalMessage?.stopReason).toBe("error");
			expect(finalMessage?.errorStatus).toBe(503);
			expect(finalMessage?.errorMessage).toContain("Service temporarily unavailable");
		} finally {
			await server.close();
		}
	});

	it("ensures nonzero gRPC trailer status wins when received after turnEnded while an exec handler is pending", async () => {
		const handlerStarted = Promise.withResolvers<void>();
		const handlerGate = Promise.withResolvers<ToolResultMessage>();
		const serverStreamClosed = Promise.withResolvers<void>();

		const server = await startMockCursorH2Server((serverStream: http2.ServerHttp2Stream) => {
			serverStream.respond(
				{ ":status": 200, "content-type": "application/connect+proto" },
				{ waitForTrailers: true },
			);

			const execMsg = create(AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: 5,
						execId: "exec-trailer-race",
						message: {
							case: "grepArgs",
							value: create(GrepArgsSchema, { pattern: "trailer-race-test" }),
						},
					}),
				},
			});

			const turnEndedMsg = create(AgentServerMessageSchema, {
				message: {
					case: "interactionUpdate",
					value: {
						message: {
							case: "turnEnded",
							value: {},
						},
					},
				},
			});

			// Send exec message followed immediately by turnEnded
			serverStream.write(frameConnect(toBinary(AgentServerMessageSchema, execMsg)));
			serverStream.write(frameConnect(toBinary(AgentServerMessageSchema, turnEndedMsg)));

			serverStream.on("wantTrailers", () => {
				serverStream.sendTrailers({
					"grpc-status": "8",
					"grpc-message": encodeURIComponent("Resource exhausted: monthly limit exceeded"),
				});
			});

			serverStream.on("close", () => {
				serverStreamClosed.resolve();
			});

			// Once the handler starts, end stream to emit wantTrailers
			void handlerStarted.promise.then(() => {
				serverStream.end();
			});
		});

		try {
			const execHandlers: CursorExecHandlers = {
				grep: async () => {
					handlerStarted.resolve();
					return handlerGate.promise;
				},
			};

			const context: Context = { messages: [{ role: "user", content: "trailer race", timestamp: 1 }] };
			const stream = streamCursor(testCursorModel(server.baseUrl), context, {
				apiKey: "test-key",
				execHandlers,
			});

			const streamResultPromise = Promise.withResolvers<AssistantMessage>();
			(async () => {
				for await (const event of stream) {
					if (event.type === "done") streamResultPromise.resolve(event.message);
					if (event.type === "error") streamResultPromise.resolve(event.error);
				}
			})();

			// Wait until handler is running and server stream has closed with trailer status 8
			await handlerStarted.promise;
			await serverStreamClosed.promise;
			await Promise.resolve();
			handlerGate.resolve({
				role: "toolResult",
				toolCallId: "call-trailer-race-1",
				toolName: "grep",
				content: [{ type: "text", text: "src/main.ts:1: match" }],
				isError: false,
				timestamp: 1,
			});

			const finalMessage = await streamResultPromise.promise;
			expect(finalMessage).toBeDefined();
			// The trailer error MUST win over turnEnded
			expect(finalMessage.stopReason).toBe("error");
			expect(finalMessage.errorStatus).toBe(429);
			expect(finalMessage.errorMessage).toContain("Resource exhausted: monthly limit exceeded");
		} finally {
			await server.close();
		}
	});

	it("ensures nonzero gRPC trailer status wins when received immediately after turnEnded with no pending exec handlers", async () => {
		const server = await startMockCursorH2Server((serverStream: http2.ServerHttp2Stream) => {
			serverStream.respond(
				{ ":status": 200, "content-type": "application/connect+proto" },
				{ waitForTrailers: true },
			);

			const turnEndedMsg = create(AgentServerMessageSchema, {
				message: {
					case: "interactionUpdate",
					value: {
						message: {
							case: "turnEnded",
							value: {},
						},
					},
				},
			});

			// Send turnEnded and immediately end stream with status 8 in trailers
			serverStream.write(frameConnect(toBinary(AgentServerMessageSchema, turnEndedMsg)));

			serverStream.on("wantTrailers", () => {
				serverStream.sendTrailers({
					"grpc-status": "8",
					"grpc-message": encodeURIComponent("Resource exhausted: monthly limit exceeded"),
				});
			});
			serverStream.end();
		});

		try {
			const context: Context = { messages: [{ role: "user", content: "no handler trailer test", timestamp: 1 }] };
			const stream = streamCursor(testCursorModel(server.baseUrl), context, {
				apiKey: "test-key",
			});

			let finalMessage: AssistantMessage | undefined;
			for await (const event of stream) {
				if (event.type === "done") finalMessage = event.message;
				if (event.type === "error") finalMessage = event.error;
			}
			expect(finalMessage).toBeDefined();
			expect(finalMessage?.stopReason).toBe("error");
			expect(finalMessage?.errorStatus).toBe(429);
			expect(finalMessage?.errorMessage).toContain("Resource exhausted: monthly limit exceeded");
		} finally {
			await server.close();
		}
	});

	it("fails immediately on Connect frame exceeding MAX_CONNECT_FRAME_PAYLOAD without buffering or watchdog", async () => {
		const server = await startMockCursorH2Server((serverStream: http2.ServerHttp2Stream) => {
			serverStream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			// Send 5-byte header with oversized length (20 MiB)
			const header = Buffer.alloc(5);
			header.writeUInt8(0, 0);
			header.writeUInt32BE(20 * 1024 * 1024, 1);
			serverStream.write(header);
			// Deliberately do not send the 20 MiB of data
		});

		try {
			const context: Context = { messages: [{ role: "user", content: "oversized payload", timestamp: 1 }] };
			const stream = streamCursor(testCursorModel(server.baseUrl), context, { apiKey: "test-key" });
			let finalMessage: AssistantMessage | undefined;
			for await (const event of stream) {
				if (event.type === "done") finalMessage = event.message;
				if (event.type === "error") finalMessage = event.error;
			}
			expect(finalMessage).toBeDefined();
			expect(finalMessage?.stopReason).toBe("error");
			expect(finalMessage?.errorMessage).toContain("exceeds 16777216-byte cap");
		} finally {
			await server.close();
		}
	});

	it("safely handles malformed percent-encoding in gRPC trailers without crashing event handler", async () => {
		const server = await startMockCursorH2Server((serverStream: http2.ServerHttp2Stream) => {
			serverStream.respond(
				{ ":status": 200, "content-type": "application/connect+proto" },
				{ waitForTrailers: true },
			);
			serverStream.on("wantTrailers", () => {
				serverStream.sendTrailers({
					"grpc-status": "8",
					"grpc-message": "%ZZ_invalid_percent_encoding",
				});
			});
			serverStream.end();
		});

		try {
			const context: Context = { messages: [{ role: "user", content: "test", timestamp: 1 }] };
			const stream = streamCursor(testCursorModel(server.baseUrl), context, { apiKey: "test-key" });
			let finalMessage: AssistantMessage | undefined;
			for await (const event of stream) {
				if (event.type === "done") finalMessage = event.message;
				if (event.type === "error") finalMessage = event.error;
			}
			expect(finalMessage).toBeDefined();
			expect(finalMessage?.stopReason).toBe("error");
			expect(finalMessage?.errorStatus).toBe(429);
			expect(finalMessage?.errorMessage).toContain("%ZZ_invalid_percent_encoding");
		} finally {
			await server.close();
		}
	});

	it("terminates immediately when receiving a corrupt/unparseable protobuf frame", async () => {
		const server = await startMockCursorH2Server((serverStream: http2.ServerHttp2Stream) => {
			serverStream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			// Send invalid non-protobuf payload in a valid Connect frame
			const invalidPayload = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]);
			serverStream.write(frameConnect(invalidPayload));
		});

		try {
			const context: Context = { messages: [{ role: "user", content: "test", timestamp: 1 }] };
			const stream = streamCursor(testCursorModel(server.baseUrl), context, { apiKey: "test-key" });
			let finalMessage: AssistantMessage | undefined;
			for await (const event of stream) {
				if (event.type === "done") finalMessage = event.message;
				if (event.type === "error") finalMessage = event.error;
			}
			expect(finalMessage).toBeDefined();
			expect(finalMessage?.stopReason).toBe("error");
		} finally {
			await server.close();
		}
	});

	it("fails fast on pre-aborted signal without dispatching HTTP/2 connection", async () => {
		let serverHit = false;
		const server = await startMockCursorH2Server((serverStream: http2.ServerHttp2Stream) => {
			serverHit = true;
			serverStream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			serverStream.end();
		});

		try {
			const controller = new AbortController();
			controller.abort();
			const context: Context = { messages: [{ role: "user", content: "test", timestamp: 1 }] };
			const stream = streamCursor(testCursorModel(server.baseUrl), context, {
				apiKey: "test-key",
				signal: controller.signal,
			});
			let finalMessage: AssistantMessage | undefined;
			for await (const event of stream) {
				if (event.type === "done") finalMessage = event.message;
				if (event.type === "error") finalMessage = event.error;
			}
			expect(finalMessage).toBeDefined();
			expect(finalMessage?.stopReason).toBe("aborted");
			expect(serverHit).toBe(false);
		} finally {
			await server.close();
		}
	});
});
