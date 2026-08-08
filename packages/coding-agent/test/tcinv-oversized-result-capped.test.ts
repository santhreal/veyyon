/**
 * WHY THIS SUITE EXISTS.
 *
 * Incident class: "basic behavior tool call failures" — a tool with no byte
 * budget of its own (an MCP server, an extension, any tool registered from
 * outside the codebase) returns a result bigger than the request can carry.
 * The regression this defends against shipped once already: the backstop cap
 * existed as a pure function while the loop copied `result.content` into the
 * persisted message verbatim, so unbounded tools went to the provider
 * uncapped until the request itself failed. The documented policy
 * (packages/agent/src/tool-result-cap.ts):
 *
 *  - text bytes a single tool result contributes are capped at
 *    DEFAULT_TOOL_RESULT_MAX_BYTES (1 MiB);
 *  - the middle is elided, head and tail are kept (the head says what the
 *    command was doing, the tail says how it ended);
 *  - the elision marker `[…NB elided…]` states exactly how many bytes were
 *    removed, so the gap is never mistaken for real output;
 *  - a result that fits is delivered byte-identical — the cap must not
 *    rewrite ordinary results.
 *
 * The pure-function and loop-wiring units live in packages/agent/test. What
 * they do not cover is the AgentSession seam: that the capped content is what
 * the session PERSISTS and what the NEXT request is built from. These tests
 * drive the real stack — AgentSession.prompt → Agent loop → a real
 * registered tool — and read both.
 *
 * MUTATION PLAN (traced through agent-loop.ts `emitToolResult` and
 * tool-result-cap.ts):
 *
 *  1. Persist `result.content` instead of `cappedContent`: the byte-budget
 *     and marker assertions in the oversized test go red (this is the exact
 *     historical bug).
 *  2. Cap unconditionally / rewrite small results: the byte-identical test
 *     goes red.
 *  3. Drop the elision marker or elide the head/tail instead of the middle:
 *     the marker, head, tail, and middle-absence assertions go red.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool, DEFAULT_TOOL_RESULT_MAX_BYTES } from "@veyyon/agent-core";
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
 * The tool result text the NEXT model call was built from. Matched by tool
 * name, not call id: the wire canonicalizer rewrites provider-facing ids.
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

/** Marker string the cap writes where bytes were removed, e.g. `[…681kB elided…]`. */
const ELISION_PATTERN = /\[…(\d+)B elided…\]/;

describe("an oversized tool result is capped before it is persisted or sent", () => {
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession;
	let mock: ReturnType<typeof createMockModel>;
	let scriptedResponses: MockResponse[];
	let toolOutput: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-tcinv-cap-${Snowflake.next()}`);
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

		toolOutput = "";
		// A tool with NO budget of its own — the case the backstop cap exists for.
		const unboundedTool: AgentTool = {
			name: "unbounded_dump",
			label: "Unbounded Dump",
			description: "Returns whatever it is fed, with no byte budget",
			parameters: type({}),
			strict: true,
			async execute() {
				return { content: [{ type: "text", text: toolOutput }] };
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
				tools: [unboundedTool],
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
			toolRegistry: new Map([[unboundedTool.name, unboundedTool]]),
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

	function scriptOneCall(callId: string): void {
		scriptedResponses = [
			{
				content: [{ type: "toolCall", id: callId, name: "unbounded_dump", arguments: {} }],
			},
			stopReply("done reading the result"),
		];
	}

	it("caps a 1.5 MiB result at the documented budget, keeping head, tail, and the elision marker", async () => {
		// Head and tail carry the identifying lines; the middle is unique filler
		// that must NOT survive. Line-shaped so the cap's line-boundary trimming
		// keeps both markers.
		const head = "BEGIN-OUTPUT-HEAD";
		const tail = "END-OUTPUT-TAIL";
		const fillerLine = `${"M".repeat(99)}\n`;
		// A unique line placed ~1 MiB in: past the 60% head window and well
		// before the 25% tail window, so it survives only if nothing was elided.
		const middle = "MIDDLE-ONLY-MARKER";
		const preMiddle = fillerLine.repeat(Math.ceil((1024 * 1024) / fillerLine.length));
		const postMiddle = fillerLine.repeat(Math.ceil((0.5 * 1024 * 1024) / fillerLine.length));
		toolOutput = `${head}\n${preMiddle}${middle}\n${postMiddle}${tail}`;

		const callId = "call_oversized";
		scriptOneCall(callId);

		await session.prompt("dump the output");
		await session.waitForIdle();

		const result = findToolResult(session.agent.state.messages, callId);
		expect(result, "expected a toolResult for the oversized call").toBeDefined();
		if (!result) throw new Error("unreachable");
		// Capping is not a failure: the tool ran fine, its output was just big.
		expect(result.isError).toBeFalsy();

		const persisted = toolResultText(result);
		const persistedBytes = Buffer.byteLength(persisted, "utf-8");
		expect(persistedBytes).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_BYTES);

		// Head and tail survive; the middle does not; the marker says so.
		expect(persisted.startsWith(head)).toBe(true);
		expect(persisted.endsWith(tail)).toBe(true);
		const marker = ELISION_PATTERN.exec(persisted);
		expect(marker, "expected the elision marker in the capped result").not.toBeNull();
		const elided = Number(marker?.[1]);
		// ~1.5 MiB in, 85% of 1 MiB kept: well over half a million bytes elided.
		expect(elided).toBeGreaterThan(500_000);
		expect(persisted).not.toContain(middle);

		// The next request is built from the CAPPED content: the model never
		// sees the uncapped payload.
		expect(mock.calls.length).toBe(2);
		const wireText = nextRequestToolResultText(mock.calls[1]?.context.messages ?? [], "unbounded_dump");
		expect(wireText).toBeDefined();
		expect(wireText).toBe(persisted);
	});

	it("delivers a result that fits byte-identical", async () => {
		toolOutput = "a perfectly ordinary result\nwith two lines\n";
		const callId = "call_small";
		scriptOneCall(callId);

		await session.prompt("dump the output");
		await session.waitForIdle();

		const result = findToolResult(session.agent.state.messages, callId);
		if (!result) throw new Error("expected a toolResult for the small call");
		expect(result.isError).toBeFalsy();
		expect(toolResultText(result)).toBe(toolOutput);
	});
});
