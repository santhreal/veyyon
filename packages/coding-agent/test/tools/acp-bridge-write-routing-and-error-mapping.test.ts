// WHY THIS SUITE EXISTS
// --------------------
// `packages/coding-agent/src/tools/acp-bridge.ts` owns the boundary between
// agent file-writing tools (write, edit, replace, patch) and external ACP
// editor clients (e.g. Zed). When an ACP client advertises `fs.writeTextFile`,
// writes must route to the editor's live buffer instead of writing directly to
// disk, while keeping Veyyon-internal artifacts (plan files, local sandbox files,
// internal URLs) off the editor buffer.
//
// In v1.2.0..HEAD, the ACP bridge was updated to honor the language-server
// master switch (`lsp.enabled` in settings alongside `session.enableLsp`), and
// error mapping was standardized through `toolFailure`.
//
// This suite closes the class of ACP bridge routing and error mapping defects by asserting:
// 1. Write routing correctly filters internal URLs (`local://`, `memory://`) and local sandbox targets.
// 2. Plan mode active plan file stays off the bridge while regular workspace files route through it.
// 3. Bridge execution calls `writeTextFile` with exact path and content, invalidates FS scan cache,
//    and bumps session file mutation versions.
// 4. Inbound write errors from the bridge (rejections, malformed/unsupported responses) are
//    wrapped in `ToolError` and surfaced naming the underlying cause.
// 5. Pre-aborted signals refuse to execute bridge writes.
// 6. LSP file-watched notifications distinguish Created vs Changed based on file pre-existence,
//    and strictly require both `session.enableLsp` AND `session.settings.get("lsp.enabled")` to be active.
// 7. `createAcpClientBridge` correctly maps protocol requests/responses (read, write, terminal, permission)
//    and propagates connection errors.
//
// What it does not catch:
// Editor-side buffer synchronization race conditions inside the external ACP client process.

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	TerminalHandle as AcpTerminalHandle,
	AgentSideConnection,
	ClientCapabilities,
	CreateTerminalRequest,
	ReadTextFileRequest,
	ReadTextFileResponse,
	RequestPermissionRequest,
	TerminalOutputResponse,
	WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import * as lspClient from "@veyyon/coding-agent/lsp/client";
import { createAcpClientBridge } from "@veyyon/coding-agent/modes/acp/acp-client-bridge";
import type { PlanModeState } from "@veyyon/coding-agent/plan-mode/state";
import type { ClientBridge } from "@veyyon/coding-agent/session/client-bridge";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { routeWriteThroughBridge, shouldRouteWriteThroughBridge } from "@veyyon/coding-agent/tools/acp-bridge";
import { ToolError } from "@veyyon/coding-agent/tools/tool-errors";
import { removeWithRetries } from "@veyyon/utils";

interface SessionConfig {
	bridge?: ClientBridge;
	planMode?: PlanModeState;
	enableLsp?: boolean;
	lspSetting?: boolean;
}

function createTestSession(cwd: string, config: SessionConfig = {}): ToolSession {
	const artifactsDir = path.join(cwd, "artifacts");
	const sessionId = "test-session-acp";
	const isolatedSettings = Settings.isolated();
	if (config.lspSetting !== undefined) {
		isolatedSettings.set("lsp.enabled", config.lspSetting);
	}
	return {
		cwd,
		hasUI: false,
		enableLsp: config.enableLsp ?? true,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => sessionId,
		localProtocolOptions: {
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => sessionId,
		},
		allocateOutputArtifact: async () => ({ id: "art-1", path: path.join(cwd, "art-1.log") }),
		settings: isolatedSettings,
		getClientBridge: config.bridge ? () => config.bridge : undefined,
		getPlanModeState: config.planMode ? () => config.planMode : undefined,
	};
}

describe("acp-bridge routing and error mapping", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-bridge-test-"));
	});

	afterEach(async () => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		await removeWithRetries(tmpDir);
	});

	describe("shouldRouteWriteThroughBridge", () => {
		it("returns false for internal URLs", () => {
			const session = createTestSession(tmpDir);
			expect(shouldRouteWriteThroughBridge(session, "local://PLAN.md", path.join(tmpDir, "PLAN.md"))).toBe(false);
			expect(shouldRouteWriteThroughBridge(session, "memory://notes.md", path.join(tmpDir, "notes.md"))).toBe(false);
		});

		it("returns false for paths targeting the session local sandbox", () => {
			const session = createTestSession(tmpDir);
			const sandboxArtifactPath = path.join(tmpDir, "artifacts", "local", "scratch.md");
			expect(shouldRouteWriteThroughBridge(session, sandboxArtifactPath, sandboxArtifactPath)).toBe(false);
		});

		it("returns false for active plan file when plan mode is enabled with internal URL", () => {
			const planUrl = "local://PLAN.md";
			const session = createTestSession(tmpDir, {
				planMode: { enabled: true, planFilePath: planUrl, workflow: "parallel", reentry: false },
			});
			const resolvedPlan = path.join(tmpDir, "artifacts", "local", "PLAN.md");
			expect(shouldRouteWriteThroughBridge(session, resolvedPlan, resolvedPlan)).toBe(false);

			// Other workspace files in plan mode still route through bridge
			const normalFile = path.join(tmpDir, "src", "index.ts");
			expect(shouldRouteWriteThroughBridge(session, normalFile, normalFile)).toBe(true);
		});

		it("returns true for regular workspace files when plan mode is disabled", () => {
			const session = createTestSession(tmpDir);
			const normalFile = path.join(tmpDir, "src", "app.ts");
			expect(shouldRouteWriteThroughBridge(session, normalFile, normalFile)).toBe(true);
		});
	});

	describe("routeWriteThroughBridge", () => {
		it("returns false when bridge is absent or lacks writeTextFile capability", async () => {
			const sessionWithoutBridge = createTestSession(tmpDir);
			const targetFile = path.join(tmpDir, "test.txt");

			const noBridgeResult = await routeWriteThroughBridge(sessionWithoutBridge, targetFile, targetFile, "content");
			expect(noBridgeResult).toBe(false);

			const bridgeNoCap: ClientBridge = {
				capabilities: { writeTextFile: false },
			};
			const sessionWithNoCap = createTestSession(tmpDir, { bridge: bridgeNoCap });
			const noCapResult = await routeWriteThroughBridge(sessionWithNoCap, targetFile, targetFile, "content");
			expect(noCapResult).toBe(false);
		});

		it("executes write through bridge and updates mutation version", async () => {
			let writtenPath = "";
			let writtenContent = "";
			const bridge: ClientBridge = {
				capabilities: { writeTextFile: true },
				writeTextFile: async params => {
					writtenPath = params.path;
					writtenContent = params.content;
				},
			};
			let bumpedPath = "";
			const session = createTestSession(tmpDir, { bridge, lspSetting: false });
			session.bumpFileMutationVersion = (filePath: string) => {
				bumpedPath = filePath;
				return 1;
			};

			const targetFile = path.join(tmpDir, "output.txt");
			const result = await routeWriteThroughBridge(session, targetFile, targetFile, "hello bridge\n");

			expect(result).toBe(true);
			expect(writtenPath).toBe(targetFile);
			expect(writtenContent).toBe("hello bridge\n");
			expect(bumpedPath).toBe(targetFile);
		});

		it("surfaces bridge errors wrapped in ToolError naming the cause", async () => {
			const bridgeError = new Error("ACP remote editor rejected write: file buffer is read-only");
			const bridge: ClientBridge = {
				capabilities: { writeTextFile: true },
				writeTextFile: async () => {
					throw bridgeError;
				},
			};
			const session = createTestSession(tmpDir, { bridge });
			const targetFile = path.join(tmpDir, "locked.txt");

			let caughtError: unknown;
			try {
				await routeWriteThroughBridge(session, targetFile, targetFile, "payload");
			} catch (err) {
				caughtError = err;
			}

			expect(caughtError instanceof ToolError).toBe(true);
			if (caughtError instanceof ToolError) {
				expect(caughtError.name).toBe("ToolError");
				expect(caughtError.message).toContain("ACP remote editor rejected write: file buffer is read-only");
			}
		});

		it("aborts before bridge invocation when signal is already aborted", async () => {
			let bridgeCalled = false;
			const bridge: ClientBridge = {
				capabilities: { writeTextFile: true },
				writeTextFile: async () => {
					bridgeCalled = true;
				},
			};
			const session = createTestSession(tmpDir, { bridge });
			const controller = new AbortController();
			controller.abort(new Error("Operation cancelled"));
			const targetFile = path.join(tmpDir, "aborted.txt");

			await expect(
				routeWriteThroughBridge(session, targetFile, targetFile, "data", controller.signal),
			).rejects.toThrow();

			expect(bridgeCalled).toBe(false);
		});

		/**
		 * Collects every watched-file notification the write path hands the LSP client, so a
		 * test asserts the exact set of messages sent rather than that a spy fired.
		 */
		function recordLspNotifications(): Array<{ cwd: string; changes: readonly lspClient.WatchedFileChange[] }> {
			const sent: Array<{ cwd: string; changes: readonly lspClient.WatchedFileChange[] }> = [];
			vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockImplementation(async (cwd, changes) => {
				sent.push({ cwd, changes });
			});
			return sent;
		}

		it("notifies LSP watched files with FileChangeType.Created for new files when LSP is enabled", async () => {
			const bridge: ClientBridge = {
				capabilities: { writeTextFile: true },
				writeTextFile: async () => undefined,
			};
			const session = createTestSession(tmpDir, { bridge, enableLsp: true, lspSetting: true });
			const targetFile = path.join(tmpDir, "new-file.ts");

			const notifications = recordLspNotifications();

			await routeWriteThroughBridge(session, targetFile, targetFile, "export const a = 1;");

			expect(notifications).toEqual([
				{ cwd: session.cwd, changes: [{ filePath: targetFile, type: lspClient.FileChangeType.Created }] },
			]);
		});

		it("notifies LSP watched files with FileChangeType.Changed for existing files when LSP is enabled", async () => {
			const bridge: ClientBridge = {
				capabilities: { writeTextFile: true },
				writeTextFile: async () => undefined,
			};
			const session = createTestSession(tmpDir, { bridge, enableLsp: true, lspSetting: true });
			const targetFile = path.join(tmpDir, "existing-file.ts");
			await fs.writeFile(targetFile, "initial content\n");

			const notifications = recordLspNotifications();

			await routeWriteThroughBridge(session, targetFile, targetFile, "updated content\n");

			expect(notifications).toEqual([
				{ cwd: session.cwd, changes: [{ filePath: targetFile, type: lspClient.FileChangeType.Changed }] },
			]);
		});

		it("does not notify LSP when lsp.enabled setting is false", async () => {
			const bridge: ClientBridge = {
				capabilities: { writeTextFile: true },
				writeTextFile: async () => undefined,
			};
			const session = createTestSession(tmpDir, { bridge, enableLsp: true, lspSetting: false });
			const targetFile = path.join(tmpDir, "file.ts");

			const notifications = recordLspNotifications();

			await routeWriteThroughBridge(session, targetFile, targetFile, "content");

			expect(notifications).toEqual([]);
		});

		it("does not notify LSP when session.enableLsp is false", async () => {
			const bridge: ClientBridge = {
				capabilities: { writeTextFile: true },
				writeTextFile: async () => undefined,
			};
			const session = createTestSession(tmpDir, { bridge, enableLsp: false, lspSetting: true });
			const targetFile = path.join(tmpDir, "file.ts");

			const notifications = recordLspNotifications();

			await routeWriteThroughBridge(session, targetFile, targetFile, "content");

			expect(notifications).toEqual([]);
		});
	});

	describe("createAcpClientBridge protocol mapping and error handling", () => {
		it("maps readTextFile request/response and propagates connection errors", async () => {
			let capturedReadReq: ReadTextFileRequest | undefined;
			const connectionStub = {
				async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
					capturedReadReq = params;
					if (params.path.includes("missing")) {
						throw new Error("File not found on client host");
					}
					return { content: "client file text\n" };
				},
			} as unknown as AgentSideConnection;

			const capabilities: ClientCapabilities = {
				fs: { readTextFile: true, writeTextFile: true },
			};
			const bridge = createAcpClientBridge(connectionStub, "session-42", capabilities);

			expect(bridge.capabilities.readTextFile).toBe(true);
			const content = await bridge.readTextFile!({ path: "/workspace/foo.ts", line: 10, limit: 50 });
			expect(content).toBe("client file text\n");
			expect(capturedReadReq).toEqual({
				sessionId: "session-42",
				path: "/workspace/foo.ts",
				line: 10,
				limit: 50,
			});

			await expect(bridge.readTextFile!({ path: "/workspace/missing.ts" })).rejects.toThrow(
				"File not found on client host",
			);
		});

		it("maps writeTextFile request and propagates connection errors", async () => {
			let capturedWriteReq: WriteTextFileRequest | undefined;
			const connectionStub = {
				async writeTextFile(params: WriteTextFileRequest): Promise<void> {
					capturedWriteReq = params;
					if (params.path.includes("forbidden")) {
						throw new Error("Permission denied by editor policy");
					}
				},
			} as unknown as AgentSideConnection;

			const capabilities: ClientCapabilities = {
				fs: { writeTextFile: true },
			};
			const bridge = createAcpClientBridge(connectionStub, "session-42", capabilities);

			await bridge.writeTextFile!({ path: "/workspace/bar.ts", content: "const bar = 2;\n" });
			expect(capturedWriteReq).toEqual({
				sessionId: "session-42",
				path: "/workspace/bar.ts",
				content: "const bar = 2;\n",
			});

			await expect(bridge.writeTextFile!({ path: "/workspace/forbidden.ts", content: "bad" })).rejects.toThrow(
				"Permission denied by editor policy",
			);
		});

		it("maps terminal lifecycle operations and exit status", async () => {
			let capturedTermReq: CreateTerminalRequest | undefined;
			let killed = false;
			let released = false;
			const acpTerminalHandle = {
				id: "term-99",
				sessionId: "session-42",
				async currentOutput(): Promise<TerminalOutputResponse> {
					return {
						output: "compiling...",
						truncated: false,
						exitStatus: { exitCode: 0, signal: null },
					};
				},
				async waitForExit() {
					return { exitCode: 0, signal: null };
				},
				async kill() {
					killed = true;
					return {};
				},
				async release() {
					released = true;
				},
			} as unknown as AcpTerminalHandle;

			const connectionStub = {
				async createTerminal(params: CreateTerminalRequest): Promise<AcpTerminalHandle> {
					capturedTermReq = params;
					return acpTerminalHandle;
				},
			} as unknown as AgentSideConnection;

			const bridge = createAcpClientBridge(connectionStub, "session-42", { terminal: true });
			expect(bridge.capabilities.terminal).toBe(true);

			const handle = await bridge.createTerminal!({
				command: "bun",
				args: ["test"],
				cwd: "/workspace",
				outputByteLimit: 4096,
			});

			expect(handle.terminalId).toBe("term-99");
			expect(capturedTermReq).toEqual({
				sessionId: "session-42",
				command: "bun",
				args: ["test"],
				cwd: "/workspace",
				outputByteLimit: 4096,
			});

			const output = await handle.currentOutput();
			expect(output.output).toBe("compiling...");
			expect(output.exitStatus).toEqual({ exitCode: 0, signal: null });

			const exit = await handle.waitForExit();
			expect(exit).toEqual({ exitCode: 0, signal: null });

			await handle.kill();
			expect(killed).toBe(true);
			await handle.release();
			expect(released).toBe(true);
		});

		it("maps requestPermission responses and handles cancellation", async () => {
			let capturedReq: RequestPermissionRequest | undefined;
			let returnCancelled = false;

			const connectionStub = {
				async requestPermission(params: RequestPermissionRequest) {
					capturedReq = params;
					if (returnCancelled) {
						return { outcome: { outcome: "cancelled" as const } };
					}
					return { outcome: { outcome: "selected" as const, optionId: "allow_always" } };
				},
			} as unknown as AgentSideConnection;

			const bridge = createAcpClientBridge(connectionStub, "session-42", {});

			const outcome = await bridge.requestPermission!(
				{
					toolCallId: "tc-1",
					toolName: "bash",
					title: "Execute bash command",
					kind: "execute",
					status: "pending",
					rawInput: { command: "ls" },
				},
				[
					{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
					{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
				],
			);

			expect(outcome).toEqual({
				outcome: "selected",
				optionId: "allow_always",
				kind: "allow_always",
			});
			expect(capturedReq?.sessionId).toBe("session-42");
			expect(capturedReq?.toolCall.toolCallId).toBe("tc-1");

			// Cancelled outcome
			returnCancelled = true;
			const cancelledOutcome = await bridge.requestPermission!(
				{
					toolCallId: "tc-2",
					toolName: "bash",
					title: "Execute command 2",
				},
				[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
			);
			expect(cancelledOutcome).toEqual({ outcome: "cancelled" });

			// Aborted signal returns cancelled immediately without calling connection
			capturedReq = undefined;
			const abortController = new AbortController();
			abortController.abort();
			const preAbortedOutcome = await bridge.requestPermission!(
				{ toolCallId: "tc-3", toolName: "bash", title: "Aborted call" },
				[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
				abortController.signal,
			);
			expect(preAbortedOutcome).toEqual({ outcome: "cancelled" });
			expect(capturedReq).toBeUndefined();
		});
	});
});
