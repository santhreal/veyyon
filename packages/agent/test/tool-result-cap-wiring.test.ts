import { beforeEach, describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@veyyon/agent-core/types";
import type { Message, ToolResultMessage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { type } from "arktype";
import { __resetToolResultCapReportsForTests, DEFAULT_TOOL_RESULT_MAX_BYTES } from "../src/tool-result-cap";
import { createUserMessage } from "./helpers";

/**
 * The size cap has to be wired into the loop, not merely available to it.
 *
 * `capToolResultContent` is covered as a pure function in
 * `tool-result-cap.test.ts`. That proves the cap is correct; it does not prove
 * anything reaches it. The bug this work fixes was exactly that gap: the cap
 * existed in the coding agent's tool layer and two tools called it, while the
 * agent loop copied `result.content` into the tool result message verbatim, so
 * every tool that did not opt in went to the provider unbounded.
 *
 * These tests drive the real loop with a real tool and read the message that
 * came out of it, because the message is what gets serialised into the next
 * request and persisted to the session.
 */
describe("the agent loop wiring its tool result cap", () => {
	beforeEach(() => {
		__resetToolResultCapReportsForTests();
	});

	function identityConverter(messages: AgentMessage[]): Message[] {
		return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
	}

	const toolSchema = type({ size: "number" });

	/** A tool with no budget of its own, which is the case the cap exists for. */
	function unboundedTool(name: string): AgentTool<typeof toolSchema, { size: number }> {
		return {
			name,
			label: name,
			description: "Returns as much text as it is asked for",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				const line = "x".repeat(63);
				const text = `${Array.from({ length: Math.ceil(params.size / 64) }, () => line).join("\n")}\n`;
				return { content: [{ type: "text", text }], details: { size: params.size } };
			},
		};
	}

	/** Run one tool call through the loop and return the tool result message. */
	async function runToolCall(name: string, size: number): Promise<ToolResultMessage> {
		const tool = unboundedTool(name);
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name, arguments: { size } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// drain
		}
		const messages = await stream.result();
		const toolResult = messages.find(m => m.role === "toolResult");
		if (!toolResult) throw new Error("the loop produced no tool result message");
		return toolResult as ToolResultMessage;
	}

	function textOf(message: ToolResultMessage): string {
		return message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("");
	}

	/**
	 * The core case. A tool returning more than the request budget must not put
	 * that many bytes into the message, whatever the tool itself does.
	 */
	it("caps an unbounded tool's result before it reaches the message", async () => {
		const oversized = DEFAULT_TOOL_RESULT_MAX_BYTES * 2;

		const message = await runToolCall("mcp__scraper__dump", oversized);
		const text = textOf(message);

		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_BYTES);
		expect(text).toContain("B elided…]");
	});

	/**
	 * A tool result that fits must arrive byte-identical. A cap that rewrote
	 * ordinary results would change every transcript in the product to fix a case
	 * that almost never happens.
	 */
	it("leaves a normal tool result byte-identical", async () => {
		const message = await runToolCall("read", 4096);
		const text = textOf(message);

		expect(text).not.toContain("elided");
		// 4096 bytes of 63-char lines plus their newlines.
		expect(Buffer.byteLength(text, "utf-8")).toBe(64 * Math.ceil(4096 / 64));
	});

	/**
	 * The cap sits between the tool and the message, so the loop must not have
	 * already handed the uncapped bytes to something else along the way. The
	 * message is the only thing serialised into the next request, and it is what
	 * this asserts.
	 */
	it("puts the capped text in the message the next request is built from", async () => {
		const message = await runToolCall("mcp__scraper__dump", DEFAULT_TOOL_RESULT_MAX_BYTES * 2);

		const converted = identityConverter([message]);
		expect(converted).toHaveLength(1);
		const serialised = JSON.stringify(converted);
		expect(Buffer.byteLength(serialised, "utf-8")).toBeLessThan(DEFAULT_TOOL_RESULT_MAX_BYTES * 2);
	});
});
