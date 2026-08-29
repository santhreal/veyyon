import type { AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { CursorMcpCall, CursorShellStreamCallbacks, CursorExecHandlers as ICursorExecHandlers } from "@veyyon/ai";
import { errorMessage, sanitizeText } from "@veyyon/utils";
import type { CursorExecBridgeOptions } from "./cursor-helpers";

import {
	buildToolErrorResult,
	createToolResultMessage,
	decodeMcpArgs,
	decodeToolCallId,
	executeDelete,
	executeTool,
	formatMcpToolErrorMessage,
} from "./cursor-helpers";

export class CursorExecHandlers implements ICursorExecHandlers {
	constructor(private options: CursorExecBridgeOptions) {}

	async read(args: Parameters<NonNullable<ICursorExecHandlers["read"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeTool(this.options, "read", toolCallId, { path: args.path });
		return toolResultMessage;
	}

	async ls(args: Parameters<NonNullable<ICursorExecHandlers["ls"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		// Redirect ls to read tool, which handles directories
		const toolResultMessage = await executeTool(this.options, "read", toolCallId, { path: args.path });
		return toolResultMessage;
	}

	async grep(args: Parameters<NonNullable<ICursorExecHandlers["grep"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const searchPath = args.glob ? `${args.path || "."}/${args.glob}` : args.path || ".";
		const toolResultMessage = await executeTool(this.options, "grep", toolCallId, {
			pattern: args.pattern,
			path: searchPath,
			case: args.caseInsensitive === true ? false : undefined,
		});
		return toolResultMessage;
	}

	async write(args: Parameters<NonNullable<ICursorExecHandlers["write"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const content = args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array());
		const toolResultMessage = await executeTool(this.options, "write", toolCallId, {
			path: args.path,
			content,
		});
		return toolResultMessage;
	}

	async delete(args: Parameters<NonNullable<ICursorExecHandlers["delete"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeDelete(this.options, args.path, toolCallId);
		return toolResultMessage;
	}

	async shell(args: Parameters<NonNullable<ICursorExecHandlers["shell"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const timeoutSeconds = args.timeout && args.timeout > 0 ? args.timeout : undefined;
		const toolResultMessage = await executeTool(this.options, "bash", toolCallId, {
			command: args.command,
			cwd: args.workingDirectory || undefined,
			timeout: timeoutSeconds,
		});
		return toolResultMessage;
	}

	async shellStream(
		args: Parameters<NonNullable<ICursorExecHandlers["shellStream"]>>[0],
		callbacks: CursorShellStreamCallbacks,
	) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolName = "bash";
		const tool = this.options.tools.get(toolName);
		if (!tool) {
			const result = buildToolErrorResult(`Tool "${toolName}" not available`);
			return createToolResultMessage(toolCallId, toolName, result, true);
		}

		const timeoutSeconds = args.timeout && args.timeout > 0 ? args.timeout : undefined;
		const toolArgs: Record<string, unknown> = {
			command: args.command,
			cwd: args.workingDirectory || undefined,
			timeout: timeoutSeconds,
		};

		this.options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args: toolArgs });

		let result: AgentToolResult<unknown>;
		let isError = false;

		let rawText = "";
		let sanitizedRawText = "";
		let streamedSanitizedText = "";
		let canStreamSanitizedDelta = true;
		const onUpdate: AgentToolUpdateCallback<unknown> = partialResult => {
			const newRawText = partialResult.content.map(c => (c.type === "text" ? c.text : "")).join("");
			if (newRawText === rawText) {
				return;
			}
			rawText = newRawText;
			sanitizedRawText = sanitizeText(newRawText);
			const sanitizedPartialResult: AgentToolResult<unknown> = {
				content: [{ type: "text" as const, text: sanitizedRawText }],
				details: partialResult.details,
			};
			this.options.emitEvent?.({
				type: "tool_execution_update",
				toolCallId,
				toolName,
				args: toolArgs,
				partialResult: sanitizedPartialResult,
			});
			if (!canStreamSanitizedDelta) {
				return;
			}
			if (sanitizedRawText.startsWith(streamedSanitizedText)) {
				const sanitizedDelta = sanitizedRawText.slice(streamedSanitizedText.length);
				streamedSanitizedText = sanitizedRawText;
				if (sanitizedDelta) {
					callbacks.onStdout(sanitizedDelta);
				}
				return;
			}
			// Cursor's shell-stream callback is append-only. Once the sanitized snapshot
			// stops being a prefix extension, we can no longer repair the stream safely.
			// Keep emitting full snapshots via tool_execution_update, but stop stdout deltas.
			canStreamSanitizedDelta = false;
		};

		try {
			result = await tool.execute(toolCallId, toolArgs, undefined, onUpdate, this.options.getToolContext?.());
		} catch (error) {
			const message = errorMessage(error);
			result = buildToolErrorResult(message);
			isError = true;
		}
		isError ||= result.isError === true;

		// onUpdate may not fire for every chunk — flush any remaining output
		// from the final result that wasn't already streamed.
		const finalRawText = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
		if (finalRawText !== rawText) {
			rawText = finalRawText;
			sanitizedRawText = sanitizeText(finalRawText);
		}
		if (canStreamSanitizedDelta && sanitizedRawText.startsWith(streamedSanitizedText)) {
			const finalDelta = sanitizedRawText.slice(streamedSanitizedText.length);
			streamedSanitizedText = sanitizedRawText;
			if (finalDelta) {
				callbacks.onStdout(finalDelta);
			}
		}

		const sanitizedFinalResult: AgentToolResult<unknown> = {
			content: result.content.map(c => (c.type === "text" ? { ...c, text: sanitizeText(c.text) } : c)),
			details: result.details,
		};
		this.options.emitEvent?.({
			type: "tool_execution_end",
			toolCallId,
			toolName,
			result: sanitizedFinalResult,
			isError,
		});
		return createToolResultMessage(toolCallId, toolName, result, isError);
	}

	async diagnostics(args: Parameters<NonNullable<ICursorExecHandlers["diagnostics"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeTool(this.options, "lsp", toolCallId, {
			action: "diagnostics",
			file: args.path,
		});
		return toolResultMessage;
	}

	async mcp(call: CursorMcpCall) {
		const toolName = call.toolName || call.name;
		const toolCallId = decodeToolCallId(call.toolCallId);
		const tool = this.options.tools.get(toolName);
		if (!tool) {
			const availableTools = Array.from(this.options.tools.keys()).filter(name => name.startsWith("mcp__"));
			const message = formatMcpToolErrorMessage(toolName, availableTools);
			const result = buildToolErrorResult(message);
			return createToolResultMessage(toolCallId, toolName, result, true);
		}

		const args = Object.keys(call.args ?? {}).length > 0 ? call.args : decodeMcpArgs(call.rawArgs ?? {});
		const toolResultMessage = await executeTool(this.options, toolName, toolCallId, args);
		return toolResultMessage;
	}
}
