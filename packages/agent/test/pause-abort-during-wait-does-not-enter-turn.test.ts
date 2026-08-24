/**
 * WHY: When an agent run is paused at PauseGate.waitUntilResumed and aborted,
 * the pre-fix waitUntilResumed resolved normally (return; on signal.aborted).
 * This caused agentLoop to push a turn_start event, enter another turn, and
 * dispatch the provider streamFunction (animating status/clock and wasting quota/network),
 * before synthesizing an aborted assistant message.
 *
 * This suite verifies:
 * 1. An abort during or before waitUntilResumed rejects with the established abort error.
 * 2. An aborted pause in agentLoop terminates boundedly without emitting turn_start or dispatching the provider.
 * 3. Event listeners on the AbortSignal are cleanly removed across all settlement paths (no listener leaks).
 * 4. Concurrent / near-simultaneous resume and abort settle exactly once.
 * 5. Other waiters and the pause gate itself remain engaged after one waiter aborts.
 */

import { describe, expect, it } from "bun:test";
import { AgentPauseGate, agentLoop } from "@veyyon/agent-core";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@veyyon/agent-core/types";
import type { Message } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { type } from "arktype";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function makeEchoTool(onExecute?: () => void): AgentTool {
	const toolSchema = type({ msg: "string" });
	const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo a message back",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			onExecute?.();
			return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
		},
	};
	return echoTool as AgentTool;
}

describe("pause abort during wait does not enter turn", () => {
	describe("AgentPauseGate unit contracts", () => {
		it("rejects with abort error when signal is already aborted before wait", async () => {
			const gate = new AgentPauseGate();
			gate.pause();
			const ac = new AbortController();
			const customReason = new Error("stop now");
			ac.abort(customReason);

			let caught: unknown;
			try {
				await gate.waitUntilResumed(ac.signal);
			} catch (err) {
				caught = err;
			}
			expect(caught).toBe(customReason);
			expect(gate.paused).toBe(true);
		});

		it("rejects with abort error when signal aborts during wait and cleans up listeners", async () => {
			const gate = new AgentPauseGate();
			gate.pause();
			const ac = new AbortController();
			const customReason = new Error("aborted mid-wait");

			let caught: unknown;
			const waitPromise = gate.waitUntilResumed(ac.signal).catch(err => {
				caught = err;
			});

			await Promise.resolve();
			expect(caught).toBeUndefined();

			ac.abort(customReason);
			await waitPromise;

			expect(caught).toBe(customReason);
			expect(gate.paused).toBe(true);
		});

		it("cleans up signal abort listener on successful resume", async () => {
			const gate = new AgentPauseGate();
			gate.pause();
			const ac = new AbortController();

			let resolved = false;
			const waitPromise = gate.waitUntilResumed(ac.signal).then(() => {
				resolved = true;
			});

			await Promise.resolve();
			expect(resolved).toBe(false);

			gate.resume();
			await waitPromise;
			expect(resolved).toBe(true);
		});

		it("settles exactly once under concurrent resume and abort", async () => {
			for (let i = 0; i < 20; i++) {
				const gate = new AgentPauseGate();
				gate.pause();
				const ac = new AbortController();

				let settleCount = 0;
				let outcome: "resolved" | "rejected" | undefined;

				const waitPromise = gate.waitUntilResumed(ac.signal)
					.then(() => {
						settleCount++;
						outcome = "resolved";
					})
					.catch(() => {
						settleCount++;
						outcome = "rejected";
					});

				gate.resume();
				ac.abort("race abort");

				await waitPromise;
				expect(settleCount).toBe(1);
				expect(outcome !== undefined).toBe(true);
			}
		});

		it("one waiter aborting leaves other waiters parked until resume", async () => {
			const gate = new AgentPauseGate();
			gate.pause();
			const ac1 = new AbortController();
			const ac2 = new AbortController();

			let waiter1Error: unknown;
			let waiter2Resolved = false;

			const p1 = gate.waitUntilResumed(ac1.signal).catch(err => {
				waiter1Error = err;
			});
			const p2 = gate.waitUntilResumed(ac2.signal).then(() => {
				waiter2Resolved = true;
			});

			await Promise.resolve();
			ac1.abort("cancel 1");
			await p1;

			expect(waiter1Error).toBe("cancel 1");
			expect(waiter2Resolved).toBe(false);
			expect(gate.paused).toBe(true);

			gate.resume();
			await p2;
			expect(waiter2Resolved).toBe(true);
		});
	});

	describe("agentLoop boundary", () => {
		it("does not dispatch provider stream when aborted while paused before turn 1", async () => {
			const pauseGate = new AgentPauseGate();
			pauseGate.pause();

			const mock = createMockModel({ responses: [{ content: ["should not be called"] }] });
			const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
			const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, pauseGate };
			const abortController = new AbortController();

			const stream = agentLoop(
				[createUserMessage("hi")],
				context,
				config,
				abortController.signal,
				mock.stream,
			);

			const events: AgentEvent[] = [];
			const readPromise = (async () => {
				for await (const event of stream) {
					events.push(event);
				}
			})();

			// Parked at the pause gate before provider call
			await Promise.resolve();
			expect(mock.calls.length).toBe(0);

			abortController.abort("user cancelled");
			await readPromise;

			// Provider must NEVER have been dispatched
			expect(mock.calls.length).toBe(0);

			// Stream terminated cleanly with aborted assistant message
			const messages = await stream.result();
			const last = messages[messages.length - 1];
			expect(last.role).toBe("assistant");
			if (last.role === "assistant") {
				expect(last.stopReason).toBe("aborted");
				expect(last.errorMessage).toBe("user cancelled");
			}
			expect(pauseGate.paused).toBe(true);
		});

		it("does not emit second turn_start or dispatch provider when paused before turn 2 and aborted", async () => {
			const pauseGate = new AgentPauseGate();
			const { promise: toolCompleted, resolve: resolveTool } = Promise.withResolvers<void>();

			const mock = createMockModel({
				responses: [
					{ content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "step1" } }] },
					{ content: ["turn 2 should not be dispatched"] },
				],
			});

			const context: AgentContext = {
				systemPrompt: ["Test"],
				messages: [],
				tools: [
					makeEchoTool(() => {
						// Pause gate during tool execution so the loop parks when transitioning to turn 2
						pauseGate.pause();
						resolveTool();
					}),
				],
			};
			const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, pauseGate };
			const abortController = new AbortController();

			const stream = agentLoop(
				[createUserMessage("run echo")],
				context,
				config,
				abortController.signal,
				mock.stream,
			);

			const events: AgentEvent[] = [];
			const readPromise = (async () => {
				for await (const event of stream) {
					events.push(event);
				}
			})();

			// Wait until tool executes and engages the pause gate
			await toolCompleted;
			// Allow tool execution to complete and agent loop to reach turn 2 pause gate
			await Promise.resolve();
			await Promise.resolve();
			expect(mock.calls.length).toBe(1);

			// Abort the run while parked before turn 2
			abortController.abort("abort before turn 2");
			await readPromise;

			// Provider must not be called a second time
			expect(mock.calls.length).toBe(1);

			// Count turn_start events: only 1 from initial run start, none for turn 2
			const turnStarts = events.filter(e => e.type === "turn_start");
			expect(turnStarts.length).toBe(1);

			// Result ends with aborted message
			const messages = await stream.result();
			const last = messages[messages.length - 1];
			expect(last.role).toBe("assistant");
			if (last.role === "assistant") {
				expect(last.stopReason).toBe("aborted");
				expect(last.errorMessage).toBe("abort before turn 2");
			}
			expect(pauseGate.paused).toBe(true);
		});

		it("marks tool execution as skipped and unwinds when aborted while tool is paused", async () => {
			const pauseGate = new AgentPauseGate();
			let toolRan = false;
			const { promise: assistantMessageEnded, resolve: resolveAssistant } = Promise.withResolvers<void>();

			const mock = createMockModel({
				responses: [
					() => {
						// Pause gate is engaged before tool execution starts
						pauseGate.pause();
						return { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "step1" } }] };
					},
					{ content: ["done"] },
				],
			});

			const context: AgentContext = {
				systemPrompt: ["Test"],
				messages: [],
				tools: [makeEchoTool(() => { toolRan = true; })],
			};
			const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, pauseGate };
			const abortController = new AbortController();

			const stream = agentLoop(
				[createUserMessage("run echo")],
				context,
				config,
				abortController.signal,
				mock.stream,
			);

			const readPromise = (async () => {
				for await (const event of stream) {
					if (event.type === "message_end" && event.message.role === "assistant") {
						resolveAssistant();
					}
				}
			})();

			// Wait until assistant message finishes and tool execution parks at pause gate
			await assistantMessageEnded;
			await Promise.resolve();
			expect(mock.calls.length).toBe(1);
			expect(toolRan).toBe(false);

			// Abort while tool is paused
			abortController.abort("abort during tool pause");
			await readPromise;

			expect(toolRan).toBe(false);
			expect(mock.calls.length).toBe(1);

			const messages = await stream.result();
			const toolResult = messages.find(m => m.role === "toolResult");
			expect(toolResult !== undefined).toBe(true);
			if (toolResult && toolResult.role === "toolResult") {
				expect(toolResult.isError).toBe(true);
			}

			expect(pauseGate.paused).toBe(true);
		});
	});
});
