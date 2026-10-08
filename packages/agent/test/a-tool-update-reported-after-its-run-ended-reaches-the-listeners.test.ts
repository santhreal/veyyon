/**
 * WHY: a tool can return while work it started keeps running, and report that work through its
 * update callback after the run that carried the call emitted `agent_end`. A background `task`
 * reports its agents' completion that way. The run's event stream drops every event pushed after
 * `agent_end`, so that completion reached no listener: the call's card stayed "running" for the
 * life of the process, and its rail animation re-rendered the idle transcript fifty times a second.
 *
 * The class closed: every update a tool reports reaches the agent's listeners exactly once and in
 * order with the call's own events, at every point relative to the runs: during the call, after
 * the call returned while its run still streams, after that run ended, while a later run streams,
 * and after the later run ended. An update delivered ahead of its call's `tool_execution_start`
 * finds no card to update, so the order is part of the contract.
 *
 * Not caught: what a host does with the delivered update. The background task card suites own the
 * card's transition to its final state.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentTool, type AgentToolUpdateCallback } from "@veyyon/agent-core";
import { z } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";

const schema = z.object({ job: z.string() });
type Details = { phase: string };

interface Update {
	toolCallId: string;
	toolName: string;
	args: unknown;
}

describe("a tool update reported after its run ended", () => {
	it("reaches the agent's listeners exactly once, in order with its call's events", async () => {
		let report: AgentToolUpdateCallback<Details> | undefined;
		const send = (phase: string): void => {
			if (!report) throw new Error("the tool has not run yet");
			report({ content: [{ type: "text", text: phase }], details: { phase } });
		};
		const background: AgentTool<typeof schema, Details> = {
			name: "background",
			label: "Background",
			description: "Starts work that outlives the call",
			parameters: schema,
			async execute(_toolCallId, _params, _signal, onUpdate) {
				report = onUpdate;
				send("during the call");
				return { content: [{ type: "text", text: "started" }], details: { phase: "started" } };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call-1", name: "background", arguments: { job: "index" } }] },
				() => {
					send("after the call returned");
					return { content: ["started it"] };
				},
				() => {
					send("while a later run streams");
					return { content: ["next answer"] };
				},
			],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [background], messages: [] },
			streamFn: mock.stream,
		});
		const updates: Update[] = [];
		const sequence: string[] = [];
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				sequence.push(`${event.type}:${event.toolCallId}`);
			} else if (event.type === "agent_end") {
				sequence.push(event.type);
			} else if (event.type === "tool_execution_update") {
				const first = event.partialResult.content[0];
				sequence.push(`update:${first?.type === "text" ? first.text : "?"}`);
				updates.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
			}
		});

		await agent.prompt("start the job");
		send("after the run ended");
		await agent.prompt("next question");
		send("after the later run ended");
		unsubscribe();

		expect(sequence).toEqual([
			"tool_execution_start:call-1",
			"update:during the call",
			"tool_execution_end:call-1",
			"update:after the call returned",
			"agent_end",
			"update:after the run ended",
			"update:while a later run streams",
			"agent_end",
			"update:after the later run ended",
		]);
		const call = { toolCallId: "call-1", toolName: "background", args: { job: "index" } };
		expect(updates).toEqual(Array.from({ length: 5 }, () => call));
		expect(mock.calls).toHaveLength(3);
	});
});
