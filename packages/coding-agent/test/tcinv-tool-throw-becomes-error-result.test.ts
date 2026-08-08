/**
 * WHY THIS SUITE EXISTS.
 *
 * Incident class: "basic behavior tool call failures" — a tool that fails at
 * runtime must become an error tool-result the model can read, with the
 * failure text intact. The regressions this defends against, all observed in
 * the field in one form or another:
 *
 *  1. A throwing tool escaping the dispatch boundary and killing the run (or
 *     hanging it) instead of producing an error tool-result.
 *  2. A thrown error whose message is swallowed on the way to the transcript,
 *     leaving the model a bare "Error" with nothing to act on.
 *  3. A non-Error thrown value (third-party tools throw strings) producing an
 *     "[object Object]"-style message or an empty result.
 *  4. A tool returning a malformed result (no `content` array — the classic
 *     MCP/extension violation) being persisted verbatim and corrupting the
 *     session file so the next reload crashes. `coerceToolResult` is the
 *     boundary guard; this proves the guard holds through the real session.
 *
 * These tests drive the REAL stack — AgentSession.prompt → Agent loop →
 * executeToolCalls → a real registered tool — with a scripted model stream,
 * and read the persisted transcript plus the exact messages the next model
 * call is built from.
 *
 * MUTATION PLAN (traced through packages/agent/src/agent-loop.ts):
 *
 *  1. Delete the `catch (e)` around `tool.execute` in `runTool`: the run
 *     rejects and `session.prompt` never settles normally — every test here
 *     fails on the transcript assertions or times out.
 *  2. Replace the caught error's text with a constant ("tool failed"): the
 *     exact-message assertions (`toBe("kaboom: disk on fire")`, the string
 *     throw) go red.
 *  3. Make `coerceToolResult` pass malformed results through unchanged: the
 *     malformed-result test goes red on the "invalid result" text and the
 *     `isError` assertion.
 *  4. Mark the error result `isError: false`: every `toBe(true)` on isError
 *     goes red, and the renderer/retry logic downstream loses the signal.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool, type AgentToolResult } from "@veyyon/agent-core";
import type { ToolResultMessage } from "@veyyon/ai";
import { createMockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { type } from "arktype";

/** Scripted plain-text assistant turn that ends the loop. */
function stopReply(text: string): MockResponse {
	return {
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
}

/** Find the persisted tool result for one call id in the live transcript. */
function findToolResult(messages: AgentMessage[], callId: string): ToolResultMessage | undefined {
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolCallId === callId) return message;
	}
	return undefined;
}

/** Join the text blocks of a tool result for assertion. */
function toolResultText(message: ToolResultMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n");
}

describe("a failing tool becomes an error tool-result with the message intact", () => {
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession;
	let mock: ReturnType<typeof createMockModel>;
	let scriptedResponses: MockResponse[];

	/**
	 * Build a session whose single tool behaves however `impl` dictates:
	 * throw an Error, throw a non-Error, or return a malformed result.
	 */
	async function createSession(impl: AgentTool["execute"]): Promise<void> {
		tempDir = path.join(os.tmpdir(), `pi-tcinv-throw-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");

		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
			"async.enabled": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir);

		const failingTool: AgentTool = {
			name: "fragile",
			label: "Fragile",
			description: "A tool that fails",
			parameters: type({}),
			strict: true,
			execute: impl,
		};

		scriptedResponses = [];
		mock = createMockModel({
			handler: () => scriptedResponses.shift() ?? stopReply("done"),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [failingTool],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[failingTool.name, failingTool]]),
		});
	}

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	function scriptOneCall(callId: string): void {
		scriptedResponses = [
			{
				content: [{ type: "toolCall", id: callId, name: "fragile", arguments: {} }],
			},
			stopReply("recovered after the failure"),
		];
	}

	it("a thrown Error becomes an error result carrying its exact message, and the run continues", async () => {
		await createSession(async () => {
			throw new Error("kaboom: disk on fire");
		});
		const callId = "call_throws";
		scriptOneCall(callId);

		await session.prompt("run the fragile tool");
		await session.waitForIdle();

		const result = findToolResult(session.agent.state.messages, callId);
		expect(result, "expected a toolResult for the throwing tool").toBeDefined();
		if (!result) throw new Error("unreachable");
		expect(result.isError).toBe(true);
		// The message, whole: a swallowed or reworded message leaves the model
		// unable to decide whether to retry, fix arguments, or give up.
		expect(toolResultText(result)).toBe("kaboom: disk on fire");

		// The loop survived and asked the model again with the failure in context.
		expect(mock.calls.length).toBe(2);
		expect(session.agent.state.pendingToolCalls.size).toBe(0);
		expect(session.isStreaming).toBe(false);
		const last = session.agent.state.messages.at(-1);
		expect(last?.role).toBe("assistant");
	});

	it("a thrown non-Error value keeps its text instead of degrading to a placeholder", async () => {
		await createSession(async () => {
			// Third-party tools (MCP bridges, extensions) throw strings.
			throw "plain string failure from a foreign tool";
		});
		const callId = "call_throws_string";
		scriptOneCall(callId);

		await session.prompt("run the fragile tool");
		await session.waitForIdle();

		const result = findToolResult(session.agent.state.messages, callId);
		if (!result) throw new Error("expected a toolResult for the string-throwing tool");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toBe("plain string failure from a foreign tool");

		expect(mock.calls.length).toBe(2);
		expect(session.agent.state.pendingToolCalls.size).toBe(0);
		expect(session.isStreaming).toBe(false);
	});

	it("a tool returning a malformed result is coerced to an error, not persisted verbatim", async () => {
		// The session-file-corruption regression: an MCP/extension tool
		// resolving with `{}` used to be persisted as-is, and the missing
		// `content` array crashed consumers on reload.
		const malformedImpl: AgentTool["execute"] = async () => {
			// Deliberately violates the tool contract (no `content` array) to stand
			// in for a third-party tool; the cast exists because the type system
			// rightly forbids this and the test needs the runtime violation.
			const contractViolatingResult = { details: { note: "forgot the content array" } };
			return contractViolatingResult as unknown as AgentToolResult;
		};
		await createSession(malformedImpl);
		const callId = "call_malformed_result";
		scriptOneCall(callId);

		await session.prompt("run the fragile tool");
		await session.waitForIdle();

		const result = findToolResult(session.agent.state.messages, callId);
		if (!result) throw new Error("expected a toolResult for the malformed-result tool");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toContain("Tool returned an invalid result");
		// The persisted message is structurally valid: a content array exists.
		expect(Array.isArray(result.content)).toBe(true);

		// The session is still usable: the loop completed and a follow-up works.
		expect(mock.calls.length).toBe(2);
		expect(session.agent.state.pendingToolCalls.size).toBe(0);
		expect(session.isStreaming).toBe(false);
		await expect(session.prompt("are you still alive")).resolves.toBe(true);
		await session.waitForIdle();
		expect(session.isStreaming).toBe(false);
	});
});
