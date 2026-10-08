/**
 * A message queued with `agent.steer()` while a tool batch runs cuts the batch
 * short, and the placeholder for each skipped call states who queued it: a
 * user message is `user`; a user message attributed to an agent, or a custom
 * message, is `system`. With nothing queued, the batch runs to the end.
 *
 * This drives the agent's own queue summary through a real run. The wording
 * each source produces is covered at the loop level in agent-loop.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import { z } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";

const echoSchema = z.object({ value: z.string() });

type ToolEnd = Extract<AgentEvent, { type: "tool_execution_end" }>;

interface BatchOutcome {
	executed: string[];
	ends: ToolEnd[];
}

/** Runs one assistant turn with two exclusive calls; `steer` is queued while the first one executes. */
async function runBatch(steer: AgentMessage | undefined): Promise<BatchOutcome> {
	const executed: string[] = [];
	const mock = createMockModel({
		responses: [
			{
				content: [
					{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "first" } },
					{ type: "toolCall", id: "call-2", name: "echo", arguments: { value: "second" } },
				],
			},
		],
		handler: { content: ["done"] },
	});
	let agent: Agent | undefined;
	const echo: AgentTool<typeof echoSchema, { value: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: echoSchema,
		concurrency: "exclusive",
		async execute(_toolCallId, params) {
			executed.push(params.value);
			if (params.value === "first" && steer) agent?.steer(steer);
			return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
		},
	};
	agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [echo], messages: [] },
		streamFn: mock.stream,
	});
	const ends: ToolEnd[] = [];
	agent.subscribe(event => {
		if (event.type === "tool_execution_end") ends.push(event);
	});
	await agent.prompt("go");
	return { executed, ends };
}

/** The details of the skipped second call's placeholder. */
function skippedDetails(outcome: BatchOutcome): unknown {
	const second = outcome.ends.find(end => end.toolCallId === "call-2");
	if (!second) throw new Error("call-2 never ended");
	expect(second.isError).toBe(true);
	return second.result.details;
}

describe("a steering interrupt is worded for whoever queued it", () => {
	it("runs the whole batch when nothing is queued", async () => {
		const outcome = await runBatch(undefined);
		expect(outcome.executed).toEqual(["first", "second"]);
		expect(outcome.ends.map(end => end.isError)).toEqual([false, false]);
	});

	it("names the user for a user message", async () => {
		const outcome = await runBatch({ role: "user", content: "stop there", timestamp: Date.now() });
		expect(outcome.executed).toEqual(["first"]);
		expect(skippedDetails(outcome)).toMatchObject({ __skipped: true, source: "user" });
	});

	it("names the system for a user message an agent queued", async () => {
		const outcome = await runBatch({
			role: "user",
			content: "peer note",
			attribution: "agent",
			timestamp: Date.now(),
		});
		expect(outcome.executed).toEqual(["first"]);
		expect(skippedDetails(outcome)).toMatchObject({ __skipped: true, source: "system" });
	});

	it("names the system for a custom message", async () => {
		const outcome = await runBatch({
			role: "custom",
			customType: "advisor",
			content: "pause before continuing",
			display: true,
			timestamp: Date.now(),
		});
		expect(outcome.executed).toEqual(["first"]);
		expect(skippedDetails(outcome)).toMatchObject({ __skipped: true, source: "system" });
	});
});
