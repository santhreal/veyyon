/**
 * WHY: a tool card started its edit preview -- parsing the call, reading the target and diffing it --
 * the moment the card was built, and a final result never stopped it. A card draws its final result
 * in place of the preview, so that work was never shown. A transcript rebuilt from history builds
 * every card and hands it its result in the same task, so resuming a session read and diffed the
 * current copy of the file behind every historical edit, one preview per edit call.
 *
 * The class closed is "a call that has its final result computes a preview". The suite sweeps every
 * mode `EDIT_MODE_STRATEGIES` declares, so a mode added there turns it red until it resolves through
 * `resolveEditModeForTool`, and covers both ways a final result reaches a card: a rebuilt transcript,
 * where the call and its result arrive in one task, and a live call, whose result lands while its
 * preview is in flight. The controls keep the preview where it is drawn: a rebuilt call with no result
 * yet still previews, and a partial result neither cancels a preview nor stops the next one.
 *
 * What it does not catch: a card sealed without a result and handed new arguments afterwards, which
 * the sealing path stops but does not settle.
 */
import { afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { setTimeout as nextTask } from "node:timers/promises";
import type { AgentMessage, AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { EDIT_MODE_STRATEGIES, type StreamingDiffContext } from "@veyyon/coding-agent/edit/streaming";
import { ChatTranscriptBuilder } from "@veyyon/coding-agent/modes/terminal/components/transcript/chat-transcript-builder";
import { createToolExecutionProducer, resolveEditModeForTool } from "@veyyon/coding-agent/presentation/tool-execution";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { InMemorySnapshotStore } from "@veyyon/hashline";
import type { TUI } from "@veyyon/tui";

const MODES = Object.keys(EDIT_MODE_STRATEGIES) as (keyof typeof EDIT_MODE_STRATEGIES)[];

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The tool a call in `mode` is made to, resolved the way a card resolves it. */
function toolFor(mode: (typeof MODES)[number]): { toolName: string; tool: AgentTool } {
	const toolName = mode === "apply_patch" ? "apply_patch" : "edit";
	const tool = { name: toolName, mode, execute: async () => ({ content: [] }) } as unknown as AgentTool;
	expect(resolveEditModeForTool(toolName, tool)).toBe(mode);
	return { toolName, tool };
}

const ARGS = { path: "src/app.ts", input: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n" };

function call(id: string, toolName: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: toolName, arguments: ARGS }],
		timestamp: 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		stopReason: "toolUse",
		usage,
	};
}

function result(id: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text: "Applied." }],
		isError: false,
		timestamp: 2,
	};
}

/** Every preview `mode` starts, each answered only when the test resolves it. */
function previewsOf(mode: (typeof MODES)[number]) {
	const pending: PromiseWithResolvers<null>[] = [];
	const contexts: StreamingDiffContext[] = [];
	const spy = spyOn(EDIT_MODE_STRATEGIES[mode], "computeDiffPreview").mockImplementation((_args, ctx) => {
		const answer = Promise.withResolvers<null>();
		pending.push(answer);
		contexts.push(ctx);
		return answer.promise;
	});
	return {
		started: () => spy.mock.calls.length,
		contexts,
		answerAll: () => {
			for (const answer of pending) answer.resolve(null);
		},
	};
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	mock.restore();
});

function rebuild(mode: (typeof MODES)[number], messages: AgentMessage[], streaming: boolean): void {
	const { toolName, tool } = toolFor(mode);
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
	const builder = new ChatTranscriptBuilder({
		ui,
		cwd: "/repo",
		requestRender: () => {},
		getTool: name => (name === toolName ? tool : undefined),
		getSnapshots: () => new InMemorySnapshotStore(),
		isStreaming: () => streaming,
	});
	builder.rebuild(messages);
}

describe("a tool call with its result computes no preview", () => {
	describe.each(MODES)("%s", mode => {
		it("starts no preview for a rebuilt call whose result follows it", async () => {
			const previews = previewsOf(mode);
			const { toolName } = toolFor(mode);
			rebuild(mode, [call("call-1", toolName), result("call-1", toolName)], false);
			await nextTask(0);
			expect(previews.started()).toBe(0);
		});

		it("previews a rebuilt call that has no result while the turn is still streaming", async () => {
			const previews = previewsOf(mode);
			const { toolName } = toolFor(mode);
			rebuild(mode, [call("call-1", toolName)], true);
			await nextTask(0);
			expect(previews.started()).toBe(1);
			expect(previews.contexts[0]?.isStreaming).toBe(false);
			previews.answerAll();
		});

		it("cancels the preview in flight when the final result lands and starts no other", async () => {
			const previews = previewsOf(mode);
			const { toolName, tool } = toolFor(mode);
			const producer = createToolExecutionProducer({
				toolName,
				args: ARGS,
				tool,
				toolCallId: "call-1",
				options: { snapshots: new InMemorySnapshotStore() },
				cwd: "/repo",
			});
			await nextTask(0);
			expect(previews.started()).toBe(1);
			expect(previews.contexts[0]?.signal.aborted).toBe(false);

			producer.updateResult({ content: [{ type: "text", text: "Applied." }] });
			expect(previews.contexts[0]?.signal.aborted).toBe(true);
			previews.answerAll();
			await producer.whenSettled();

			producer.updateArgs({ ...ARGS, path: "src/other.ts" });
			producer.setArgsComplete();
			await nextTask(0);
			await producer.whenSettled();
			expect(previews.started()).toBe(1);
		});

		it("keeps previewing through a partial result", async () => {
			const previews = previewsOf(mode);
			const { toolName, tool } = toolFor(mode);
			const producer = createToolExecutionProducer({
				toolName,
				args: ARGS,
				tool,
				toolCallId: "call-1",
				options: { snapshots: new InMemorySnapshotStore() },
				cwd: "/repo",
			});
			await nextTask(0);
			producer.updateResult({ content: [{ type: "text", text: "Applying..." }] }, true);
			expect(previews.contexts[0]?.signal.aborted).toBe(false);

			producer.updateArgs({ ...ARGS, path: "src/other.ts" });
			previews.answerAll();
			await nextTask(0);
			expect(previews.started()).toBe(2);
			previews.answerAll();
			await producer.whenSettled();
		});
	});
});
