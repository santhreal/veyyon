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
import {
	buildGrepResultFromToolResult,
	streamCursor,
} from "@veyyon/ai/providers/cursor";
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

function startMockCursorH2Server(
	onStream: (stream: http2.ServerHttp2Stream) => void,
): Promise<MockServer> {
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

		const result = buildGrepResultFromToolResult(
			{ pattern: "test", outputMode: "count" },
			grepToolResult(rawOutput),
		);

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
					execResult: create(GrepResultSchema, {
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
					toolResult: {
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
					},
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
});

