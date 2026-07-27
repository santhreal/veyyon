/**
 * What a host session event looks like by the time a guest receives it.
 *
 * WHY THIS SUITE EXISTS. This is the third door of one defect. The `welcome` header leaked, then the
 * `entry` and `snapshot-chunk` frames leaked, and the `event` frame leaked for exactly the same
 * reason: the host filtered with a type guard, and a type guard narrows the TYPE by its discriminator
 * and leaves the VALUE untouched. A host event satisfied the wire event type while carrying far more,
 * so the compiler had nothing to say.
 *
 * IT WAS ALSO THE WIDEST OF THE THREE. The wire contract declares `agent_end` as `{ type:
 * "agent_end" }` with no payload at all; the host's `agent_end` carries `messages`, the ENTIRE
 * message array of the run, every provider payload inside it included. `turn_end` declares nothing
 * and carries the turn's message plus every tool result. The three message arms carry a full host
 * assistant message, and `message_update` fires once per streaming delta, which makes it the
 * highest-frequency frame in the protocol. All of it crossed a relay somebody else runs and reached
 * read-only viewers who joined through a view link.
 *
 * The cases below assert the payload-free arms really are payload-free, that the message arms go
 * through the SAME projection an entry's message does, and that the host-only fields on the retry
 * and compaction arms are gone. The `tool_execution_*` arms are the deliberate exception and have
 * their own case saying why.
 */

import { describe, expect, it } from "bun:test";
import { fromWireAgentEvent, toWireAgentEvent, WIRE_API_UNREPORTED } from "@veyyon/coding-agent/collab/protocol";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";

/** Keys a projected event may have, so a leak is named rather than counted. */
function keysOf(value: unknown): string[] {
	return Object.keys(value as Record<string, unknown>).sort();
}

/** A host assistant message carrying the fields a guest never renders. */
function hostAssistantMessage(): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-6",
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: { total: 0.001 } },
		stopReason: "stop",
		providerPayload: { raw: { messages: [{ role: "user", content: "secret prompt" }] } },
		request: { temperature: 0.2 },
		turnMetrics: { toolCalls: 3 },
		timestamp: 1_785_000_123_004,
	};
}

describe("the payload-free event arms", () => {
	/**
	 * The single largest leak in the protocol, and the reason this row was worth doing before the
	 * quieter ones. The host's `agent_end` carries `messages`, which is the whole conversation, so
	 * every provider payload and every sampling parameter in the run went out one more time at the
	 * end of it, to every guest.
	 */
	it("strips the entire message array from agent_end", () => {
		const event = {
			type: "agent_end",
			messages: [hostAssistantMessage()],
			telemetry: { totalCost: 1.2 },
			coverage: { tools: 4 },
		} as unknown as AgentSessionEvent;

		const wire = toWireAgentEvent(event);

		expect(wire).toEqual({ type: "agent_end" });
		expect(JSON.stringify(wire)).not.toContain("secret prompt");
	});

	/** `turn_end` is the same shape one level down: the turn's message and every tool result. */
	it("strips the message and tool results from turn_end", () => {
		const event = {
			type: "turn_end",
			message: hostAssistantMessage(),
			toolResults: [{ role: "toolResult", toolCallId: "c1", content: [], isError: false, timestamp: 1 }],
		} as unknown as AgentSessionEvent;

		expect(toWireAgentEvent(event)).toEqual({ type: "turn_end" });
	});

	/** The two lifecycle starts carry nothing on either side, and must stay that way. */
	it("carries the lifecycle starts through unchanged", () => {
		expect(toWireAgentEvent({ type: "agent_start" } as AgentSessionEvent)).toEqual({ type: "agent_start" });
		expect(toWireAgentEvent({ type: "turn_start" } as AgentSessionEvent)).toEqual({ type: "turn_start" });
	});
});

describe("the message event arms", () => {
	/**
	 * The same projection an entry's message goes through, which is the point: one projection per
	 * shape means an entry and an event cannot disagree about what a guest receives for the same
	 * assistant turn. A second copy would drift, and the drift would be invisible because both
	 * sides would still typecheck.
	 */
	it("projects the message the same way a transcript entry does", () => {
		const wire = toWireAgentEvent({
			type: "message_end",
			message: hostAssistantMessage(),
		} as unknown as AgentSessionEvent);
		const message = (wire as unknown as { message: unknown }).message;

		expect(keysOf(message)).toEqual([
			"content",
			"errorMessage",
			"model",
			"provider",
			"role",
			"stopReason",
			"timestamp",
			"usage",
		]);
		expect(JSON.stringify(wire)).not.toContain("secret prompt");
	});

	/**
	 * `message_update` matters most of the three: it fires once per streaming delta, so anything
	 * riding on it is multiplied by the length of the response. The host's own event also carries
	 * `assistantMessageEvent`, the streaming-machinery delta record, which nothing on a guest reads.
	 */
	it("drops the streaming delta record from message_update", () => {
		const wire = toWireAgentEvent({
			type: "message_update",
			message: hostAssistantMessage(),
			assistantMessageEvent: { kind: "text_delta", delta: "d" },
		} as unknown as AgentSessionEvent);

		expect(keysOf(wire)).toEqual(["message", "type"]);
	});

	/** `message_start` takes the same path, so a guest's replica starts from the projected shape. */
	it("projects message_start", () => {
		const wire = toWireAgentEvent({
			type: "message_start",
			message: hostAssistantMessage(),
		} as unknown as AgentSessionEvent);

		expect(keysOf(wire)).toEqual(["message", "type"]);
	});
});

describe("the tool execution arms", () => {
	/**
	 * These pass their payloads through, and that is the CONTRACT rather than an omission worth
	 * fixing. The wire declares `args`, `partialResult` and `result` as `unknown` because a tool's
	 * arguments and result are the tool's own shape and a guest renders them by asking the tool how.
	 * So the tool-result fields a projection would otherwise strip are permitted here. This case
	 * exists so that stays a decision somebody made rather than something a reader assumes is a
	 * fourth instance of the leak.
	 */
	it("passes tool arguments and results through by contract", () => {
		const wire = toWireAgentEvent({
			type: "tool_execution_end",
			toolCallId: "call_1",
			toolName: "read",
			result: { output: "file contents", metrics: { bytes: 4096 } },
			isError: false,
		} as unknown as AgentSessionEvent);

		expect(wire).toEqual({
			type: "tool_execution_end",
			toolCallId: "call_1",
			toolName: "read",
			result: { output: "file contents", metrics: { bytes: 4096 } },
			isError: false,
		});
	});

	/** The start arm keeps `intent`, which is the one-line description a guest shows while it runs. */
	it("keeps the intent on tool_execution_start", () => {
		const wire = toWireAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_2",
			toolName: "bash",
			args: { command: "ls" },
			intent: "list the directory",
		} as unknown as AgentSessionEvent);

		expect(wire).toEqual({
			type: "tool_execution_start",
			toolCallId: "call_2",
			toolName: "bash",
			args: { command: "ls" },
			intent: "list the directory",
		});
	});
});

describe("the compaction and retry arms", () => {
	/**
	 * `result` is the full `CompactionResult`, which holds the generated summary and its accounting.
	 * A guest renders whether compaction happened and whether it will retry, not what it produced,
	 * and the summary arrives separately as a compaction ENTRY when it is persisted.
	 */
	it("drops the compaction result and the engine action", () => {
		const wire = toWireAgentEvent({
			type: "auto_compaction_end",
			action: { kind: "summarize" },
			result: { summary: "the first forty turns", tokensBefore: 128_000 },
			aborted: false,
			willRetry: false,
			skipped: false,
		} as unknown as AgentSessionEvent);

		expect(wire).toEqual({
			type: "auto_compaction_end",
			aborted: false,
			willRetry: false,
			errorMessage: undefined,
			skipped: false,
		});
	});

	/** `errorId` is the host's internal error identity, used to correlate its own logs. */
	it("drops the host error id from auto_retry_start", () => {
		const wire = toWireAgentEvent({
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 5,
			delayMs: 1000,
			errorMessage: "overloaded",
			errorId: 7,
		} as unknown as AgentSessionEvent);

		expect(keysOf(wire)).toEqual(["attempt", "delayMs", "errorMessage", "maxAttempts", "type"]);
	});

	/** `recoveredErrors` is the host's per-attempt record of what it recovered from. */
	it("drops the recovered-error records from auto_retry_end", () => {
		const wire = toWireAgentEvent({
			type: "auto_retry_end",
			success: true,
			attempt: 3,
			recoveredErrors: [{ status: 529, message: "overloaded" }],
		} as unknown as AgentSessionEvent);

		expect(wire).toEqual({ type: "auto_retry_end", success: true, attempt: 3, finalError: undefined });
	});

	/**
	 * A thinking-level change also records the user's selector and what auto mode resolved to. Both
	 * are host state; a guest renders the effective level.
	 */
	it("drops the configured selector and the resolved level", () => {
		const wire = toWireAgentEvent({
			type: "thinking_level_changed",
			thinkingLevel: "high",
			configured: "auto",
			resolved: "high",
		} as unknown as AgentSessionEvent);

		expect(wire).toEqual({ type: "thinking_level_changed", thinkingLevel: "high" });
	});
});

describe("events no guest renders", () => {
	/**
	 * The host's event union is much wider than the wire's, and the extra arms are host machinery:
	 * fallback bookkeeping, TTSR rule firings, todo reminders, goal and cwd changes. They answer
	 * `undefined` rather than travelling, and because the projection IS the filter, an event that
	 * was never projected cannot be broadcast.
	 */
	it("answers undefined for a host-only event type", () => {
		for (const type of [
			"retry_fallback_applied",
			"retry_fallback_succeeded",
			"ttsr_triggered",
			"todo_reminder",
			"todo_auto_clear",
			"irc_message",
			"goal_updated",
			"cwd_changed",
		]) {
			expect(toWireAgentEvent({ type } as unknown as AgentSessionEvent)).toBeUndefined();
		}
	});
});

describe("widening a received event on the guest", () => {
	/**
	 * A guest hands events to a controller typed against the host's own union, so the assistant arms
	 * need an `api` the host no longer sends. It is filled with a marker rather than an endpoint
	 * name: a plausible value would be a fabrication the guest then renders and persists, and the
	 * whole reason the field was dropped is that a guest has no way to know it.
	 */
	it("marks the api as unreported rather than inventing one", () => {
		const wire = toWireAgentEvent({
			type: "message_end",
			message: hostAssistantMessage(),
		} as unknown as AgentSessionEvent);
		if (!wire) throw new Error("expected a projected event");

		const widened = fromWireAgentEvent(wire) as unknown as { message: Record<string, unknown> };

		expect(widened.message.api).toBe(WIRE_API_UNREPORTED);
		expect(WIRE_API_UNREPORTED).toBe("unreported-over-wire");
		expect(widened.message.model).toBe("claude-opus-4-6");
	});

	/** A non-message event is returned as it arrived; there is nothing to widen. */
	it("leaves a payload-free event alone", () => {
		const widened = fromWireAgentEvent({ type: "agent_end" });

		expect(widened).toEqual({ type: "agent_end" } as unknown as AgentSessionEvent);
	});

	/** And a message arm that is not an assistant turn needs no `api` either. */
	it("leaves a non-assistant message event alone", () => {
		const widened = fromWireAgentEvent({
			type: "message_end",
			message: { role: "user", content: "hi", timestamp: 1 },
		});

		expect(keysOf((widened as unknown as { message: unknown }).message)).toEqual(["content", "role", "timestamp"]);
	});
});
