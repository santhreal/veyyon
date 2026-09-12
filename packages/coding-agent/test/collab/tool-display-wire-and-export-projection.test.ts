/**
 * WHY:
 * Tool view consolidation replaces duplicate per-tool React interpretation with the canonical
 * ToolView / ToolExecutionDisplay projection. Collab wire frames, live session events, reconnect
 * replays, and HTML exports all receive pre-projected `ToolExecutionDisplay` view-models directly
 * from `projectToolDisplay` without requiring guest browsers or export viewers to import the
 * coding-agent tool registry or re-parse raw tool outputs.
 *
 * This test suite defends the following contracts:
 * 1. `projectToolDisplay` generates canonical `ToolExecutionDisplay` view-models with `expanded: true`
 *    semantics for standard tools (read, bash, edit, etc.) and falls back cleanly for unknown tools.
 * 2. Heavy base64 image data is omitted from `display.images` to keep wire frames light, while raw
 *    result content remains intact for raw inspection / full output.
 * 3. Generic raw text output is deduplicated from `display.generic.outputText` when raw result exists.
 * 4. Wire projections (`toWireAgentEvent`, `toWireSessionEntry`, `toWireMessage`) attach `display`
 *    to tool calls, tool results, and live execution events using tool call/result correlation maps.
 * 5. HTML export (`projectSessionEntriesForExport` and `exportFromFile`) projects tool displays
 *    across primary sessions and nested subagent sessions without mutating source session records.
 * 6. Secret redaction obfuscates secrets across BOTH raw message content and projected displays.
 * 7. Protocol version `COLLAB_PROTO = 4` is enforced at the hello handshake: stale peers (v3 and
 *    below) are rejected with a protocol-mismatch error and never admitted.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { ToolView } from "@veyyon/tool-render";
import { removeWithRetries } from "@veyyon/utils";
import { type AgentEvent, COLLAB_PROTO } from "@veyyon/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { importRoomKey } from "../../src/collab/crypto";
import { CollabHost } from "../../src/collab/host";
import { type CollabFrame, parseCollabLink, toWireAgentEvent, toWireSessionEntry } from "../../src/collab/protocol";
import { CollabSocket } from "../../src/collab/relay-client";
import { exportFromFile } from "../../src/export/html";
import type { InteractiveModeContext } from "../../src/modes/terminal/types";
import { buildToolExecutionBlock } from "../../src/presentation/tool-execution";
import {
	buildToolCorrelations,
	projectSessionEntriesForExport,
	projectToolDisplay,
	TOOL_CALL_BLOCK_TYPES,
} from "../../src/presentation/web-tool-display";
import { SecretObfuscator } from "../../src/secrets/obfuscator";
import type { AgentSessionEvent } from "../../src/session/agent-session-types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

type SessionListener = (event: AgentSessionEvent) => void;

function makeHostContext(listeners?: Set<SessionListener>): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: {
			requestRender: () => {},
		},
		sessionManager: {
			getSessionId: () => "sess-test",
			getCwd: () => "/workspace",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-test", timestamp: new Date().toISOString(), cwd: "/workspace" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: (listener: SessionListener) => {
				listeners?.add(listener);
				return () => {
					listeners?.delete(listener);
				};
			},
			emitNotice: () => {},
		},
	} as unknown as InteractiveModeContext;
}

describe("Tool Execution Display Wire and Export Projection", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-tool-display-test-"));
		installInMemoryRelay();
	});

	afterEach(async () => {
		uninstallInMemoryRelay();
		await removeWithRetries(tmpDir);
	});

	describe("projectToolDisplay canonical view projection", () => {
		it("projects write previews without serializing the discarded transcript input", () => {
			let serializations = 0;
			const source = "export const count = 1;";
			const args = {
				path: "src/example.ts",
				content: source,
				toJSON() {
					serializations++;
					return { path: this.path, content: this.content };
				},
			};
			const params = { toolName: "write", toolCallId: "write-preview", args, expanded: true };
			const display = projectToolDisplay(params);
			expect(serializations).toBe(0);
			expect(display.callView).toMatchObject({
				kind: "framedBlock",
				header: { title: "Write", description: "src/example.ts" },
				sections: [{ lines: [[{ text: source }]] }],
			});

			const block = buildToolExecutionBlock(params);
			expect(serializations).toBe(1);
			expect(block.id).toBe("tool:write-preview");
			expect(block.status).toBe("running");
			expect(JSON.parse(block.input ?? "")).toEqual({ path: "src/example.ts", content: source });
			expect(block.display?.callView).toEqual(display.callView);
		});

		it("projects read tool execution with file facts and readEntry display", () => {
			const display = projectToolDisplay({
				toolName: "read",
				toolCallId: "call-read-1",
				args: { path: "src/index.ts", offset: 1, limit: 10 },
				result: {
					content: "[src/index.ts#A1B2]\n1:export const API = 1;\n2:export const PORT = 8080;\n",
					isError: false,
				},
				isError: false,
				isPartial: false,
			});

			expect(display.toolLabel).toBe("read");
			expect(display.neverRan).toBe(false);
			expect(display.readEntry?.path).toBe("src/index.ts");
			expect(display.readEntry?.contentText).toContain("export const API = 1;");
		});

		it("projects bash tool execution with canonical label and valid state", () => {
			const display = projectToolDisplay({
				toolName: "bash",
				toolCallId: "call-bash-1",
				args: { command: "echo 'hello world'" },
				result: {
					content: "hello world\n",
					isError: false,
				},
				isError: false,
				isPartial: false,
			});

			expect(display.toolLabel).toBe("bash");
			expect(display.neverRan).toBe(false);
		});

		it("strips heavy base64 image data from display while preserving mimeType", () => {
			const rawImageContent = [
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				},
			];

			const display = projectToolDisplay({
				toolName: "browser",
				toolCallId: "call-browser-img-1",
				args: { action: "run", code: "await tab.screenshot()" },
				result: {
					content: rawImageContent,
					isError: false,
				},
				isError: false,
				isPartial: false,
			});

			expect(display.images).toBeDefined();
			expect(display.images?.length).toBe(1);
			expect(display.images?.[0].mimeType).toBe("image/png");
			// Crucial contract: base64 data is not duplicated in display.images to keep wire frames small
			expect(display.images?.[0]).toBeDefined();
			expect(display.images?.[0]).not.toHaveProperty("data");
		});

		it("deduplicates generic outputText when raw result is present", () => {
			const display = projectToolDisplay({
				toolName: "custom_unknown_tool",
				toolCallId: "call-custom-1",
				args: { param: "value" },
				result: {
					content: "custom output response",
					isError: false,
				},
				isError: false,
				isPartial: false,
			});

			expect(display.toolLabel).toBe("custom_unknown_tool");
			expect(display.neverRan).toBe(false);
			// Generic outputText is stripped when result is present to avoid duplicate transmission
			expect(display.generic?.outputText).toBeUndefined();
		});

		it("sets neverRan to true and records reason for unexecuted tool calls", () => {
			const display = projectToolDisplay({
				toolName: "write",
				toolCallId: "call-write-skipped",
				args: { path: "test.txt", content: "hello" },
				result: {
					details: {
						__synthetic: true,
						executed: false,
						source: "assistant_stop_aborted",
					},
				},
				sealed: true,
			});

			expect(display.neverRan).toBe(true);
			expect(display.notExecutedReason).toContain("interrupted before this call ran");
		});
	});

	describe("Wire event and entry projections with tool correlations", () => {
		it("projects live tool_execution_start, update, and end events with canonical display", () => {
			const startEvent: AgentEvent | undefined = toWireAgentEvent({
				type: "tool_execution_start",
				toolCallId: "call-live-1",
				toolName: "read",
				args: { path: "package.json" },
				intent: "Inspect dependencies",
			});
			expect(startEvent).toMatchObject({
				type: "tool_execution_start",
				toolName: "read",
				intent: "Inspect dependencies",
				display: { readEntry: { path: "package.json" } },
			});

			const updateEvent: AgentEvent | undefined = toWireAgentEvent({
				type: "tool_execution_update",
				toolCallId: "call-live-1",
				toolName: "read",
				args: { path: "package.json" },
				partialResult: {
					content: [{ type: "text", text: '{\n  "name": "app"\n}' }],
				},
			});

			expect(updateEvent).toMatchObject({
				type: "tool_execution_update",
				toolName: "read",
				partialResult: {
					content: [{ type: "text", text: '{\n  "name": "app"\n}' }],
				},
				display: expect.anything(),
			});

			const toolCallMap = new Map([
				["call-live-1", { toolName: "read", args: { path: "package.json" }, intent: "Inspect dependencies" }],
			]);

			const endEvent: AgentEvent | undefined = toWireAgentEvent(
				{
					type: "tool_execution_end",
					toolCallId: "call-live-1",
					toolName: "read",
					result: {
						content: [{ type: "text", text: '[package.json#B2C3]\n1:{\n2:  "name": "app"\n3:}\n' }],
						isError: false,
					},
					isError: false,
				},
				toolCallMap,
			);

			expect(endEvent).toMatchObject({
				type: "tool_execution_end",
				toolName: "read",
				display: { readEntry: { path: "package.json" } },
			});
		});

		it("projects tool_execution_update with structured partialResult object carrying content and details", () => {
			const updateEvent: AgentEvent | undefined = toWireAgentEvent({
				type: "tool_execution_update",
				toolCallId: "call-struct-1",
				toolName: "read",
				args: { path: "src/types.ts" },
				partialResult: {
					content: [{ type: "text", text: "[src/types.ts#1111]\n1:export type ID = string;\n" }],
					details: { path: "src/types.ts", totalLines: 1 },
				},
			});

			expect(updateEvent).toMatchObject({
				type: "tool_execution_update",
				toolName: "read",
				display: {
					readEntry: {
						path: "src/types.ts",
						status: "pending",
					},
				},
				partialResult: {
					content: [{ type: "text", text: "[src/types.ts#1111]\n1:export type ID = string;\n" }],
					details: { path: "src/types.ts", totalLines: 1 },
				},
			});
		});

		it("correlates assistant toolCall blocks and toolResult entries in toWireSessionEntry", () => {
			const toolCallsMap = new Map([
				["tc-1", { toolName: "read", args: { path: "src/app.ts" }, intent: "Read app" }],
			]);
			const toolResultsMap = new Map([
				[
					"tc-1",
					{
						content: [{ type: "text", text: "[src/app.ts#1234]\n1:console.log('hi');\n" }],
						details: undefined,
						isError: false,
					},
				],
			]);

			const assistantEntry: SessionEntry = {
				type: "message",
				id: "msg-assistant-1",
				parentId: null,
				timestamp: "2026-08-05T00:00:00.000Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "tc-1",
							name: "read",
							arguments: { path: "src/app.ts" },
							intent: "Read app",
						},
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3-5-sonnet",
					usage: {
						input: 10,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 30,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
					},
					stopReason: "toolUse",
					timestamp: 1000,
				},
			};

			const wireAssistant = toWireSessionEntry(assistantEntry, toolCallsMap, toolResultsMap);
			expect(wireAssistant).toMatchObject({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							display: { readEntry: { path: "src/app.ts" } },
						},
					],
				},
			});

			const toolResultEntry: SessionEntry = {
				type: "message",
				id: "msg-result-1",
				parentId: "msg-assistant-1",
				timestamp: "2026-08-05T00:00:01.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tc-1",
					toolName: "read",
					content: [{ type: "text", text: "[src/app.ts#1234]\n1:console.log('hi');\n" }],
					isError: false,
					timestamp: 1000,
				},
			};

			const wireResult = toWireSessionEntry(toolResultEntry, toolCallsMap, toolResultsMap);
			expect(wireResult).toMatchObject({
				type: "message",
				message: {
					role: "toolResult",
					display: { readEntry: { path: "src/app.ts" } },
					content: [{ type: "text", text: "[src/app.ts#1234]\n1:console.log('hi');\n" }],
				},
			});
		});
	});

	describe("HTML export session projection", () => {
		it("projects main and subagent session entries without mutating source records", async () => {
			const sourceEntries: SessionEntry[] = [
				{
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-08-05T00:00:01.000Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc-export-1",
								name: "read",
								arguments: { path: "README.md" },
							},
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-3-5-sonnet",
						usage: {
							input: 10,
							output: 20,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 30,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
						},
						stopReason: "toolUse",
						timestamp: 1000,
					},
				},
				{
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2026-08-05T00:00:02.000Z",
					message: {
						role: "toolResult",
						toolCallId: "tc-export-1",
						toolName: "read",
						content: [{ type: "text", text: "[README.md#0001]\n1:# Project Title\n" }],
						isError: false,
						timestamp: 2000,
					},
				},
			];

			const projected = projectSessionEntriesForExport(sourceEntries);

			// Source records must NOT be mutated
			const origAssistant = sourceEntries[0];
			if (!origAssistant || origAssistant.type !== "message" || origAssistant.message.role !== "assistant") {
				throw new Error("Expected assistant source entry");
			}
			const origToolCall = origAssistant.message.content[0];
			expect(origToolCall).not.toHaveProperty("display");

			// Projected records MUST carry display
			const projAssistant = projected[0];
			expect(projAssistant).toMatchObject({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							display: expect.anything(),
						},
					],
				},
			});

			const projResult = projected[1];
			expect(projResult).toMatchObject({
				type: "message",
				message: {
					role: "toolResult",
					display: { readEntry: { path: "README.md" } },
					content: [{ type: "text", text: "[README.md#0001]\n1:# Project Title\n" }],
				},
			});
		});

		it("exports self-contained HTML file embedding projected tool displays", async () => {
			const sessionFile = path.join(tmpDir, "main.jsonl");
			const sessionLines = [
				JSON.stringify({
					type: "session",
					version: 3,
					id: "main-session",
					timestamp: "2026-08-05T00:00:00.000Z",
					cwd: "/workspace",
				}),
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2026-08-05T00:00:01.000Z",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc-exp-file",
								name: "read",
								arguments: { path: "src/main.ts" },
							},
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-3-5-sonnet",
						usage: {
							input: 10,
							output: 20,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 30,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
						},
						stopReason: "toolUse",
						timestamp: 1000,
					},
				}),
				JSON.stringify({
					type: "message",
					id: "msg-2",
					parentId: "msg-1",
					timestamp: "2026-08-05T00:00:02.000Z",
					message: {
						role: "toolResult",
						toolCallId: "tc-exp-file",
						toolName: "read",
						content: "[src/main.ts#1111]\n1:console.log('exported');\n",
					},
				}),
			].join("\n");

			await fs.writeFile(sessionFile, `${sessionLines}\n`, "utf8");

			const outputPath = path.join(tmpDir, "export.html");
			await exportFromFile(sessionFile, { outputPath });

			const htmlContent = await fs.readFile(outputPath, "utf8");
			expect(htmlContent).toContain("<!DOCTYPE html>");
			expect(htmlContent).toContain("session-data");

			const match = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(htmlContent);
			expect(match).not.toBeNull();
			if (!match) throw new Error("session-data script tag missing");
			const decodedJson = Buffer.from(match[1], "base64").toString("utf8");
			const snapshot = JSON.parse(decodedJson);
			expect(snapshot.entries).toBeDefined();
			expect(snapshot.entries.length).toBeGreaterThanOrEqual(1);

			const firstMsg = snapshot.entries[0].message;
			expect(firstMsg).toMatchObject({
				role: "assistant",
				content: [
					{
						display: {
							readEntry: { path: "src/main.ts" },
						},
					},
				],
			});
		});
	});

	describe("Secret redaction across projected displays and raw contents", () => {
		it("redacts configured secret in both raw toolResult content and projected display", async () => {
			const SECRET = "super-secret-api-key-998877";
			const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
			const placeholder = obfuscator.obfuscate(SECRET);

			const sessionFile = path.join(tmpDir, "redact-session.jsonl");
			const sessionLines = [
				JSON.stringify({
					type: "session",
					version: 3,
					id: "redact-main",
					timestamp: "2026-08-05T00:00:00.000Z",
					cwd: "/workspace",
				}),
				JSON.stringify({
					type: "message",
					id: "r1",
					parentId: null,
					timestamp: "2026-08-05T00:00:01.000Z",
					message: {
						role: "toolResult",
						toolCallId: "tc-sec-1",
						toolName: "read",
						content: `[env#0001]\n1:SECRET_TOKEN=${SECRET}\n`,
					},
				}),
			].join("\n");

			await fs.writeFile(sessionFile, `${sessionLines}\n`, "utf8");

			const outputPath = path.join(tmpDir, "redacted-export.html");
			await exportFromFile(sessionFile, { outputPath, obfuscator });

			const htmlContent = await fs.readFile(outputPath, "utf8");
			expect(htmlContent).not.toContain(SECRET);

			const match = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(htmlContent);
			expect(match).not.toBeNull();
			if (!match) throw new Error("session-data script tag missing");
			const decoded = Buffer.from(match[1], "base64").toString("utf8");
			expect(decoded).not.toContain(SECRET);
			expect(decoded).toContain(placeholder);

			const parsed = JSON.parse(decoded);
			const msg = parsed.entries[0].message;
			expect(msg.content).toContain(placeholder);
			expect(JSON.stringify(msg.display)).toContain(placeholder);
			expect(JSON.stringify(msg.display)).not.toContain(SECRET);
		});
	});

	describe("Collab protocol handshake and stale peer rejection", () => {
		async function joinRawGuest(
			link: string,
			proto = COLLAB_PROTO,
			includeSnapshot = false,
		): Promise<{ socket: CollabSocket; nextFrame(): Promise<CollabFrame> }> {
			const parsed = parseCollabLink(link);
			if ("error" in parsed) throw new Error(parsed.error);
			const key = await importRoomKey(parsed.key);
			const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
			const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
			const queue: CollabFrame[] = [];
			const waiters: ((frame: CollabFrame) => void)[] = [];
			const filtered: Record<string, boolean> = {
				state: true,
				agents: true,
				entry: true,
				event: true,
				bus: true,
				"snapshot-chunk": !includeSnapshot,
			};
			socket.onFrame = frame => {
				if (filtered[frame.t]) return;
				const waiter = waiters.shift();
				if (waiter) waiter(frame);
				else queue.push(frame);
			};
			socket.onOpen = () => socket.send({ t: "hello", proto, name: `guest-v${proto}`, writeToken });
			socket.connect();
			const nextFrame = (): Promise<CollabFrame> => {
				const queued = queue.shift();
				if (queued) return Promise.resolve(queued);
				const { promise, resolve } = Promise.withResolvers<CollabFrame>();
				waiters.push(resolve);
				return promise;
			};
			return { socket, nextFrame };
		}

		it.each([...TOOL_CALL_BLOCK_TYPES])(
			"replays live result content and details for %s blocks on reconnect",
			async blockType => {
				const listeners = new Set<SessionListener>();
				const ctx = makeHostContext(listeners);
				const snapshot = ctx.sessionManager.snapshotForReplication();
				// Legacy persisted discriminators precede the current SessionEntry type.
				const entry = {
					type: "message",
					id: "assistant-read",
					parentId: null,
					timestamp: "2026-01-01T00:00:00Z",
					message: {
						role: "assistant",
						content: [{ type: blockType, id: "live-read", name: "read", arguments: { path: "src/source.ts" } }],
						api: "anthropic-messages",
						provider: "example",
						model: "example",
						stopReason: "toolUse",
						timestamp: 0,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				} as unknown as SessionEntry;
				ctx.sessionManager.snapshotForReplication = () => ({ ...snapshot, entries: [entry] });
				const host = new CollabHost(ctx);
				let socket: CollabSocket | undefined;
				try {
					await host.start("ws://localhost:8787");
					const events: AgentSessionEvent[] = [
						{
							type: "tool_execution_start",
							toolCallId: "live-read",
							toolName: "read",
							args: { path: "src/source.ts" },
						},
						{
							type: "tool_execution_end",
							toolCallId: "live-read",
							toolName: "read",
							isError: false,
							result: {
								content: [
									{ type: "text", text: "first" },
									{ type: "text", text: "last" },
								],
								details: { resolvedPath: "src/resolved.ts", conflictCount: 2 },
							},
						},
					];
					for (const event of events) for (const listener of listeners) listener(event);
					const guest = await joinRawGuest(host.link, COLLAB_PROTO, true);
					socket = guest.socket;
					expect((await guest.nextFrame()).t).toBe("welcome");
					const chunk = await guest.nextFrame();
					expect(chunk).toMatchObject({
						t: "snapshot-chunk",
						final: true,
						entries: [
							{
								type: "message",
								message: {
									role: "assistant",
									content: [
										{
											type: blockType,
											id: "live-read",
											display: {
												readEntry: {
													path: "src/source.ts",
													contentText: "first\nlast",
													linkPath: "src/resolved.ts",
													conflictCount: 2,
													status: "success",
												},
											},
										},
									],
								},
							},
						],
					});
					const exported = projectSessionEntriesForExport([entry]);
					const calls = buildToolCorrelations([entry]).toolCalls;
					expect(calls.get("live-read")?.args).toEqual({ path: "src/source.ts" });
					expect(exported[0]).toMatchObject({
						message: {
							content: [
								{
									type: blockType,
									display: { readEntry: { path: "src/source.ts" } },
								},
							],
						},
					});
				} finally {
					socket?.close();
					await host.stop("test done");
				}
			},
			5000,
		);

		it("rejects guest hello with stale COLLAB_PROTO <= 3 with protocol mismatch notice", async () => {
			const host = new CollabHost(makeHostContext());
			await host.start("ws://localhost:8787");
			const guest = await joinRawGuest(host.link, COLLAB_PROTO - 1);
			try {
				const reply = await guest.nextFrame();
				expect(reply).toMatchObject({
					t: "error",
					message: expect.stringContaining("protocol mismatch"),
				});
			} finally {
				guest.socket.close();
				await host.stop("test done");
			}
		});

		it("admits guest hello with current COLLAB_PROTO = 4", async () => {
			expect(COLLAB_PROTO).toBe(4);
			const host = new CollabHost(makeHostContext());
			await host.start("ws://localhost:8787");
			const guest = await joinRawGuest(host.link, COLLAB_PROTO);
			try {
				const welcome = await guest.nextFrame();
				expect(welcome).toMatchObject({
					t: "welcome",
					proto: 4,
				});
			} finally {
				guest.socket.close();
				await host.stop("test done");
			}
		});
	});
});

it("renders producer-projected tool display with browser header and body chrome", () => {
	const args = { command: "bun test" };
	const result = {
		content: [{ type: "text", text: "12 pass, 0 fail" }],
		details: { exitCode: 0, wallTimeMs: 450 },
	};
	const display = projectToolDisplay({ toolName: "bash", args, result });
	const html = renderToStaticMarkup(
		createElement(ToolView, { name: "bash", args, result, display, defaultOpen: true }),
	);
	expect(html).toContain("tv-card");
	expect(html).toContain("bun test");
	expect(html).toContain("tv-name");
	expect(html).toContain("tv-sum");
	expect(html).toContain("tv-body");
	expect(html).toContain("12 pass, 0 fail");
});
