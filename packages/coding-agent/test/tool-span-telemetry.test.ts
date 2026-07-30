import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@veyyon/agent-core";
import type { InstrumentationLevel, ToolCallMetrics, ToolResultMessage } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { TOOL_EXECUTION_START_CUSTOM_TYPE } from "@veyyon/coding-agent/session/exit-diagnostics";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";

const fullMetrics: ToolCallMetrics = {
	level: "ultra",
	timeUnit: "ms",
	startedAt: 1_000,
	endedAt: 1_025,
	durationMs: 25,
	status: "ok",
	queuedMs: 4,
	concurrency: "shared",
	batchId: "batch-1",
	batchIndex: 0,
	batchSize: 1,
	resultBytes: 5,
	resultBlocks: 1,
	resultImages: 0,
	resultTokens: 2,
	argsBytes: 20,
	argsHash: "deadbeef",
	interruptible: false,
	signalAborted: false,
};

function toolResult(metrics: ToolCallMetrics): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "hello" }],
		details: {},
		isError: false,
		metrics,
		timestamp: metrics.endedAt,
	};
}

describe("tool-span session persistence", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	function createSession(level: InstrumentationLevel) {
		const agent = new Agent({ initialState: { systemPrompt: ["test"], messages: [], tools: [] } });
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "session.instrumentation": level }),
			modelRegistry: {} as never,
		});
		sessions.push(session);
		return { agent, session, sessionManager };
	}

	it("correlates a persisted start and result and preserves rich span facts", async () => {
		const { agent, session, sessionManager } = createSession("rich");
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "/tmp/example" },
		});
		agent.emitExternalEvent({ type: "message_end", message: toolResult(fullMetrics) });
		await session.waitForIdle();

		const start = sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE);
		const result = sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "toolResult");
		if (start?.type !== "custom") throw new Error("expected tool start entry");
		if (result?.type !== "message" || result.message.role !== "toolResult") {
			throw new Error("expected tool result entry");
		}
		expect(start.data).toMatchObject({ toolCallId: "call-1", toolName: "read" });
		expect(result.message.toolCallId).toBe("call-1");
		expect(result.message.metrics).toMatchObject({
			level: "rich",
			timeUnit: "ms",
			status: "ok",
			queuedMs: 4,
			batchId: "batch-1",
			resultBytes: 5,
			resultTokens: 2,
		});
		expect(result.message.metrics?.argsHash).toBeUndefined();
	});

	it("fails closed and omits verbose fields at lower granularity", async () => {
		const basic = createSession("basic");
		basic.agent.emitExternalEvent({ type: "message_end", message: toolResult(fullMetrics) });
		await basic.session.waitForIdle();
		const basicEntry = basic.sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "toolResult");
		if (basicEntry?.type !== "message" || basicEntry.message.role !== "toolResult") {
			throw new Error("expected basic tool result entry");
		}
		expect(basicEntry.message.metrics).toEqual({
			level: "basic",
			timeUnit: "ms",
			startedAt: 1_000,
			endedAt: 1_025,
			durationMs: 25,
			status: "ok",
		});

		const off = createSession("off");
		off.agent.emitExternalEvent({ type: "message_end", message: toolResult(fullMetrics) });
		await off.session.waitForIdle();
		const offEntry = off.sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "toolResult");
		if (offEntry?.type !== "message" || offEntry.message.role !== "toolResult") {
			throw new Error("expected off tool result entry");
		}
		expect(offEntry.message.metrics).toBeUndefined();
	});

	/**
	 * Raising the setting while a basic turn is in flight cannot retroactively
	 * claim that rich or ultra span fields were captured at dispatch.
	 */
	it("does not upgrade a lower-detail in-flight tool span", async () => {
		const ultra = createSession("ultra");
		ultra.agent.emitExternalEvent({
			type: "message_end",
			message: toolResult({ ...fullMetrics, level: "basic" }),
		});
		await ultra.session.waitForIdle();

		const entry = ultra.sessionManager
			.getEntries()
			.find(candidate => candidate.type === "message" && candidate.message.role === "toolResult");
		if (entry?.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error("expected projected tool result entry");
		}
		expect(entry.message.metrics).toEqual({
			level: "basic",
			timeUnit: "ms",
			startedAt: 1_000,
			endedAt: 1_025,
			durationMs: 25,
			status: "ok",
		});
	});
});
