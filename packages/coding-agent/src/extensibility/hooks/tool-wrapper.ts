/**
 * Tool wrapper - wraps tools with hook callbacks for interception.
 */
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { Static, TSchema } from "@veyyon/ai";
import { errorMessage } from "@veyyon/utils";
import { normalizeToolEventInput, resolveToolEventInput } from "../tool-event-input";
import { applyToolProxy } from "../tool-proxy";
import type { HookRunner } from "./runner";
import type { ToolCallEventResult, ToolResultEventResult } from "./types";

/**
 * Wraps an AgentTool with hook callbacks for interception.
 *
 * Features:
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 * - Forwards onUpdate callback to wrapped tool for progress streaming
 */
export class HookToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown>
	implements AgentTool<TParameters, TDetails>
{
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private hookRunner: HookRunner,
	) {
		applyToolProxy(tool, this);
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	) {
		// Emit tool_call event - hooks can block execution
		// If hook errors/times out, block by default (fail-safe)
		if (this.hookRunner.hasHandlers("tool_call")) {
			try {
				const callResult = (await this.hookRunner.emitToolCall({
					type: "tool_call",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, params as Record<string, unknown>),
					),
				})) as ToolCallEventResult | undefined;

				if (callResult?.block) {
					// The model reads this. A hook that blocks WITHOUT a reason gives it
					// nothing to act on, so the default has to carry the next step.
					const reason =
						callResult.reason ||
						`A hook blocked this ${this.tool.name} call and gave no reason. Do not retry it; tell the ` +
							"operator which hook is blocking so they can fix or remove it.";
					throw new Error(reason);
				}
			} catch (err) {
				// Hook error or block - throw to mark as error
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(
					`A hook threw a non-error value while vetting this ${this.tool.name} call, so the call was blocked ` +
						`rather than run unchecked: ${String(err)}. Do not retry it; tell the operator that hook is ` +
						"failing.",
				);
			}
		}

		// Execute the actual tool, forwarding onUpdate for progress streaming
		try {
			const result = await this.tool.execute(toolCallId, params, signal, onUpdate, context);

			// Emit tool_result event - hooks can modify the result
			if (this.hookRunner.hasHandlers("tool_result")) {
				const resultResult = (await this.hookRunner.emit({
					type: "tool_result",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, params as Record<string, unknown>),
					),
					content: result.content,
					details: result.details,
					isError: false,
				})) as ToolResultEventResult | undefined;

				// Apply modifications if any
				if (resultResult) {
					return {
						content: resultResult.content ?? result.content,
						details: (resultResult.details ?? result.details) as TDetails,
					};
				}
			}

			return result;
		} catch (err) {
			// Emit tool_result event for errors so hooks can observe failures
			if (this.hookRunner.hasHandlers("tool_result")) {
				await this.hookRunner.emit({
					type: "tool_result",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, params as Record<string, unknown>),
					),
					content: [{ type: "text", text: errorMessage(err) }],
					details: undefined,
					isError: true,
				});
			}
			throw err; // Re-throw original error for agent-loop
		}
	}
}
