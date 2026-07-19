import { describe, expect, it } from "bun:test";
import { Agent, AgentBusyError, type AgentEvent, AppendOnlyContextManager, ThinkingLevel } from "@veyyon/agent-core";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { createAssistantMessage } from "./helpers";

// Exercises the plain accessor / mutator / queue surface of Agent that the
// behavioral loop tests never touch directly. Every assertion pins an exact
// round-tripped value, not just "does not throw".

describe("Agent — scalar accessors round-trip", () => {
	it("sessionId get/set stores and clears the provider cache key", () => {
		const agent = new Agent();
		expect(agent.sessionId).toBeUndefined();
		agent.sessionId = "sess-42";
		expect(agent.sessionId).toBe("sess-42");
		agent.sessionId = undefined;
		expect(agent.sessionId).toBeUndefined();
	});

	it("promptCacheKey get/set round-trips", () => {
		const agent = new Agent();
		expect(agent.promptCacheKey).toBeUndefined();
		agent.promptCacheKey = "cache-key-1";
		expect(agent.promptCacheKey).toBe("cache-key-1");
	});

	it("temperature get/set round-trips including the zero edge", () => {
		const agent = new Agent();
		expect(agent.temperature).toBeUndefined();
		agent.temperature = 0;
		expect(agent.temperature).toBe(0);
		agent.temperature = 0.7;
		expect(agent.temperature).toBe(0.7);
	});

	it("topP / topK / minP round-trip independently", () => {
		const agent = new Agent();
		agent.topP = 0.9;
		agent.topK = 40;
		agent.minP = 0.05;
		expect(agent.topP).toBe(0.9);
		expect(agent.topK).toBe(40);
		expect(agent.minP).toBe(0.05);
	});

	it("presencePenalty / repetitionPenalty round-trip", () => {
		const agent = new Agent();
		agent.presencePenalty = 0.3;
		agent.repetitionPenalty = 1.1;
		expect(agent.presencePenalty).toBe(0.3);
		expect(agent.repetitionPenalty).toBe(1.1);
	});

	it("serviceTier get/set round-trips a valid tier value", () => {
		const agent = new Agent();
		expect(agent.serviceTier).toBeUndefined();
		agent.serviceTier = "priority";
		expect(agent.serviceTier).toBe("priority");
	});

	it("serviceTierResolver get/set stores the resolver and is invokable", () => {
		const agent = new Agent();
		expect(agent.serviceTierResolver).toBeUndefined();
		const model = createMockModel().model;
		agent.serviceTierResolver = () => "flex";
		expect(agent.serviceTierResolver?.(model)).toBe("flex");
	});

	it("hideThinkingSummary get/set round-trips true and false", () => {
		const agent = new Agent();
		expect(agent.hideThinkingSummary).toBeUndefined();
		agent.hideThinkingSummary = true;
		expect(agent.hideThinkingSummary).toBe(true);
		agent.hideThinkingSummary = false;
		expect(agent.hideThinkingSummary).toBe(false);
	});

	it("maxRetryDelayMs get/set round-trips including the disable-cap zero", () => {
		const agent = new Agent();
		expect(agent.maxRetryDelayMs).toBeUndefined();
		agent.maxRetryDelayMs = 30_000;
		expect(agent.maxRetryDelayMs).toBe(30_000);
		agent.maxRetryDelayMs = 0;
		expect(agent.maxRetryDelayMs).toBe(0);
	});

	it("thinkingBudgets get/set round-trips the budget map", () => {
		const agent = new Agent();
		expect(agent.thinkingBudgets).toBeUndefined();
		const budgets = { low: 1024, high: 8192 };
		agent.thinkingBudgets = budgets;
		expect(agent.thinkingBudgets).toEqual({ low: 1024, high: 8192 });
	});

	it("providerSessionState get/set stores the shared map by identity", () => {
		const agent = new Agent();
		expect(agent.providerSessionState).toBeUndefined();
		const store = new Map<string, { close(): void }>();
		agent.providerSessionState = store;
		expect(agent.providerSessionState).toBe(store);
	});

	it("telemetry get / setTelemetry round-trip and clear", () => {
		const agent = new Agent();
		expect(agent.telemetry).toBeUndefined();
		const telemetry = { enabled: true } as unknown as NonNullable<Agent["telemetry"]>;
		agent.setTelemetry(telemetry);
		expect(agent.telemetry).toBe(telemetry);
		agent.setTelemetry(undefined);
		expect(agent.telemetry).toBeUndefined();
	});

	it("appendOnlyContext get / setAppendOnlyContext round-trip and clear", () => {
		const agent = new Agent();
		expect(agent.appendOnlyContext).toBeUndefined();
		const manager = new AppendOnlyContextManager();
		agent.setAppendOnlyContext(manager);
		expect(agent.appendOnlyContext).toBe(manager);
		agent.setAppendOnlyContext();
		expect(agent.appendOnlyContext).toBeUndefined();
	});
});

describe("Agent — state mutators reach state", () => {
	it("setSystemPrompt normalizes a string to a single-entry array", () => {
		const agent = new Agent();
		agent.setSystemPrompt("only-line");
		expect(agent.state.systemPrompt).toEqual(["only-line"]);
	});

	it("setSystemPrompt keeps an array as-is", () => {
		const agent = new Agent();
		agent.setSystemPrompt(["a", "b"]);
		expect(agent.state.systemPrompt).toEqual(["a", "b"]);
	});

	it("setModel installs the active model", () => {
		const agent = new Agent();
		const model = createMockModel().model;
		agent.setModel(model);
		expect(agent.state.model).toBe(model);
	});

	it("setThinkingLevel and setDisableReasoning reach state", () => {
		const agent = new Agent();
		agent.setThinkingLevel(ThinkingLevel.High);
		expect(agent.state.thinkingLevel).toBe(ThinkingLevel.High);
		agent.setDisableReasoning(true);
		expect(agent.state.disableReasoning).toBe(true);
	});

	it("setTools replaces the active tool list by identity", () => {
		const agent = new Agent();
		const tools = [{ name: "t1" } as never];
		agent.setTools(tools);
		expect(agent.state.tools).toBe(tools);
	});
});

describe("Agent — steering / follow-up / interrupt modes", () => {
	it("steering mode defaults to one-at-a-time and round-trips all", () => {
		const agent = new Agent();
		expect(agent.getSteeringMode()).toBe("one-at-a-time");
		agent.setSteeringMode("all");
		expect(agent.getSteeringMode()).toBe("all");
	});

	it("follow-up mode defaults to one-at-a-time and round-trips all", () => {
		const agent = new Agent();
		expect(agent.getFollowUpMode()).toBe("one-at-a-time");
		agent.setFollowUpMode("all");
		expect(agent.getFollowUpMode()).toBe("all");
	});

	it("interrupt mode defaults to immediate and round-trips wait", () => {
		const agent = new Agent();
		expect(agent.getInterruptMode()).toBe("immediate");
		agent.setInterruptMode("wait");
		expect(agent.getInterruptMode()).toBe("wait");
	});
});

describe("Agent — steering / follow-up queue operations", () => {
	const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
	const contentOf = (m: { role: string }): unknown => ("content" in m ? m.content : undefined);

	it("steer / peekSteeringQueue expose a live non-consuming view in insertion order", () => {
		const agent = new Agent();
		expect(agent.peekSteeringQueue()).toEqual([]);
		agent.steer(user("s1"));
		agent.steer(user("s2"));
		expect(agent.peekSteeringQueue().map(contentOf)).toEqual(["s1", "s2"]);
		// Non-consuming: peeking again returns the same entries.
		expect(agent.peekSteeringQueue().length).toBe(2);
	});

	it("followUp / peekFollowUpQueue expose the pending follow-up view", () => {
		const agent = new Agent();
		expect(agent.peekFollowUpQueue()).toEqual([]);
		agent.followUp(user("f1"));
		expect(agent.peekFollowUpQueue().map(contentOf)).toEqual(["f1"]);
	});

	it("hasQueuedMessages reflects either queue being non-empty", () => {
		const agent = new Agent();
		expect(agent.hasQueuedMessages()).toBe(false);
		agent.steer(user("s"));
		expect(agent.hasQueuedMessages()).toBe(true);
		agent.clearSteeringQueue();
		expect(agent.hasQueuedMessages()).toBe(false);
		agent.followUp(user("f"));
		expect(agent.hasQueuedMessages()).toBe(true);
	});

	it("clearSteeringQueue empties only the steering queue", () => {
		const agent = new Agent();
		agent.steer(user("s"));
		agent.followUp(user("f"));
		agent.clearSteeringQueue();
		expect(agent.peekSteeringQueue()).toEqual([]);
		expect(agent.peekFollowUpQueue().length).toBe(1);
	});

	it("clearFollowUpQueue empties only the follow-up queue", () => {
		const agent = new Agent();
		agent.steer(user("s"));
		agent.followUp(user("f"));
		agent.clearFollowUpQueue();
		expect(agent.peekFollowUpQueue()).toEqual([]);
		expect(agent.peekSteeringQueue().length).toBe(1);
	});

	it("clearAllQueues empties both queues", () => {
		const agent = new Agent();
		agent.steer(user("s"));
		agent.followUp(user("f"));
		agent.clearAllQueues();
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("popLastSteer removes and returns the last steering message (LIFO)", () => {
		const agent = new Agent();
		const s1 = user("s1");
		const s2 = user("s2");
		agent.steer(s1);
		agent.steer(s2);
		expect(agent.popLastSteer()).toBe(s2);
		expect(agent.peekSteeringQueue()).toEqual([s1]);
		expect(agent.popLastSteer()).toBe(s1);
		expect(agent.popLastSteer()).toBeUndefined();
	});

	it("popLastFollowUp removes and returns the last follow-up message (LIFO)", () => {
		const agent = new Agent();
		const f1 = user("f1");
		const f2 = user("f2");
		agent.followUp(f1);
		agent.followUp(f2);
		expect(agent.popLastFollowUp()).toBe(f2);
		expect(agent.peekFollowUpQueue()).toEqual([f1]);
	});

	it("replaceQueues snapshots the provided arrays (external mutation cannot leak in)", () => {
		const agent = new Agent();
		const steering = [user("s")];
		const followUp = [user("f")];
		agent.replaceQueues(steering, followUp);
		steering.push(user("leaked-s"));
		followUp.push(user("leaked-f"));
		expect(agent.peekSteeringQueue().map(contentOf)).toEqual(["s"]);
		expect(agent.peekFollowUpQueue().map(contentOf)).toEqual(["f"]);
	});
});

describe("Agent — emitExternalEvent updates state per event kind", () => {
	it("message_start / message_update set the streaming message", () => {
		const agent = new Agent();
		const message = createAssistantMessage([{ type: "text", text: "streaming" }]);
		agent.emitExternalEvent({ type: "message_start", message });
		expect(agent.state.streamMessage).toBe(message);

		const updated = createAssistantMessage([{ type: "text", text: "streaming more" }]);
		agent.emitExternalEvent({
			type: "message_update",
			message: updated,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " more", partial: updated },
		});
		expect(agent.state.streamMessage).toBe(updated);
	});

	it("message_end clears streamMessage and appends the final message", () => {
		const agent = new Agent();
		const streaming = createAssistantMessage([{ type: "text", text: "partial" }]);
		agent.emitExternalEvent({ type: "message_start", message: streaming });

		const final = createAssistantMessage([{ type: "text", text: "done" }]);
		agent.emitExternalEvent({ type: "message_end", message: final });
		expect(agent.state.streamMessage).toBeNull();
		expect(agent.state.messages[agent.state.messages.length - 1]).toBe(final);
	});

	it("tool_execution_start records the pending tool-call id", () => {
		const agent = new Agent();
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "call-9",
			toolName: "grep",
			args: {},
		});
		expect(agent.state.pendingToolCalls.has("call-9")).toBe(true);
	});

	it("forwards every external event to subscribers", () => {
		const agent = new Agent();
		const seen: AgentEvent["type"][] = [];
		agent.subscribe(e => seen.push(e.type));
		const message = createAssistantMessage([{ type: "text", text: "x" }]);
		agent.emitExternalEvent({ type: "message_start", message });
		agent.emitExternalEvent({ type: "message_end", message });
		expect(seen).toEqual(["message_start", "message_end"]);
	});
});

describe("Agent — listener resilience", () => {
	it("a throwing listener does not stop the other listeners", () => {
		const agent = new Agent();
		const delivered: string[] = [];
		agent.subscribe(() => {
			throw new Error("listener boom");
		});
		agent.subscribe(e => delivered.push(e.type));
		const message = createAssistantMessage([{ type: "text", text: "x" }]);
		expect(() => agent.emitExternalEvent({ type: "message_start", message })).not.toThrow();
		expect(delivered).toEqual(["message_start"]);
	});

	it("a listener returning a rejected promise does not throw synchronously", async () => {
		const agent = new Agent();
		const delivered: string[] = [];
		agent.subscribe(() => Promise.reject(new Error("async boom")));
		agent.subscribe(e => delivered.push(e.type));
		const message = createAssistantMessage([{ type: "text", text: "x" }]);
		expect(() => agent.emitExternalEvent({ type: "message_start", message })).not.toThrow();
		// Let the rejected-promise .catch handler run.
		await Bun.sleep(0);
		expect(delivered).toEqual(["message_start"]);
	});

	it("subscribe returns an unsubscribe that stops further delivery", () => {
		const agent = new Agent();
		const seen: string[] = [];
		const off = agent.subscribe(e => seen.push(e.type));
		const message = createAssistantMessage([{ type: "text", text: "x" }]);
		agent.emitExternalEvent({ type: "message_start", message });
		off();
		agent.emitExternalEvent({ type: "message_start", message });
		expect(seen).toEqual(["message_start"]);
	});
});

describe("Agent — abort and idle", () => {
	it("isAborting is false when no run is streaming", () => {
		const agent = new Agent();
		expect(agent.isAborting).toBe(false);
		agent.abort("stop");
		// No in-flight stream, so aborting the (absent) controller stays false.
		expect(agent.isAborting).toBe(false);
	});

	it("waitForIdle resolves immediately when no prompt is running", async () => {
		const agent = new Agent();
		await expect(agent.waitForIdle()).resolves.toBeUndefined();
	});
});

describe("Agent — all-mode steering dequeue via prompt", () => {
	it("delivers every queued steering message in a single turn in all mode", async () => {
		const mock = createMockModel({ responses: [{ content: ["a1"] }] });
		const agent = new Agent({ streamFn: mock.stream });
		agent.setSteeringMode("all");
		agent.replaceMessages([
			{ role: "user", content: [{ type: "text", text: "init" }], timestamp: 1 },
			createAssistantMessage([{ type: "text", text: "init-response" }]),
		]);
		agent.steer({ role: "user", content: [{ type: "text", text: "S1" }], timestamp: 2 });
		agent.steer({ role: "user", content: [{ type: "text", text: "S2" }], timestamp: 3 });

		await agent.continue();

		// All-mode drains the whole queue at the boundary, so only one model call runs.
		expect(mock.calls.length).toBe(1);
		expect(agent.peekSteeringQueue()).toEqual([]);
		const delivered = agent.state.messages.filter(
			m =>
				m.role === "user" &&
				Array.isArray(m.content) &&
				m.content.some(p => p.type === "text" && /^S[12]$/.test(p.text)),
		);
		expect(delivered.length).toBe(2);
	});
});

describe("Agent — interceptor and hook setters reach the loop config", () => {
	it("setRawSseEventInterceptor forwards the SSE hook by identity to the stream options", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({ initialState: { model: mock.model, messages: [] }, streamFn: mock.stream });
		const onSse = () => {};
		agent.setRawSseEventInterceptor(onSse);
		await agent.prompt("run");
		expect(mock.calls[0]?.options?.onSseEvent).toBe(onSse);
	});

	it("setProviderResponseInterceptor installs an onResponse forwarded to the stream", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({ initialState: { model: mock.model, messages: [] }, streamFn: mock.stream });
		agent.setProviderResponseInterceptor(() => {});
		await agent.prompt("run");
		expect(typeof mock.calls[0]?.options?.onResponse).toBe("function");
	});

	it("setAssistantMessageEventInterceptor forwards the event hook by identity", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({ initialState: { model: mock.model, messages: [] }, streamFn: mock.stream });
		const onEvent = () => {};
		agent.setAssistantMessageEventInterceptor(onEvent);
		await agent.prompt("run");
		const options = mock.calls[0]?.options as Record<string, unknown> | undefined;
		expect(options?.onAssistantMessageEvent).toBe(onEvent);
	});

	it("setOnTurnEnd runs the turn-end hook with the produced messages", async () => {
		const mock = createMockModel({ responses: [{ content: ["answer"] }] });
		const agent = new Agent({ initialState: { model: mock.model, messages: [] }, streamFn: mock.stream });
		let endMessages: unknown;
		agent.setOnTurnEnd(messages => {
			endMessages = messages;
		});
		await agent.prompt("run");
		expect(Array.isArray(endMessages)).toBe(true);
		expect((endMessages as unknown[]).length).toBeGreaterThan(0);
	});

	it("setAsideMessageProvider is polled at the step boundary during a run", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({ initialState: { model: mock.model, messages: [] }, streamFn: mock.stream });
		let polled = false;
		agent.setAsideMessageProvider(() => {
			polled = true;
			return [];
		});
		await agent.prompt("run");
		expect(polled).toBe(true);
	});
});

describe("Agent — busy guard", () => {
	it("rejects a second prompt while a run is already streaming", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({ initialState: { model: mock.model, messages: [] }, streamFn: mock.stream });
		const first = agent.prompt("a");
		// The first run marks the agent streaming synchronously before its first
		// await, so a concurrent prompt trips the busy guard.
		await expect(agent.prompt("b")).rejects.toBeInstanceOf(AgentBusyError);
		await first;
	});

	it("rejects continue() while a run is already streaming", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({ initialState: { model: mock.model, messages: [] }, streamFn: mock.stream });
		const first = agent.prompt("a");
		await expect(agent.continue()).rejects.toBeInstanceOf(AgentBusyError);
		await first;
	});

	it("AgentBusyError carries a stable name and a default guidance message", () => {
		const err = new AgentBusyError();
		expect(err.name).toBe("AgentBusyError");
		expect(err.message).toContain("steer()");
		expect(new AgentBusyError("custom").message).toBe("custom");
	});
});
