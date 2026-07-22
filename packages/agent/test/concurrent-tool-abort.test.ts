import { afterEach, describe, expect, it } from "bun:test";
import { agentLoop, agentPauseGate } from "@veyyon/agent-core";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@veyyon/agent-core/types";
import type { Message } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { type } from "arktype";
import { createUserMessage } from "./helpers";

/**
 * Concurrent tool execution + abort: a mid-run AbortSignal must stop further
 * tools and surface stopReason aborted (or an error tool result), never hang.
 */

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		m => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as Message[];
}

function makeSlowTool(log: string[], delayMs: number): AgentTool {
	const schema = type({ n: "number" });
	const tool: AgentTool<typeof schema, { n: number }> = {
		name: "slow",
		label: "Slow",
		description: "Sleeps then records",
		parameters: schema,
		async execute(_id, params, signal) {
			log.push(`start:${params.n}`);
			const start = performance.now();
			while (performance.now() - start < delayMs) {
				if (signal?.aborted) {
					log.push(`aborted:${params.n}`);
					const err = new Error("aborted");
					(err as Error & { name: string }).name = "AbortError";
					throw err;
				}
				await Bun.sleep(5);
			}
			log.push(`done:${params.n}`);
			return { content: [{ type: "text", text: `ok:${params.n}` }], details: params };
		},
	};
	return tool as AgentTool;
}

describe("agent loop concurrent tools and abort", () => {
	afterEach(() => {
		agentPauseGate.resume();
	});

	it("empty tools array still produces an assistant message", async () => {
		const mock = createMockModel({ responses: [{ content: ["no-tools-reply"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const messages = await agentLoop(
			[createUserMessage("hi")],
			context,
			config,
			undefined,
			mock.stream,
		).result();
		const last = messages[messages.length - 1];
		expect(last.role).toBe("assistant");
		expect(mock.calls.length).toBe(1);
	});

	it("runs a single tool call to completion with exact tool result text", async () => {
		const log: string[] = [];
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "c1",
							name: "slow",
							arguments: { n: 1 },
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["all done"] },
			],
		});
		const context: AgentContext = {
			systemPrompt: ["Test"],
			messages: [],
			tools: [makeSlowTool(log, 10)],
		};
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const messages = await agentLoop(
			[createUserMessage("go")],
			context,
			config,
			undefined,
			mock.stream,
		).result();
		expect(log).toEqual(["start:1", "done:1"]);
		const toolResults = messages.filter(m => m.role === "toolResult");
		expect(toolResults.length).toBe(1);
		const text = (toolResults[0] as { content: Array<{ type: string; text?: string }> }).content
			.map(c => (c.type === "text" ? c.text : ""))
			.join("");
		expect(text).toBe("ok:1");
		const last = messages[messages.length - 1];
		expect(last?.role).toBe("assistant");
	});

	it("abort mid-tool leaves an aborted/error tool path and stops further provider steps", async () => {
		const log: string[] = [];
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "c1",
							name: "slow",
							arguments: { n: 99 },
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["should-not-reach"] },
			],
		});
		const context: AgentContext = {
			systemPrompt: ["Test"],
			messages: [],
			tools: [makeSlowTool(log, 5000)],
		};
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const ac = new AbortController();
		const pending = agentLoop(
			[createUserMessage("go")],
			context,
			config,
			ac.signal,
			mock.stream,
		).result();
		// Wait until the tool has started, then abort.
		const start = performance.now();
		while (!log.includes("start:99") && performance.now() - start < 2000) {
			await Bun.sleep(5);
		}
		expect(log).toContain("start:99");
		ac.abort();
		const messages = await pending;
		expect(log).toContain("aborted:99");
		expect(log).not.toContain("done:99");
		// Second model response must not run after abort.
		const assistantTexts = messages
			.filter(m => m.role === "assistant")
			.flatMap(m =>
				(m as { content: Array<{ type: string; text?: string }> }).content
					.filter(c => c.type === "text")
					.map(c => c.text ?? ""),
			);
		expect(assistantTexts.join("")).not.toContain("should-not-reach");
	});
});
