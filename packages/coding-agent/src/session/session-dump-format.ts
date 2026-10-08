/**
 * Plain-text / markdown session formatting for `/dump` and `/advisor dump raw`.
 *
 * Renders a prelude (system prompt, model/thinking config, tool inventory)
 * followed by the message history as per-message markdown headings: `## User`,
 * `## Assistant` (with `<thinking>` blocks and `### Tool Call: <name>` + YAML
 * args), `### Tool Result: <name>`, and the execution/summary sections.
 */
import type { AgentMessage, ThinkingLevel } from "@veyyon/agent-core";
import type {
	AssistantMessage,
	ImageContent,
	Model,
	TextContent,
	ToolCall,
	ToolExample,
	ToolResultMessage,
	TSchema,
} from "@veyyon/ai";
import { renderDelimitedThinking, renderToolInventory } from "@veyyon/ai/dialect";
import { agentMessageKind } from "@veyyon/kernel/session/message-kinds";
import { INTENT_FIELD } from "@veyyon/wire";
import { YAML } from "bun";
import type { BashExecutionMessage, PythonExecutionMessage } from "../tools/shell/execution-messages";
import { canonicalizeMessage } from "../utils/thinking-display";
import type {
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
	FileMentionMessage,
	HookMessage,
} from "./messages";

/** Minimal tool shape for dump output (matches AgentTool fields used by formatSessionDumpText). */
export interface SessionDumpToolInfo {
	name: string;
	description: string;
	parameters: unknown;
	examples?: readonly ToolExample[];
}

export interface FormatSessionDumpTextOptions {
	messages: readonly AgentMessage[];
	systemPrompt?: readonly string[] | null;
	model?: Model | null;
	thinkingLevel?: ThinkingLevel | string | null;
	tools?: readonly SessionDumpToolInfo[];
	inlineToolDescriptors?: boolean;
}

interface InventoryTool {
	name: string;
	description: string;
	parameters: TSchema;
	examples?: readonly ToolExample[];
}

function toInventoryTools(tools: readonly SessionDumpToolInfo[]): InventoryTool[] {
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as TSchema,
		examples: tool.examples,
	}));
}

/** System prompt + model/thinking config + tool inventory — shared by both transcript styles. */
function renderDumpHeader(options: FormatSessionDumpTextOptions, inventoryTools: readonly InventoryTool[]): string[] {
	const lines: string[] = [];

	const systemPrompt = options.systemPrompt?.filter(prompt => prompt.length > 0) ?? [];
	if (systemPrompt.length > 0) {
		lines.push("## System Prompt\n");
		for (let index = 0; index < systemPrompt.length; index++) {
			if (systemPrompt.length > 1) {
				lines.push(`### System Prompt ${index + 1}\n`);
			}
			lines.push(systemPrompt[index]);
			lines.push("\n");
		}
	}

	const model = options.model;
	lines.push("## Configuration\n");
	lines.push(`Model: ${model ? `${model.provider}/${model.id}` : "(not selected)"}`);
	lines.push(`Thinking Level: ${options.thinkingLevel ?? ""}`);
	lines.push("\n");

	const hasSystemPromptToolInventory = options.inlineToolDescriptors === true;
	if (inventoryTools.length > 0 && !hasSystemPromptToolInventory) {
		lines.push("## Available Tools\n");
		lines.push(renderToolInventory(inventoryTools, model?.id ?? ""));
		lines.push("\n");
	}

	return lines;
}

/** A message body: a string as it is, text parts as their text, image parts as `[Image]`. */
function appendMessageParts(lines: string[], content: string | readonly (TextContent | ImageContent)[]): void {
	if (typeof content === "string") {
		lines.push(content);
		return;
	}
	for (const part of content) {
		if (part.type === "text") lines.push(part.text);
		else if (part.type === "image") lines.push("[Image]");
	}
}

/** A tool call's heading, its intent as `//` comments, and every other argument as a YAML block. */
function appendToolCall(lines: string[], call: ToolCall): void {
	lines.push(`### Tool Call: ${call.name}`);
	const rawArgs = call.arguments as Record<string, unknown> | undefined;
	if (!rawArgs || typeof rawArgs !== "object") return;
	const intent = rawArgs[INTENT_FIELD];
	if (typeof intent === "string" && intent.trim().length > 0) {
		for (const line of intent.split("\n")) lines.push(`// ${line}`);
	}
	const args: Record<string, unknown> = {};
	let hasArgs = false;
	for (const key in rawArgs) {
		if (key === INTENT_FIELD) continue;
		args[key] = rawArgs[key];
		hasArgs = true;
	}
	if (hasArgs) lines.push("```yaml", YAML.stringify(args, null, 2).trimEnd(), "```\n");
}

function appendAssistant(lines: string[], msg: AssistantMessage): void {
	lines.push("## Assistant\n");
	for (const c of msg.content) {
		if (c.type === "text") {
			lines.push(c.text);
		} else if (c.type === "thinking") {
			const thinking = canonicalizeMessage(c.thinking);
			// Unwrap any literal `<thinking>` envelope already present in the
			// block (e.g. Opus 4.5 — issue #2700) so the dump never nests tags.
			if (thinking.length > 0) lines.push(`${renderDelimitedThinking("<thinking>", "</thinking>", thinking)}\n`);
		} else if (c.type === "toolCall") {
			appendToolCall(lines, c);
		}
	}
	lines.push("");
}

function appendToolResult(lines: string[], msg: ToolResultMessage): void {
	lines.push(`### Tool Result: ${msg.toolName}`);
	if (msg.isError) lines.push("(error)");
	for (const c of msg.content) {
		if (c.type === "text") lines.push("```", c.text, "```");
		else if (c.type === "image") lines.push("[Image output]");
	}
	lines.push("");
}

/** A `!` or `$` run under `heading`, as its shell kind writes it; nothing for one kept out of context. */
function appendExecution<TMessage extends BashExecutionMessage | PythonExecutionMessage>(
	lines: string[],
	heading: string,
	msg: TMessage,
): void {
	if (msg.excludeFromContext) return;
	lines.push(heading, agentMessageKind<TMessage>(msg.role).toText(msg), "\n");
}

function appendFileMention(lines: string[], msg: FileMentionMessage): void {
	lines.push("## File Mention\n");
	for (const file of msg.files) {
		lines.push(`<file path="${file.path}">`);
		// A collab guest holds a replica whose mention bodies were never sent, and saying so
		// beats an empty block that reads like a file with nothing in it.
		if (file.contentNotReplicated) lines.push("[body not replicated to this collab guest]");
		else if (file.content) lines.push(file.content);
		if (file.image) lines.push("[Image attached]");
		lines.push("</file>\n");
	}
	lines.push("\n");
}

/** Append the legacy per-message markdown-heading transcript (the pre-16.x `/dump` body). */
function appendMarkdownTranscript(lines: string[], messages: readonly AgentMessage[]): void {
	for (const msg of messages) {
		switch (msg.role) {
			case "user":
			case "developer":
				lines.push(msg.role === "developer" ? "## Developer\n" : "## User\n");
				appendMessageParts(lines, msg.content);
				lines.push("\n");
				break;
			case "assistant":
				appendAssistant(lines, msg as AssistantMessage);
				break;
			case "toolResult":
				appendToolResult(lines, msg);
				break;
			case "bashExecution":
				appendExecution(lines, "## Bash Execution\n", msg as BashExecutionMessage);
				break;
			case "pythonExecution":
				appendExecution(lines, "## Python Execution\n", msg as PythonExecutionMessage);
				break;
			case "custom":
			case "hookMessage": {
				const customMsg = msg as CustomMessage | HookMessage;
				lines.push(`## ${customMsg.customType}\n`);
				appendMessageParts(lines, customMsg.content);
				lines.push("\n");
				break;
			}
			case "branchSummary": {
				const branchMsg = msg as BranchSummaryMessage;
				lines.push("## Branch Summary\n", `(from branch: ${branchMsg.fromId})\n`, branchMsg.summary, "\n");
				break;
			}
			case "compactionSummary": {
				const compactMsg = msg as CompactionSummaryMessage;
				lines.push(
					"## Compaction Summary\n",
					`(${compactMsg.tokensBefore} tokens before compaction)\n`,
					compactMsg.summary,
					"\n",
				);
				break;
			}
			case "fileMention":
				appendFileMention(lines, msg as FileMentionMessage);
				break;
		}
	}
}

/**
 * Format messages and session metadata as markdown/plain text (same as
 * AgentSession.formatSessionAsText / /dump).
 */
export function formatSessionDumpText(options: FormatSessionDumpTextOptions): string {
	const inventoryTools = toInventoryTools(options.tools ?? []);
	const lines = renderDumpHeader(options, inventoryTools);
	appendMarkdownTranscript(lines, options.messages);
	return lines.join("\n").trim();
}
