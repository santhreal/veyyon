import { describe, expect, it } from "bun:test";
import { AppendOnlyContextManager } from "@veyyon/agent-core/append-only-context";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "@veyyon/agent-core/compaction/messages";
import type { AgentMessage } from "@veyyon/agent-core/types";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@veyyon/ai";
import {
	type BashExecutionMessage,
	convertToLlm,
	type FileMentionMessage,
	type PythonExecutionMessage,
} from "@veyyon/coding-agent/session/messages";
import { ProviderContextCanonicalizer } from "@veyyon/coding-agent/session/provider-context-canonicalizer";

/**
 * WHY:
 *
 * DEFECT:
 * ProviderContextCanonicalizer memoizes its transformed output and reuses the unchanged
 * prefix by comparing source message references (`messages[common] === this.#source[common]`).
 * In append-only mode, AppendOnlyLog preserves references across turns, so memoization worked.
 * But on non-append-only provider paths (including Anthropic and OpenAI defaults), convertToLlm
 * ran on every turn and allocated fresh wrapper objects for user, toolResult, custom, and
 * execution messages. Fresh wrapper objects meant `common` was 0 on every single turn, forcing
 * full O(N) re-canonicalization of the entire session history on every turn.
 *
 * CLASS CLOSED:
 * Stable wrapper reference identity across turns for all message kinds when inputs are
 * unchanged (in both append-only and non-append-only provider paths), with deterministic
 * invalidation whenever pruned content, attribution, text, or roots change so that stale
 * content is never served.
 *
 * GAP LEFT:
 * An external caller that clones the AgentMessage array or mutates arbitrary object fields
 * without updating the observed input fields will bypass or invalidate the memo.
 */

const LONG_ID_1 = "call_11111111111111111111111111111111|fc_111111111111111111111111111111111111";
const LONG_ID_2 = "call_22222222222222222222222222222222|fc_222222222222222222222222222222222222";

function createCanonicalizer(): ProviderContextCanonicalizer {
	let counter = 0;
	return new ProviderContextCanonicalizer(new Map(), () => {
		counter += 1;
		return `tc_${counter}`;
	});
}

function userMessage(text: string, timestamp = 1): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistantCall(id: string, path: string, timestamp = 2): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResult(id: string, text: string, timestamp = 3): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

describe("unchanged provider context prefix is not retransformed across turns", () => {
	it("re-renders only newly appended messages when append-only context is OFF (default provider path)", () => {
		const canonicalizer = createCanonicalizer();
		const roots = ["/workspace"];

		// Turn 1: initial user message, assistant tool call, tool result.
		const u1 = userMessage("read /workspace/src/foo.ts", 100);
		const a1 = assistantCall(LONG_ID_1, "/workspace/src/foo.ts", 200);
		const tr1 = toolResult(LONG_ID_1, "const x = 1;", 300);
		const historyTurn1: AgentMessage[] = [u1, a1, tr1];

		// Non-append-only path: convertToLlm called directly each turn.
		const llmMessagesTurn1 = convertToLlm(historyTurn1);
		const res1 = canonicalizer.transform(llmMessagesTurn1, roots);

		expect(res1.messages).toHaveLength(3);
		expect(canonicalizer.lastTransformedCount).toBe(3);

		// Turn 2: assistant finishes, user sends follow-up.
		const a2 = assistantCall(LONG_ID_2, "/workspace/src/bar.ts", 400);
		const u2 = userMessage("continue with /workspace/src/bar.ts", 500);
		const historyTurn2: AgentMessage[] = [u1, a1, tr1, a2, u2];

		const llmMessagesTurn2 = convertToLlm(historyTurn2);

		// Prior message wrappers must preserve reference identity.
		expect(llmMessagesTurn2[0]).toBe(llmMessagesTurn1[0]);
		expect(llmMessagesTurn2[1]).toBe(llmMessagesTurn1[1]);
		expect(llmMessagesTurn2[2]).toBe(llmMessagesTurn1[2]);

		const res2 = canonicalizer.transform(llmMessagesTurn2, roots);

		expect(res2.messages).toHaveLength(5);
		// Deterministic assertion: only the 2 new messages are processed.
		expect(canonicalizer.lastTransformedCount).toBe(2);
		// Prefix in output matches the exact objects from turn 1.
		expect(res2.messages[0]).toBe(res1.messages[0]);
		expect(res2.messages[1]).toBe(res1.messages[1]);
		expect(res2.messages[2]).toBe(res1.messages[2]);

		// Turn 3: retry/resend with identical messages -> 0 transforms.
		const llmMessagesTurn3 = convertToLlm(historyTurn2);
		const res3 = canonicalizer.transform(llmMessagesTurn3, roots);
		expect(canonicalizer.lastTransformedCount).toBe(0);
		expect(res3.messages).toBe(res2.messages);
	});

	it("re-renders only newly appended messages when append-only context is ON", () => {
		const canonicalizer = createCanonicalizer();
		const roots = ["/workspace"];
		const manager = new AppendOnlyContextManager();

		// Turn 1
		const u1 = userMessage("read /workspace/src/a.ts", 100);
		const a1 = assistantCall(LONG_ID_1, "/workspace/src/a.ts", 200);
		const tr1 = toolResult(LONG_ID_1, "file a", 300);
		const historyTurn1: AgentMessage[] = [u1, a1, tr1];

		const llm1 = convertToLlm(historyTurn1);
		manager.syncMessages(llm1);
		const ctx1 = manager.build(
			{ systemPrompt: ["prompt"], messages: historyTurn1, tools: [] },
			{ intentTracing: false },
		);
		const res1 = canonicalizer.transform(ctx1.messages, roots);

		expect(canonicalizer.lastTransformedCount).toBe(3);

		// Turn 2
		const a2 = assistantCall(LONG_ID_2, "/workspace/src/b.ts", 400);
		const historyTurn2: AgentMessage[] = [u1, a1, tr1, a2];

		const llm2 = convertToLlm(historyTurn2);
		manager.syncMessages(llm2);
		const ctx2 = manager.build(
			{ systemPrompt: ["prompt"], messages: historyTurn2, tools: [] },
			{ intentTracing: false },
		);
		const res2 = canonicalizer.transform(ctx2.messages, roots);

		expect(res2.messages).toHaveLength(4);
		// Deterministic assertion: only the 1 new message is processed.
		expect(canonicalizer.lastTransformedCount).toBe(1);
		expect(res2.messages[0]).toBe(res1.messages[0]);
		expect(res2.messages[1]).toBe(res1.messages[1]);
		expect(res2.messages[2]).toBe(res1.messages[2]);
	});

	it("invalidates cache and re-transforms when tool result is pruned, serving fresh content", () => {
		const canonicalizer = createCanonicalizer();
		const roots = ["/workspace"];

		const u1 = userMessage("read /workspace/big.txt", 100);
		const a1 = assistantCall(LONG_ID_1, "/workspace/big.txt", 200);
		const tr1 = toolResult(LONG_ID_1, "HUGE OUTPUT ".repeat(1000), 300);
		const a2 = assistantCall(LONG_ID_2, "/workspace/next.txt", 400);

		const historyTurn1: AgentMessage[] = [u1, a1, tr1, a2];
		const llm1 = convertToLlm(historyTurn1);
		const res1 = canonicalizer.transform(llm1, roots);
		expect(canonicalizer.lastTransformedCount).toBe(4);

		// Now simulate compaction / pruning: tr1 is pruned in place.
		tr1.prunedAt = 500;
		tr1.content = [{ type: "text", text: "[Output truncated - 5000 tokens]" }];

		const historyTurn2: AgentMessage[] = [u1, a1, tr1, a2, userMessage("next step", 600)];
		const llm2 = convertToLlm(historyTurn2);

		// u1 and a1 retain reference identity, but tr1 gets a fresh wrapper because prunedAt changed.
		expect(llm2[0]).toBe(llm1[0]);
		expect(llm2[1]).toBe(llm1[1]);
		expect(llm2[2]).not.toBe(llm1[2]);

		const res2 = canonicalizer.transform(llm2, roots);

		// Since tr1 at index 2 changed, prefix of length 2 is kept, and indices 2..4 (3 messages) are re-transformed.
		expect(canonicalizer.lastTransformedCount).toBe(3);
		expect(res2.messages[0]).toBe(res1.messages[0]);
		expect(res2.messages[1]).toBe(res1.messages[1]);

		// The pruned content MUST be present in the output (never stale old content).
		const prunedToolResult = res2.messages[2] as ToolResultMessage;
		expect(prunedToolResult.content).toEqual([{ type: "text", text: "[Output truncated - 5000 tokens]" }]);
	});

	it("invalidates cache when message attribution changes", () => {
		const canonicalizer = createCanonicalizer();
		const roots = ["/workspace"];

		const u1: UserMessage = { role: "user", content: "hello", timestamp: 100 };
		const history1: AgentMessage[] = [u1];
		const llm1 = convertToLlm(history1);
		canonicalizer.transform(llm1, roots);
		expect(canonicalizer.lastTransformedCount).toBe(1);

		// Attribution explicitly modified
		u1.attribution = "agent";
		const history2: AgentMessage[] = [u1, userMessage("follow up", 200)];
		const llm2 = convertToLlm(history2);

		expect(llm2[0]).not.toBe(llm1[0]);
		expect((llm2[0] as UserMessage).attribution).toBe("agent");

		canonicalizer.transform(llm2, roots);
		expect(canonicalizer.lastTransformedCount).toBe(2);
	});

	it("preserves reference identity for custom message types and execution outputs", () => {
		const bashMsg: BashExecutionMessage = {
			role: "bashExecution",
			command: "echo test",
			output: "test output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 10,
		};
		const pythonMsg: PythonExecutionMessage = {
			role: "pythonExecution",
			code: "print(1)",
			output: "1",
			cancelled: false,
			truncated: false,
			exitCode: 0,
			timestamp: 20,
		};
		const fileMentionMsg: FileMentionMessage = {
			role: "fileMention",
			files: [{ path: "/workspace/doc.md", content: "notes" }],
			timestamp: 30,
		};
		const branchSummary = createBranchSummaryMessage("branch recap", "msg_1", "2026-08-25T12:00:00Z");
		const compactionSummary = createCompactionSummaryMessage("compaction recap", 1000, "2026-08-25T12:00:00Z");
		const customMsg = createCustomMessage("custom_hook", "payload", true, undefined, "2026-08-25T12:00:00Z");

		const history: AgentMessage[] = [bashMsg, pythonMsg, fileMentionMsg, branchSummary, compactionSummary, customMsg];

		const converted1 = convertToLlm(history);
		const converted2 = convertToLlm(history);

		expect(converted1).toHaveLength(converted2.length);
		for (let i = 0; i < converted1.length; i++) {
			expect(converted2[i]).toBe(converted1[i]);
		}
	});
});
