import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { SUPERSEDED_NOTICE } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model, ToolResultMessage } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: the per-turn supersede pass blanks a stale `read` result in place once a
 * newer read of the same file lands. That is an edit to a message the model has
 * already been sent, and on a model that binds thinking blocks to their prefix
 * (Claude Fable 5.1 and later) it invalidates every thinking block recorded
 * after it — so a routine cache-cheap prune would cost the whole reasoning
 * chain behind it, every turn. Such a model prunes only what carries no suffix.
 *
 * The class this closes: an in-place history rewrite that is worth its price on
 * an ordinary model must not fire unconditionally on a prefix-bound one. The
 * control arm proves the pass still works, so a change that disables pruning
 * outright fails here rather than looking like a fix.
 *
 * What it does NOT catch: compaction and the overflow prune, which rewrite
 * history by design and mark it (`historyRewriteAt`, `prunedAt`) for
 * `transformMessages` to act on.
 */

const OLD_RESULT = "old file contents\n".repeat(200);
const NEW_RESULT = "new file contents\n".repeat(200);

const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function claudeModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "anthropic",
		id,
		name: id,
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	});
}

describe("a prefix-bound model's warm tool results", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@veyyon-prefix-binding-prune-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	function newSession(model: Model): AgentSession {
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const now = Date.now();
		const assistant = (toolCallId: string, timestamp: number): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/foo.ts" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: ZERO_USAGE,
			stopReason: "toolUse",
			timestamp,
		});
		const result = (toolCallId: string, text: string, timestamp: number): ToolResultMessage => ({
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp,
		});

		sessionManager.appendMessage({ role: "user", content: "Read the file twice.", timestamp: now - 500 });
		sessionManager.appendMessage(assistant("read-old", now - 400));
		sessionManager.appendMessage(result("read-old", OLD_RESULT, now - 350));
		sessionManager.appendMessage(assistant("read-new", now - 300));
		sessionManager.appendMessage(result("read-new", NEW_RESULT, now - 250));

		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.supersedeReads": true }),
			modelRegistry,
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		sessions.push(session);
		return session;
	}

	async function runTurn(session: AgentSession): Promise<void> {
		const model = session.model;
		if (!model) throw new Error("Expected an active model");
		const finalAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });
		await session.waitForIdle();
	}

	function supersededResultText(session: AgentSession): string {
		const message = session.agent.state.messages.find(
			(candidate): candidate is ToolResultMessage =>
				candidate.role === "toolResult" && candidate.toolCallId === "read-old",
		);
		if (!message) throw new Error("Expected the superseded read result");
		const text = message.content.find(block => block.type === "text");
		if (text?.type !== "text") throw new Error("Expected text in the superseded read result");
		return text.text;
	}

	it("survive the supersede pass that prunes them for a model without prefix binding", async () => {
		const bound = newSession(claudeModel("claude-fable-5-1"));
		const control = newSession(claudeModel("claude-fable-5"));
		expect(bound.model?.thinking?.prefixBinding).toBe(true);
		expect(control.model?.thinking?.prefixBinding).toBeUndefined();

		await runTurn(bound);
		await runTurn(control);

		expect(supersededResultText(bound)).toBe(OLD_RESULT);
		expect(supersededResultText(control)).toBe(SUPERSEDED_NOTICE);
	});
});
