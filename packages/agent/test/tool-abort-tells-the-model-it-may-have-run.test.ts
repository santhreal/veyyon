import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@veyyon/agent-core/types";
import type { Message } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { type } from "arktype";
import { createUserMessage } from "./helpers";

/**
 * What the model is told when the operator cancels the run while a tool is running.
 *
 * Pressing Esc is the most common interruption there is: it is what an operator does the
 * moment the agent starts going wrong, which is exactly when the next turn must not act
 * on a false account of what happened. The loop already knew the truth here, and threw it
 * away. `abortedDuringExecution` drives `record.terminalStatus = "aborted"`, and
 * `record.entered` records whether control ever crossed into `tool.execute()`, but the
 * branch that turns those into words was additionally gated on `interruptState.triggered`,
 * which only a STEERING interrupt sets. A plain cancel set neither, so the result fell
 * through to "keep the real result" and the model received the thrown `AbortError`'s own
 * message verbatim: the bare word "aborted".
 *
 * That is the dangerous direction. A `bash` that was mid-migration when the signal landed
 * may have applied part of its work, and "aborted" invites a verbatim retry.
 *
 * These assert the exact result text, because the text IS the contract: it is the whole of
 * what the next turn gets to reason from.
 */
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/**
 * Run one tool call and cancel the run from inside the tool, either before or after the
 * body is considered started. `entered` is the axis under test: the loop sets
 * `record.entered` immediately before `tool.execute()`, so a tool that throws from its own
 * body is always "entered", while a `beforeToolCall` hook that aborts is not.
 */
async function runCancelledCall(where: "inside-execute" | "before-dispatch"): Promise<string> {
	const controller = new AbortController();
	const schema = type({ n: "number" });
	const tool: AgentTool<typeof schema, { n: number }> = {
		name: "migrate",
		label: "Migrate",
		description: "applies migrations",
		parameters: schema,
		async execute(_id, params, signal) {
			if (where === "inside-execute") {
				controller.abort(new Error("Interrupted by user"));
				const error = new Error("aborted");
				error.name = "AbortError";
				throw error;
			}
			if (signal?.aborted) {
				const error = new Error("aborted");
				error.name = "AbortError";
				throw error;
			}
			return { content: [{ type: "text", text: `ok:${params.n}` }], details: params };
		},
	};
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "c1", name: "migrate", arguments: { n: 1 } }], stopReason: "toolUse" },
			{ content: ["done"] },
		],
	});
	const context: AgentContext = { systemPrompt: ["T"], messages: [], tools: [tool as AgentTool] };
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		// Cancelling from the pre-dispatch hook is how an operator aborts while an approval
		// prompt is on screen: the call never reaches `tool.execute()`, so nothing ran.
		beforeToolCall: async () => {
			if (where === "before-dispatch") controller.abort(new Error("Interrupted by user"));
			return undefined;
		},
	};
	const messages = await agentLoop([createUserMessage("go")], context, config, controller.signal, mock.stream)
		.result()
		.catch(() => [] as AgentMessage[]);
	const toolResult = messages.find(m => m.role === "toolResult");
	if (!toolResult) throw new Error("no toolResult message was produced");
	const first = toolResult.content[0];
	if (first?.type !== "text") throw new Error("toolResult did not lead with text");
	return first.text;
}

describe("a cancelled run tells the model whether the tool may have run", () => {
	/**
	 * The dangerous case. The tool body was executing, so side effects may be partial and
	 * the advice must be a state check rather than a retry.
	 */
	it("warns about partial side effects when the tool body was already running", async () => {
		expect(await runCancelledCall("inside-execute")).toBe(
			"Skipped due to the run being cancelled. Do not count this skipped result as completed work or verification. " +
				"This tool had already started running when the run was cancelled, so it may have applied partial side effects. " +
				"Check state before assuming it did or did not take effect.",
		);
	});

	/**
	 * The safe case, and the reason the two must not share one message: a call cancelled
	 * before dispatch applied nothing, and saying "may have applied partial side effects"
	 * there would make the warning noise the model learns to ignore.
	 */
	it("states that nothing was applied when the cancel landed before dispatch", async () => {
		expect(await runCancelledCall("before-dispatch")).toBe(
			"Skipped due to the run being cancelled. Do not count this skipped result as completed work or verification. " +
				"It never started, so nothing was applied.",
		);
	});
});
