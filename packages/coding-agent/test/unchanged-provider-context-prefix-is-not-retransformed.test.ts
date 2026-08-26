import { describe, expect, it } from "bun:test";
import { AppendOnlyContextManager } from "@veyyon/agent-core/append-only-context";
import {
	convertMessageToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "@veyyon/agent-core/compaction/messages";
import { renderToolBatchLedger, TOOL_BATCH_LEDGER_HEADLINE_PREFIX } from "@veyyon/agent-core/tool-batch-ledger";
import type { AgentMessage } from "@veyyon/agent-core/types";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage, UserMessage } from "@veyyon/ai";
import { recordImageDisplay } from "@veyyon/coding-agent/session/image-visibility";
import {
	type BashExecutionMessage,
	convertToLlm,
	type FileMentionMessage,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	type PythonExecutionMessage,
} from "@veyyon/coding-agent/session/messages";
import { ProviderContextCanonicalizer } from "@veyyon/coding-agent/session/provider-context-canonicalizer";
import { TERMINAL } from "@veyyon/tui";

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

	describe("getPrunedToolResultContent and tool result field invalidation", () => {
		it("converts unpruned vs pruned tool result content with image stripping and fallback", () => {
			const sampleImage: ImageContent = {
				type: "image",
				data: "base64data",
				mimeType: "image/png",
			};

			// Core compaction convertMessageToLlm:
			// Case 1: Text + image, unpruned -> keeps both blocks.
			const tr1: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "part 1 " }, sampleImage, { type: "text", text: "part 2" }],
				isError: false,
				timestamp: 100,
			};
			const converted1 = convertMessageToLlm(tr1);
			expect(converted1?.content).toEqual([
				{ type: "text", text: "part 1 " },
				sampleImage,
				{ type: "text", text: "part 2" },
			]);

			// Case 2: Mutating prunedAt (without mutating content array) -> strips images, joins text.
			tr1.prunedAt = 200;
			const converted2 = convertMessageToLlm(tr1);
			expect(converted2).not.toBe(converted1);
			expect(converted2?.content).toEqual([{ type: "text", text: "part 1 part 2" }]);

			// Case 3: Image-only tool result when pruned -> fallback "[Output truncated]".
			const trImageOnly: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_img",
				toolName: "view",
				content: [sampleImage],
				isError: false,
				prunedAt: 300,
				timestamp: 300,
			};
			const convertedImg = convertMessageToLlm(trImageOnly);
			expect(convertedImg?.content).toEqual([{ type: "text", text: "[Output truncated]" }]);

			// Case 4: Un-pruning (prunedAt deleted) -> restores original unpruned content.
			delete tr1.prunedAt;
			const convertedUnpruned = convertMessageToLlm(tr1);
			expect(convertedUnpruned).not.toBe(converted2);
			expect(convertedUnpruned?.content).toEqual([
				{ type: "text", text: "part 1 " },
				sampleImage,
				{ type: "text", text: "part 2" },
			]);
		});

		it("invalidates toolResult memo when isError, toolCallId, or attribution changes", () => {
			const tr: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_a",
				toolName: "bash",
				content: [{ type: "text", text: "command output" }],
				isError: false,
				timestamp: 100,
			};

			const c1 = convertToLlm([tr])[0];

			// isError changes
			tr.isError = true;
			const c2 = convertToLlm([tr])[0] as ToolResultMessage;
			expect(c2).not.toBe(c1);
			expect(c2.isError).toBe(true);

			// toolCallId changes
			tr.toolCallId = "call_b";
			const c3 = convertToLlm([tr])[0] as ToolResultMessage;
			expect(c3).not.toBe(c2);
			expect(c3.toolCallId).toBe("call_b");

			// attribution changes
			tr.attribution = "user";
			const c4 = convertToLlm([tr])[0] as ToolResultMessage;
			expect(c4).not.toBe(c3);
			expect(c4.attribution).toBe("user");
		});
	});

	describe("non-content input invalidation for compaction and developer messages", () => {
		it("invalidates compactionSummary when summary, blocks, images, or providerPayload changes", () => {
			const cs = createCompactionSummaryMessage("initial summary", 500, "2026-08-25T12:00:00Z");
			const c1 = convertToLlm([cs])[0];

			// summary changes
			cs.summary = "revised summary";
			const c2 = convertToLlm([cs])[0];
			expect(c2).not.toBe(c1);

			// blocks change
			cs.blocks = [{ type: "text", text: "block note" }];
			const c3 = convertToLlm([cs])[0];
			expect(c3).not.toBe(c2);

			// images change
			cs.blocks = undefined;
			cs.images = [{ type: "image", data: "data", mimeType: "image/png" }];
			const c4 = convertToLlm([cs])[0];
			expect(c4).not.toBe(c3);

			// providerPayload changes
			cs.providerPayload = { type: "openaiResponsesHistory", items: [] };
			const c5 = convertToLlm([cs])[0];
			expect(c5).not.toBe(c4);
		});

		it("invalidates branchSummary when summary changes", () => {
			const bs = createBranchSummaryMessage("branch 1 summary", "msg_1", "2026-08-25T12:00:00Z");
			const c1 = convertToLlm([bs])[0];

			bs.summary = "branch 1 amended summary";
			const c2 = convertToLlm([bs])[0];
			expect(c2).not.toBe(c1);
		});

		it("invalidates developer message when attribution changes", () => {
			const dev: AgentMessage = { role: "developer", content: "system instructions", timestamp: 100 };
			const c1 = convertToLlm([dev])[0];

			dev.attribution = "user";
			const c2 = convertToLlm([dev])[0] as UserMessage;
			expect(c2).not.toBe(c1);
			expect(c2.attribution).toBe("user");
		});
	});

	describe("execution messages and file mentions invalidation", () => {
		it("handles bashExecution excludeFromContext toggling and field mutations", () => {
			const bash: BashExecutionMessage = {
				role: "bashExecution",
				command: "ls",
				output: "file.txt",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 100,
			};

			const c1 = convertToLlm([bash]);
			expect(c1).toHaveLength(1);

			// excludeFromContext: true drops message
			bash.excludeFromContext = true;
			const c2 = convertToLlm([bash]);
			expect(c2).toHaveLength(0);

			// excludeFromContext: false restores message
			bash.excludeFromContext = false;
			const c3 = convertToLlm([bash]);
			expect(c3).toHaveLength(1);

			// output mutation invalidates
			bash.output = "file.txt\nfile2.txt";
			const c4 = convertToLlm([bash]);
			expect(c4[0]).not.toBe(c3[0]);

			// exitCode mutation invalidates
			bash.exitCode = 1;
			const c5 = convertToLlm([bash]);
			expect(c5[0]).not.toBe(c4[0]);

			// cancelled mutation invalidates
			bash.cancelled = true;
			const c6 = convertToLlm([bash]);
			expect(c6[0]).not.toBe(c5[0]);
		});

		it("handles pythonExecution excludeFromContext toggling and field mutations", () => {
			const py: PythonExecutionMessage = {
				role: "pythonExecution",
				code: "1 + 1",
				output: "2",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 100,
			};

			const c1 = convertToLlm([py]);
			expect(c1).toHaveLength(1);

			py.excludeFromContext = true;
			expect(convertToLlm([py])).toHaveLength(0);

			py.excludeFromContext = false;
			py.output = "3";
			const c2 = convertToLlm([py]);
			expect(c2).toHaveLength(1);
			expect(c2[0]).not.toBe(c1[0]);
		});

		it("handles fileMention files mutation", () => {
			const fm: FileMentionMessage = {
				role: "fileMention",
				files: [{ path: "/workspace/a.ts", content: "export const a = 1;" }],
				timestamp: 100,
			};

			const c1 = convertToLlm([fm]);
			expect(c1).toHaveLength(1);

			fm.files = [{ path: "/workspace/b.ts", content: "export const b = 2;" }];
			const c2 = convertToLlm([fm]);
			expect(c2[0]).not.toBe(c1[0]);
		});
	});

	describe("dynamic context-dependent predicates evaluated before memo", () => {
		it("evaluates expireAnsweredBatchLedger dynamically when assistant responds", () => {
			const canonicalizer = createCanonicalizer();
			const roots = ["/workspace"];

			const ledger = {
				cause: "aborted" as const,
				entries: [{ toolCallId: "c1", toolName: "read", outcome: "ok" as const }],
				completed: 1,
				interrupted: 0,
				dropped: 0,
				omitted: 0,
			};
			const renderedLedger = renderToolBatchLedger(ledger);

			const tr: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: `file content\n\n${renderedLedger}` }],
				isError: false,
				details: { batchLedger: ledger },
				timestamp: 100,
			};

			// Turn 1: Batch not yet answered -> ledger stays in toolResult content
			const historyTurn1: AgentMessage[] = [tr];
			const llm1 = convertToLlm(historyTurn1);
			const content1 = (llm1[0]?.content ?? []) as TextContent[];
			expect(content1[0]?.text).toContain(renderedLedger);

			canonicalizer.transform(llm1, roots);
			expect(canonicalizer.lastTransformedCount).toBe(1);

			// Turn 2: Assistant turn responds -> ledger is dynamically expired and stripped
			const a1 = assistantCall(LONG_ID_1, "/workspace/done.ts", 200);
			const historyTurn2: AgentMessage[] = [tr, a1];
			const llm2 = convertToLlm(historyTurn2);

			// ToolResult must have been re-transformed to stripped form
			expect(llm2[0]).not.toBe(llm1[0]);
			const content2 = (llm2[0]?.content ?? []) as TextContent[];
			expect(content2[0]?.text).toBe("file content");

			// Since index 0 changed, all 2 messages are transformed
			canonicalizer.transform(llm2, roots);
			expect(canonicalizer.lastTransformedCount).toBe(2);
			// Turn 3: Another follow-up turn -> stripped ledger memo is reused across turns
			const u2 = userMessage("next task", 300);
			const historyTurn3: AgentMessage[] = [tr, a1, u2];
			const llm3 = convertToLlm(historyTurn3);

			expect(llm3[0]).toBe(llm2[0]);
			expect(llm3[1]).toBe(llm2[1]);

			canonicalizer.transform(llm3, roots);
			expect(canonicalizer.lastTransformedCount).toBe(1);
		});

		it("evaluates isAnsweredBatchLedgerNotice dynamically when assistant responds", () => {
			const syntheticNotice: UserMessage = {
				role: "user",
				synthetic: true,
				content: `${TOOL_BATCH_LEDGER_HEADLINE_PREFIX} Batch cancelled`,
				timestamp: 100,
			};

			// Turn 1: Unanswered -> notice is included
			const historyTurn1: AgentMessage[] = [syntheticNotice];
			const llm1 = convertToLlm(historyTurn1);
			expect(llm1).toHaveLength(1);

			// Turn 2: Assistant responds -> notice is dropped
			const a1 = assistantCall(LONG_ID_1, "/workspace/done.ts", 200);
			const historyTurn2: AgentMessage[] = [syntheticNotice, a1];
			const llm2 = convertToLlm(historyTurn2);
			expect(llm2).toHaveLength(1);
			expect(llm2[0]?.role).toBe("assistant");
		});

		it("evaluates followedByInterruptedThinking dynamically and strips demoted thinking", () => {
			const assistantWithThinking: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "text", text: "here is the partial answer" },
					{ type: "thinking", thinking: "detailed reasoning..." },
				],
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
				stopReason: "stop",
				timestamp: 100,
			};
			const continuityMsg = createCustomMessage(
				INTERRUPTED_THINKING_MESSAGE_TYPE,
				"reasoning continuity",
				false,
				undefined,
				"2026-08-25T12:00:00Z",
			);
			const historyTurn2: AgentMessage[] = [assistantWithThinking, continuityMsg];
			const llm2 = convertToLlm(historyTurn2);

			expect(llm2[0]).not.toBe(assistantWithThinking);
			expect(llm2[0]?.content).toEqual([{ type: "text", text: "here is the partial answer" }]);

			// Turn 3: Follow-up turn -> stripped assistant message is memoized
			const uFollowup = userMessage("continue", 300);
			const historyTurn3: AgentMessage[] = [assistantWithThinking, continuityMsg, uFollowup];
			const llm3 = convertToLlm(historyTurn3);

			expect(llm3[0]).toBe(llm2[0]);
			expect(llm3[1]).toBe(llm2[1]);
		});

		it("evaluates statePlacedImageVisibility dynamically and reflects image display fallback", () => {
			const originalProtocol = (TERMINAL as { imageProtocol?: string }).imageProtocol;
			try {
				(TERMINAL as { imageProtocol?: string }).imageProtocol = "kitty";

				const sampleImage: ImageContent = {
					type: "image",
					data: "base64png",
					mimeType: "image/png",
				};

				const tr: ToolResultMessage = {
					role: "toolResult",
					toolCallId: "call_img_vis",
					toolName: "capture",
					content: [sampleImage],
					isError: false,
					timestamp: 100,
				};

				// Turn 1: Protocol supported and no fallback recorded -> no visibility notice appended
				const llm1 = convertToLlm([tr]);
				expect(llm1[0]?.content).toEqual([sampleImage]);

				// Turn 2: Block records fallback -> visibility notice appended
				recordImageDisplay("call_img_vis", 0, "over-budget");
				const llm2 = convertToLlm([tr]);
				expect(llm2[0]).not.toBe(llm1[0]);
				const content2 = (llm2[0]?.content ?? []) as (TextContent | ImageContent)[];
				expect(content2[1]?.type).toBe("text");
				expect((content2[1] as TextContent).text).toContain("the session's image budget is full");
				// Turn 3: Unchanged fallback -> memoized stamped message returned
				const llm3 = convertToLlm([tr]);
				expect(llm3[0]).toBe(llm2[0]);
			} finally {
				(TERMINAL as { imageProtocol?: string }).imageProtocol = originalProtocol;
			}
		});
	});
});
