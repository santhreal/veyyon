/**
 * A fabricated tool result cancels the provider call that wrote it, unless the config says to drain that call.
 *
 * WHY. Under owned (in-band) tool calling a model can keep writing past its tool call and invent the tool's output.
 * With `abortOnFabricatedToolResult` unset or true, the loop cancels that provider request at the fabrication
 * boundary so the provider stops generating a tail nobody keeps. A cancel that does not reach the signal the provider
 * was handed leaves the request running to its end, and the fabricated tail is generated and billed.
 *
 * CLASS. Each setting of `abortOnFabricatedToolResult` (unset, true, false), with and without a run abort signal: the
 * signal the fabricating call received is aborted exactly when the setting is not false, the next call's signal and
 * the run's own signal are not, the tool call written before the boundary runs, and the fabricated output reaches
 * neither the committed message nor the tool result.
 *
 * GAP. The scan that finds the fabrication boundary is covered per dialect by the owned-stream suites in `@veyyon/ai`;
 * this suite drives the `glm` dialect only.
 */
import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@veyyon/agent-core/types";
import type { Message } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { type } from "arktype";
import { createUserMessage } from "./helpers";

const TOOL_CALL_TEXT = "<tool_call>echo\n<arg_key>msg</arg_key>\n<arg_value>hi</arg_value>\n</tool_call>\n";
const FABRICATED = "FABRICATED RESULT";
const FABRICATION_TEXT = `<tool_response>\n${FABRICATED}\n</tool_response>`;

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** The text an assistant message or a tool result carries; other messages carry none this suite reads. */
function textOf(message: AgentMessage): string {
	if (message.role !== "assistant" && message.role !== "toolResult") return "";
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

const SETTINGS = [undefined, true, false] as const;

describe("a fabricated tool result cancels the provider call that wrote it", () => {
	for (const setting of SETTINGS) {
		for (const runSignal of [false, true]) {
			const label = `abortOnFabricatedToolResult=${String(setting)}, ${runSignal ? "with" : "without"} a run signal`;
			it(label, async () => {
				const echoSchema = type({ msg: "string" });
				const ranWith: string[] = [];
				const echoTool: AgentTool<typeof echoSchema, { msg: string }> = {
					name: "echo",
					label: "Echo",
					description: "Echo a message back",
					parameters: echoSchema,
					async execute(_toolCallId, params) {
						ranWith.push(params.msg);
						return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
					},
				};
				const callSignals: (AbortSignal | undefined)[] = [];
				const mock = createMockModel({
					responses: [
						(_context, options) => {
							callSignals.push(options?.signal);
							return { content: [`${TOOL_CALL_TEXT}${FABRICATION_TEXT}`] };
						},
						(_context, options) => {
							callSignals.push(options?.signal);
							return { content: ["all done"] };
						},
					],
				});
				const controller = new AbortController();
				const config: AgentLoopConfig = {
					model: mock.model,
					convertToLlm: identityConverter,
					dialect: "glm",
					abortOnFabricatedToolResult: setting,
				};
				const context: AgentContext = { systemPrompt: [""], messages: [], tools: [echoTool] };
				const committed = await agentLoop(
					[createUserMessage("go")],
					context,
					config,
					runSignal ? controller.signal : undefined,
					mock.stream,
				).result();

				expect(callSignals.map(signal => signal?.aborted === true)).toEqual([setting !== false, false]);
				expect(controller.signal.aborted).toBe(false);
				expect(ranWith).toEqual(["hi"]);
				const toolResult = committed.find(m => m.role === "toolResult");
				expect(toolResult && textOf(toolResult)).toBe("echoed:hi");
				for (const message of committed) expect(textOf(message)).not.toContain(FABRICATED);
			});
		}
	}
});
