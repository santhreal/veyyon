/**
 * WHY THIS SUITE EXISTS.
 *
 * Incident class: "basic behavior tool call failures" — the model emits a tool
 * call the harness cannot run (truncated JSON arguments from a streaming
 * provider, an argument set that fails the tool's schema, a tool name that
 * does not exist), and the harness must (a) never execute the tool, (b) hand
 * the model a structured error it can act on, and (c) keep the session alive.
 * Every one of those has regressed in the field in one layer or another: the
 * GLM empty-tool-name incident wedged sessions into 400 loops, and the
 * `__parseError` sentinel exists because a truncated argument stream used to
 * either execute with half-parsed arguments or kill the turn.
 *
 * These tests drive the REAL stack — AgentSession.prompt → Agent loop →
 * executeToolCalls → a real registered tool — with a scripted model stream,
 * and read both the persisted transcript and the exact messages the next
 * model call is built from. The loop-level units live in
 * packages/agent/test/agent-loop.test.ts; what they do not cover is the
 * AgentSession seam: session wiring, persistence, and session settle state.
 *
 * MUTATION PLAN (verified by tracing each mutation through agent-loop.ts;
 * the unknown-tool remedy assertion was additionally run red before the fix
 * landed — see the "names the remedy" test):
 *
 * 1. Execute-despite-parse-error: delete the `__parseError` throw in
 *    `validateToolArguments` (packages/ai/src/utils/validation.ts). The
 *    `never executed` spy assertions go red in the malformed-JSON test.
 * 2. Swallow-the-error: make the validation catch in `runTool` emit a
 *    non-error result. Every `isError).toBe(true)` assertion goes red.
 * 3. Drop-the-result: return without `emitToolResult` in the catch. The
 *    `recovered` / mock-calls assertions time out or go red — the loop needs
 *    the toolResult to pair the call before the next turn.
 * 4. Bare unknown-tool message: revert agent-loop.ts to
 *    `throw new Error(\`Tool ${name} not found\`)`. The "names the remedy the
 *    model can act on" test goes red on the `Available:` assertion. (Confirmed
 *    red before the fix; the fix routes the loop through the existing
 *    `AIError.ToolNotFoundError`, whose available-tools remedy is documented
 *    intent in packages/ai/CHANGELOG.md.)
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import type { Message, ToolResultMessage } from "@veyyon/ai";
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

/**
 * Text of the tool result as the NEXT model call received it. This is the
 * assertion that proves the error actually reaches the model, not just the
 * transcript: the second scripted turn's request context must carry the
 * error text. Matched by tool name, not call id: the wire canonicalizer
 * rewrites provider-facing ids, so the outbound id is not the emitted one.
 */
function nextRequestToolResultText(messages: Message[], toolName: string): string | undefined {
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== toolName) continue;
		const parts: string[] = [];
		for (const block of message.content) {
			if (typeof block === "object" && block !== null && block.type === "text") parts.push(block.text);
		}
		return parts.join("\n");
	}
	return undefined;
}

describe("a tool call the harness cannot run never executes and errors to the model", () => {
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession;
	let mock: ReturnType<typeof createMockModel>;
	let scriptedResponses: MockResponse[];
	let executedArgs: Record<string, unknown>[];

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-tcinv-dispatch-${Snowflake.next()}`);
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

		executedArgs = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: type({ value: "string" }),
			strict: true,
			async execute(_toolCallId, args) {
				executedArgs.push(args as Record<string, unknown>);
				return { content: [{ type: "text", text: "echoed" }] };
			},
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
				tools: [echoTool],
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
			toolRegistry: new Map([[echoTool.name, echoTool]]),
		});
	});

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

	it("malformed streamed argument JSON never executes and surfaces the parse error", async () => {
		// The shape a provider stream produces when the argument JSON arrives
		// truncated: the stream layer recovers nothing and stamps the sentinel.
		const callId = "call_malformed";
		scriptedResponses = [
			{
				content: [
					{
						type: "toolCall",
						id: callId,
						name: "echo",
						arguments: {
							__parseError: "Unexpected token F in JSON at position 6",
							__rawJson: '{"i": Finding definition, "value": "hello"',
						},
					},
				],
			},
			stopReply("recovered from the malformed call"),
		];

		await session.prompt("run echo");
		await session.waitForIdle();

		// Never executed: the malformed call must not reach tool.execute().
		expect(executedArgs).toEqual([]);

		// Structured error in the transcript, not a crash or a silent skip.
		const result = findToolResult(session.agent.state.messages, callId);
		expect(result, "expected a toolResult for the malformed call").toBeDefined();
		if (!result) throw new Error("unreachable");
		expect(result.isError).toBe(true);
		const text = toolResultText(result);
		expect(text).toContain('Validation failed for tool "echo"');
		expect(text).toContain("Tool call arguments are not valid JSON.");
		expect(text).toContain("Unexpected token F in JSON at position 6");

		// The NEXT request carries the error: the model sees why the call failed.
		expect(mock.calls.length).toBe(2);
		const wireText = nextRequestToolResultText(mock.calls[1]?.context.messages ?? [], "echo");
		expect(wireText).toBeDefined();
		expect(wireText ?? "").toContain("Tool call arguments are not valid JSON.");

		// The session settled and the follow-up turn completed.
		expect(session.agent.state.pendingToolCalls.size).toBe(0);
		expect(session.isStreaming).toBe(false);
		const last = session.agent.state.messages.at(-1);
		expect(last?.role).toBe("assistant");
	});

	it("schema-invalid arguments never execute and name the failing field", async () => {
		const callId = "call_bad_schema";
		scriptedResponses = [
			{
				// `value` is required and missing: no coercion can invent it.
				content: [{ type: "toolCall", id: callId, name: "echo", arguments: {} }],
			},
			stopReply("recovered from the schema error"),
		];

		await session.prompt("run echo");
		await session.waitForIdle();

		expect(executedArgs).toEqual([]);

		const result = findToolResult(session.agent.state.messages, callId);
		expect(result, "expected a toolResult for the schema-invalid call").toBeDefined();
		if (!result) throw new Error("unreachable");
		expect(result.isError).toBe(true);
		const text = toolResultText(result);
		expect(text).toContain('Validation failed for tool "echo"');
		// The field name is the actionable part: the model can only fix what is named.
		expect(text).toContain("value");

		// The error reaches the model on the next request.
		expect(mock.calls.length).toBe(2);
		const wireText = nextRequestToolResultText(mock.calls[1]?.context.messages ?? [], "echo");
		expect(wireText ?? "").toContain('Validation failed for tool "echo"');

		expect(session.agent.state.pendingToolCalls.size).toBe(0);
		expect(session.isStreaming).toBe(false);
	});

	it("an unknown tool name produces an error result, not a crash or a silent skip", async () => {
		const callId = "call_ghost";
		scriptedResponses = [
			{
				content: [{ type: "toolCall", id: callId, name: "ghost_tool", arguments: { value: "x" } }],
			},
			stopReply("recovered from the unknown tool"),
		];

		await session.prompt("call a tool that does not exist");
		await session.waitForIdle();

		// Nothing executed: there is no such tool to run, and no tool ran by accident.
		expect(executedArgs).toEqual([]);

		const result = findToolResult(session.agent.state.messages, callId);
		expect(result, "expected a toolResult for the unknown tool call").toBeDefined();
		if (!result) throw new Error("unreachable");
		expect(result.isError).toBe(true);
		expect(toolResultText(result)).toContain('Tool "ghost_tool" not found');

		// The loop recovered and the scripted stop turn ran: no crash, no hang.
		expect(mock.calls.length).toBe(2);
		expect(session.agent.state.pendingToolCalls.size).toBe(0);
		expect(session.isStreaming).toBe(false);
		const last = session.agent.state.messages.at(-1);
		expect(last?.role).toBe("assistant");
	});

	it("names the remedy the model can act on for an unknown tool", async () => {
		// The reader of this message is the MODEL. A bare "not found" leaves it
		// two moves — guess another name or abandon the task — so the message
		// must name the tools that DO exist. This is the documented contract of
		// ToolNotFoundError (packages/ai/src/error/validation.ts); the agent
		// loop, the primary dispatch path, threw the bare message instead until
		// the fix this test pins.
		const callId = "call_ghost_remedy";
		scriptedResponses = [
			{
				content: [{ type: "toolCall", id: callId, name: "ghost_tool", arguments: {} }],
			},
			stopReply("recovered"),
		];

		await session.prompt("call a tool that does not exist");
		await session.waitForIdle();

		const result = findToolResult(session.agent.state.messages, callId);
		if (!result) throw new Error("expected a toolResult for the unknown tool call");
		const text = toolResultText(result);
		expect(text).toContain('Tool "ghost_tool" not found');
		// The remedy: name the real tool set so the model's retry can succeed.
		expect(text).toContain("Available:");
		expect(text).toContain("echo");

		// The remedy reaches the model, not just the transcript.
		const wireText = nextRequestToolResultText(mock.calls[1]?.context.messages ?? [], "ghost_tool");
		expect(wireText ?? "").toContain("Available:");
	});
});
