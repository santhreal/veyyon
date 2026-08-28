/**
 * WHY: `AgentSessionFacade` is the only session API a graphical front end is
 * meant to hold, so every promise it makes has to hold against a live
 * `AgentSession` rather than a double. The defect class this closes is a facade
 * that compiles and publishes nothing: a subscription that is never installed, a
 * permission prompt that never reaches the caller, an `approveTool` that resolves
 * the wrong rung, a `running` flag that survives `stop()`, or a usage figure that
 * stays zero after a turn.
 *
 * Every test here drives a real `AgentSession` over a mock provider and a real
 * tool registry, including the `bash` permission gate the session installs when a
 * client bridge appears. Nothing is stubbed but the model's bytes.
 *
 * What it does not catch: the facade's behaviour under a real provider's
 * streaming timing, and the front end's own rendering of these events.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { z } from "@veyyon/ai";
import { createMockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import type { ClientBridge } from "@veyyon/coding-agent/session/client-bridge";
import {
	type AgentSessionFacade,
	createSessionFacade,
	type FacadeActivity,
	type FacadeToolCall,
	type FacadeToolResult,
} from "@veyyon/coding-agent/session/facade";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const bashSchema = z.object({ command: z.string() });

/** A `bash` tool, so the session's permission gate wraps it once a bridge exists. */
const bashTool: AgentTool<typeof bashSchema, { command: string }> = {
	name: "bash",
	label: "Bash",
	description: "Run a command",
	parameters: bashSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `ran:${params.command}` }],
			details: { command: params.command },
		};
	},
};

function bashCall(command: string, id: string): MockResponse {
	return { content: [{ type: "toolCall", id, name: "bash", arguments: { command } }], stopReason: "toolUse" };
}

function textStop(text: string): MockResponse {
	return { content: [{ type: "text", text }], stopReason: "stop", usage: { input: 120, output: 8 } };
}

interface Harness {
	session: AgentSession;
	facade: AgentSessionFacade;
	tempDir: TempDir;
	messages: string[];
	toolCalls: FacadeToolCall[];
	toolResults: FacadeToolResult[];
	activities: FacadeActivity[];
	usages: number[];
	errors: Error[];
}

const live: Harness[] = [];

async function createHarness(responses: MockResponse[]): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-facade-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	const tools = [bashTool as AgentTool];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});

	const harness: Harness = {
		session,
		facade: createSessionFacade(session),
		tempDir,
		messages: [],
		toolCalls: [],
		toolResults: [],
		activities: [],
		usages: [],
		errors: [],
	};
	harness.facade.on("message", message => {
		if (message.role !== "assistant") return;
		for (const part of message.content) if (part.type === "text") harness.messages.push(part.text);
	});
	harness.facade.on("tool_call", call => harness.toolCalls.push(call));
	harness.facade.on("tool_result", result => harness.toolResults.push(result));
	harness.facade.on("status", activity => harness.activities.push(activity));
	harness.facade.on("usage", usage => harness.usages.push(usage.tokens));
	harness.facade.on("error", err => harness.errors.push(err));
	live.push(harness);
	return harness;
}

/** Resolve on the first `tool_call` the facade publishes with a held approval. */
function heldCall(facade: AgentSessionFacade): Promise<FacadeToolCall> {
	const { promise, resolve } = Promise.withResolvers<FacadeToolCall>();
	const off = facade.on("tool_call", call => {
		if (!call.needsApproval) return;
		off();
		resolve(call);
	});
	return promise;
}

afterEach(async () => {
	for (const harness of live.splice(0)) {
		await harness.facade.stop().catch(() => {});
		if (!harness.session.isDisposed) await harness.session.dispose().catch(() => {});
		await harness.tempDir.remove();
	}
});

describe("the facade's lifecycle", () => {
	it("is not running before start and not running after stop", async () => {
		const harness = await createHarness([textStop("hello")]);
		expect(harness.facade.running).toBe(false);
		await harness.facade.start();
		expect(harness.facade.running).toBe(true);
		await harness.facade.stop();
		expect(harness.facade.running).toBe(false);
		expect(harness.session.isDisposed).toBe(true);
		expect(harness.activities.at(-1)).toBe("stopped");
	});

	it("refuses a second host's session rather than displacing its permission prompt", async () => {
		const harness = await createHarness([textStop("hello")]);
		const other: ClientBridge = {
			capabilities: { requestPermission: true },
			requestPermission: async () => ({ outcome: "cancelled" }),
		};
		harness.session.setClientBridge(other);
		await expect(harness.facade.start()).rejects.toThrow(/already routes through a client bridge/);
		expect(harness.session.clientBridge).toBe(other);
	});

	it("refuses a submit before start", async () => {
		const harness = await createHarness([textStop("hello")]);
		await expect(harness.facade.submit("hi")).rejects.toThrow(/not running/);
	});

	it("start is idempotent", async () => {
		const harness = await createHarness([textStop("hello")]);
		await harness.facade.start();
		await harness.facade.start();
		expect(harness.facade.running).toBe(true);
	});

	it("stop is idempotent and leaves the session disposed once", async () => {
		const harness = await createHarness([textStop("hello")]);
		await harness.facade.start();
		await harness.facade.stop();
		await harness.facade.stop();
		expect(harness.session.isDisposed).toBe(true);
	});
});

describe("what the facade publishes for a turn", () => {
	it("carries the assistant's text, the activity trail and the context usage", async () => {
		const harness = await createHarness([textStop("the answer")]);
		await harness.facade.start();
		await harness.facade.submit("the question");

		expect(harness.messages).toContain("the answer");
		expect(harness.activities).toContain("thinking");
		expect(harness.activities.at(-1)).toBe("idle");
		expect(harness.usages.length).toBeGreaterThan(0);
		expect(harness.usages.at(-1)).toBeGreaterThan(0);
		expect(harness.facade.tokenCount).toBeGreaterThan(0);
		expect(harness.facade.contextUsage).toBeGreaterThan(0);
		expect(harness.facade.provider).toBe("mock");
		expect(harness.facade.model?.id).toBe(harness.session.model?.id);
	});
});

describe("the permission prompt the facade owns", () => {
	it("holds a gated call until approveTool names it, then runs it", async () => {
		const harness = await createHarness([bashCall("echo hi", "call-1"), textStop("done")]);
		await harness.facade.start();
		const held = heldCall(harness.facade);
		const turn = harness.facade.submit("run it");
		const call = await held;

		expect(call.callId).toBe("call-1");
		expect(call.toolName).toBe("bash");
		expect(call.needsApproval).toBe(true);
		expect(call.intent).toBe("echo hi");
		expect(harness.toolResults).toHaveLength(0);

		expect(harness.facade.approveTool(call.callId)).toBe(true);
		await turn;

		const result = harness.toolResults.find(entry => entry.callId === "call-1");
		expect(result).toBeDefined();
		expect(result?.isError).toBeFalsy();
		expect(JSON.stringify(result?.result.content)).toContain("ran:echo hi");
	});

	it("fails a gated call when rejectTool names it", async () => {
		const harness = await createHarness([bashCall("rm -rf /", "call-2"), textStop("refused")]);
		await harness.facade.start();
		const held = heldCall(harness.facade);
		const turn = harness.facade.submit("run it");
		const call = await held;

		expect(harness.facade.rejectTool(call.callId, "not on my machine")).toBe(true);
		await turn;

		const result = harness.toolResults.find(entry => entry.callId === "call-2");
		expect(result).toBeDefined();
		expect(result?.isError).toBe(true);
		expect(JSON.stringify(result?.result.content)).toContain("rejected by user");
	});

	it("answers false for a call id it is not holding", async () => {
		const harness = await createHarness([textStop("hello")]);
		await harness.facade.start();
		expect(harness.facade.approveTool("no-such-call")).toBe(false);
		expect(harness.facade.rejectTool("no-such-call")).toBe(false);
	});

	it("cancels every held call on stop, so a turn cannot hang past teardown", async () => {
		const harness = await createHarness([bashCall("echo hi", "call-3"), textStop("done")]);
		await harness.facade.start();
		const held = heldCall(harness.facade);
		const turn = harness.facade.submit("run it");
		await held;

		await harness.facade.stop();
		await turn;

		expect(harness.session.isDisposed).toBe(true);
	});
});

describe("removing a handler", () => {
	it("stops delivering to it", async () => {
		const harness = await createHarness([textStop("first"), textStop("second")]);
		const seen: string[] = [];
		await harness.facade.start();
		const off = harness.facade.on("message", message => {
			if (message.role === "assistant") seen.push("saw");
		});
		await harness.facade.submit("one");
		const afterFirst = seen.length;
		expect(afterFirst).toBeGreaterThan(0);
		off();
		await harness.facade.submit("two");
		expect(seen).toHaveLength(afterFirst);
	});
});
