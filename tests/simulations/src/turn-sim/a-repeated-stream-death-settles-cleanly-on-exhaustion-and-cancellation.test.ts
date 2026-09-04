/**
 * Repeated stream death terminates within strict bounds on exhaustion or cancellation,
 * preserving unexecuted tool details and resuming cleanly into a successful turn.
 *
 * WHAT THIS COVERS:
 * 1. Bounded failure loop through retry exhaustion:
 *    A provider repeatedly dying mid-stream retries exactly `maxRetries` times before
 *    persisting the final error and settling. All unexecuted tool calls remain marked
 *    with `executed: false` and `__synthetic: true`. A subsequent prompt on a reopened
 *    session succeeds cleanly against a working provider.
 * 2. Cancellation during backoff:
 *    A provider stream repeatedly dying after streaming tool-call intents is
 *    interrupted during backoff via `abortRetry()`. The session emits
 *    `auto_retry_end` with `finalError: "Retry cancelled"`, leaves no dangling
 *    timers or promises, records `intent` and `executed: false` across all
 *    attempts, and resumes cleanly into a successful prompt.
 */
import { describe, expect, it } from "bun:test";
import type { SyntheticToolResultDetails } from "@veyyon/agent-core";
import * as AIError from "@veyyon/ai/error";
import { TOOL } from "@veyyon/coding-agent/tools/core/builtin-names";
import { createSimulation, type ScriptedTurn, simTool } from "./harness";
import { describeViolations, turnViolations } from "./invariants";

const INCOMPLETE_STREAM_TEXT = "OpenAI completions stream closed before a terminal finish reason was received";
const INCOMPLETE_STREAM_ID = AIError.classify(
	new AIError.ProviderResponseError(INCOMPLETE_STREAM_TEXT, { provider: "openai", kind: "incomplete-stream" }),
);

function getSyntheticDetails(details: unknown): SyntheticToolResultDetails | undefined {
	if (details !== null && typeof details === "object" && "__synthetic" in details) {
		const candidate = details as Record<string, unknown>;
		if (candidate.__synthetic === true) {
			return candidate as unknown as SyntheticToolResultDetails;
		}
	}
	return undefined;
}

describe("repeated stream death exhaustion and cancellation bounds", () => {
	it("bounds repeated stream death through retry exhaustion and resumes into a successful prompt", async () => {
		const MAX_RETRIES = 3;
		const ran: string[] = [];
		const retryStarts: { attempt: number; maxAttempts: number }[] = [];
		const retryEnds: { success: boolean; finalError?: string; attempt?: number }[] = [];

		let providerRecovered = false;
		const failingScript = (turn: ScriptedTurn): void => {
			if (providerRecovered) {
				turn.text("recovered successfully after exhaustion");
				turn.finish();
				return;
			}
			turn.toolCall(TOOL.bash, { command: "echo test" }, `call-exhaust-${turn.call}`, "Execute test command");
			turn.fail(INCOMPLETE_STREAM_TEXT, INCOMPLETE_STREAM_ID);
		};

		const sim = await createSimulation({
			persist: true,
			settings: {
				"retry.maxRetries": MAX_RETRIES,
				"retry.baseDelayMs": 1,
				"retry.maxDelayMs": 1000,
			},
			tools: [
				simTool(TOOL.bash, async () => {
					ran.push("bash");
					return { content: [{ type: "text", text: "bash ran" }] };
				}),
			],
			script: failingScript,
		});

		try {
			sim.session.subscribe(event => {
				if (event.type === "auto_retry_start") {
					retryStarts.push({ attempt: event.attempt, maxAttempts: event.maxAttempts });
				} else if (event.type === "auto_retry_end") {
					retryEnds.push({
						success: event.success,
						finalError: event.finalError,
						attempt: event.attempt,
					});
				}
			});

			await sim.session.prompt("run command repeatedly failing");

			// Exactly 1 initial request + MAX_RETRIES retry attempts = 4 requests
			expect(sim.sessionRequests().length).toBe(MAX_RETRIES + 1);
			expect(ran).toEqual([]);

			// 3 auto_retry_start events: attempts 1, 2, 3
			expect(retryStarts).toEqual([
				{ attempt: 1, maxAttempts: MAX_RETRIES },
				{ attempt: 2, maxAttempts: MAX_RETRIES },
				{ attempt: 3, maxAttempts: MAX_RETRIES },
			]);

			// auto_retry_end emitted on exhaustion
			expect(retryEnds).toHaveLength(1);
			expect(retryEnds[0]?.success).toBe(false);
			expect(retryEnds[0]?.finalError).toBe(INCOMPLETE_STREAM_TEXT);
			expect(retryEnds[0]?.attempt).toBe(MAX_RETRIES);

			// All tool executions ended with executed: false and synthetic tags
			const toolEndEvents = sim.eventsOfType("tool_execution_end");
			expect(toolEndEvents.length).toBe(MAX_RETRIES + 1);
			for (const event of toolEndEvents) {
				const details = getSyntheticDetails(event.result.details);
				expect(details?.__synthetic).toBe(true);
				expect(details?.executed).toBe(false);
				expect(details?.source).toBe("assistant_stop_error");
			}

			// Invariant compliance
			const violations = turnViolations(sim);
			expect(describeViolations("stream-death-exhaustion", violations)).toEqual([]);

			providerRecovered = true;

			// Reopen session and verify subsequent prompt completes cleanly with real output
			const reopened = await sim.reopen();
			try {
				await reopened.session.prompt("recover after exhaustion");
				const assistants = reopened.session.messages.filter(m => m.role === "assistant");
				const lastAssistant = assistants.at(-1);
				expect(lastAssistant).toBeDefined();
				expect(lastAssistant?.stopReason).toBe("stop");
				const textBlocks = lastAssistant?.content.filter(b => b.type === "text") ?? [];
				expect(textBlocks.map(b => (b.type === "text" ? b.text : "")).join("")).toContain(
					"recovered successfully after exhaustion",
				);
				expect(reopened.sessionRequests()).toHaveLength(1);
			} finally {
				await reopened.dispose();
			}
		} finally {
			await sim.dispose();
		}
	});

	it("settles cleanly when repeated stream death is cancelled during backoff and resumes into a successful prompt", async () => {
		const MAX_RETRIES = 10;
		const CANCEL_ON_ATTEMPT = 7;
		const ran: string[] = [];
		const toolStarts: { toolName: string; intent?: string }[] = [];
		const toolEnds: { executed: boolean; synthetic: boolean }[] = [];
		const retryStarts: number[] = [];
		const retryEnds: { success: boolean; finalError?: string; attempt?: number }[] = [];
		let providerRecovered = false;

		const sim = await createSimulation({
			persist: true,
			settings: {
				"retry.maxRetries": MAX_RETRIES,
				"retry.baseDelayMs": 1,
				"retry.maxDelayMs": 1000,
			},
			tools: [
				simTool(TOOL.bash, async () => {
					ran.push("bash");
					return { content: [{ type: "text", text: "bash ran" }] };
				}),
				simTool(TOOL.read, async () => {
					ran.push("read");
					return { content: [{ type: "text", text: "read ran" }] };
				}),
			],
			script: turn => {
				if (providerRecovered) {
					turn.text("recovered successfully after cancellation");
					turn.finish();
					return;
				}
				turn.toolCall(
					TOOL.read,
					{ path: "README.md" },
					`read-call-${turn.call}`,
					"Read repository overview to plan changes",
				);
				turn.toolCall(
					TOOL.bash,
					{ command: "git status" },
					`bash-call-${turn.call}`,
					"Inspect working tree status",
				);
				turn.fail(INCOMPLETE_STREAM_TEXT, INCOMPLETE_STREAM_ID);
			},
		});

		try {
			sim.session.subscribe(event => {
				if (event.type === "auto_retry_start") {
					retryStarts.push(event.attempt);
					if (event.attempt === CANCEL_ON_ATTEMPT) {
						// User cancellation (Escape / abortRetry) during backoff of attempt 7
						queueMicrotask(() => {
							sim.session.abortRetry();
						});
					}
				} else if (event.type === "auto_retry_end") {
					retryEnds.push({
						success: event.success,
						finalError: event.finalError,
						attempt: event.attempt,
					});
				} else if (event.type === "tool_execution_start") {
					toolStarts.push({ toolName: event.toolName, intent: event.intent });
				} else if (event.type === "tool_execution_end") {
					const details = getSyntheticDetails(event.result.details);
					toolEnds.push({
						executed: details?.executed ?? true,
						synthetic: details?.__synthetic ?? false,
					});
				}
			});

			await sim.session.prompt("run multi-tool batch");

			// Exactly CANCEL_ON_ATTEMPT requests made
			expect(sim.sessionRequests().length).toBe(CANCEL_ON_ATTEMPT);
			expect(ran).toEqual([]);

			// Seven retry attempts started
			expect(retryStarts).toEqual([1, 2, 3, 4, 5, 6, 7]);

			// Final error is "Retry cancelled"
			expect(retryEnds).toHaveLength(1);
			expect(retryEnds[0]?.success).toBe(false);
			expect(retryEnds[0]?.attempt).toBe(CANCEL_ON_ATTEMPT);
			expect(retryEnds[0]?.finalError).toBe("Retry cancelled");

			// Every tool execution recorded intent and marked executed: false
			expect(toolStarts.length).toBe(CANCEL_ON_ATTEMPT * 2);
			expect(toolStarts.some(t => t.intent === "Read repository overview to plan changes")).toBe(true);
			expect(toolStarts.some(t => t.intent === "Inspect working tree status")).toBe(true);

			expect(toolEnds.length).toBe(CANCEL_ON_ATTEMPT * 2);
			for (const end of toolEnds) {
				expect(end.executed).toBe(false);
				expect(end.synthetic).toBe(true);
			}

			// Invariant compliance
			const violations = turnViolations(sim);
			expect(describeViolations("seven-attempt-cancellation", violations)).toEqual([]);

			providerRecovered = true;

			// Reopening the session allows subsequent prompt to succeed cleanly
			const reopened = await sim.reopen();
			try {
				await reopened.session.prompt("subsequent prompt after cancellation");
				const assistants = reopened.session.messages.filter(m => m.role === "assistant");
				const lastAssistant = assistants.at(-1);
				expect(lastAssistant).toBeDefined();
				expect(lastAssistant?.stopReason).toBe("stop");
				const textBlocks = lastAssistant?.content.filter(b => b.type === "text") ?? [];
				expect(textBlocks.map(b => (b.type === "text" ? b.text : "")).join("")).toContain(
					"recovered successfully after cancellation",
				);
				expect(reopened.sessionRequests()).toHaveLength(1);
			} finally {
				await reopened.dispose();
			}
		} finally {
			await sim.dispose();
		}
	});
});
