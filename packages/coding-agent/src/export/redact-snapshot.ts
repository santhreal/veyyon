/**
 * Redaction for a session snapshot on its way off the machine.
 *
 * Two egress paths carry the same transcript out: `/share`, which seals and uploads it, and
 * `/export`, which writes a self-contained HTML file the operator may attach to a bug report.
 * They share this walk so a secret cannot be scrubbed on one and shipped verbatim on the other.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@veyyon/ai";
import { obfuscateToolArguments, type SecretObfuscator } from "../secrets/obfuscator";
import type { SessionEntry, SessionHeader } from "../session/session-entries";
import type { OutputMeta } from "../tools/output-meta";
import type { SessionData, SubSession } from "./html";

function redactShareHeader(o: SecretObfuscator, header: SessionHeader | null): SessionHeader | null {
	if (!header) return header;
	return {
		...header,
		title: header.title === undefined ? undefined : o.obfuscate(header.title),
		cwd: o.obfuscate(header.cwd),
	};
}

/**
 * Redact secrets from a session snapshot. The blob leaves the machine, so every text-bearing
 * field is rewritten through the obfuscator. The walk is typed end-to-end (no generic object
 * traversal): inline image bytes are left intact (the share path size-trims them separately) and
 * opaque, untyped payloads we cannot redact field-by-field (`compaction.preserveData`, extension
 * `details`/`data`, `mode_change.data`, structured output schemas) are dropped so they cannot
 * leak.
 */
export function redactSessionDataForShare(o: SecretObfuscator, data: SessionData): SessionData {
	return {
		...data,
		header: redactShareHeader(o, data.header),
		systemPrompt: data.systemPrompt === undefined ? undefined : o.obfuscate(data.systemPrompt),
		tools: data.tools?.map(tool => ({ ...tool, description: o.obfuscate(tool.description) })),
		entries: data.entries.map(entry => redactShareEntry(o, entry)),
		subSessions: data.subSessions
			? Object.fromEntries(
					Object.entries(data.subSessions).map(([key, sub]) => [key, redactShareSubSession(o, sub)]),
				)
			: data.subSessions,
	};
}

function redactShareSubSession(o: SecretObfuscator, sub: SubSession): SubSession {
	return {
		...sub,
		header: redactShareHeader(o, sub.header),
		entries: sub.entries.map(entry => redactShareEntry(o, entry)),
	};
}

function redactShareEntry(o: SecretObfuscator, entry: SessionEntry): SessionEntry {
	switch (entry.type) {
		case "message":
			return { ...entry, message: redactShareMessage(o, entry.message) };
		case "compaction":
			return {
				...entry,
				summary: o.obfuscate(entry.summary),
				shortSummary: entry.shortSummary === undefined ? undefined : o.obfuscate(entry.shortSummary),
				details: undefined,
				preserveData: undefined,
			};
		case "branch_summary":
			return { ...entry, summary: o.obfuscate(entry.summary), details: undefined };
		case "custom_message":
			return { ...entry, content: redactShareContent(o, entry.content), details: undefined };
		case "custom":
			return { ...entry, data: undefined };
		case "mode_change":
			return { ...entry, data: undefined };
		case "session_init":
			return {
				...entry,
				systemPrompt: o.obfuscate(entry.systemPrompt),
				task: o.obfuscate(entry.task),
				outputSchema: undefined,
			};
		case "label":
			return { ...entry, label: entry.label === undefined ? undefined : o.obfuscate(entry.label) };
		default:
			return entry;
	}
}

function redactShareContent(
	o: SecretObfuscator,
	content: string | (TextContent | ImageContent)[],
): string | (TextContent | ImageContent)[] {
	if (typeof content === "string") return o.obfuscate(content);
	return content.map(block => (block.type === "text" ? { ...block, text: o.obfuscate(block.text) } : block));
}

/** Redact freeform strings in tool output metadata (source path/URL, diagnostics); numeric truncation info is preserved. */
function redactShareOutputMeta(o: SecretObfuscator, meta: OutputMeta | undefined): OutputMeta | undefined {
	if (!meta) return meta;
	return {
		...meta,
		source: meta.source ? { ...meta.source, value: o.obfuscate(meta.source.value) } : meta.source,
		diagnostics: meta.diagnostics
			? {
					summary: o.obfuscate(meta.diagnostics.summary),
					messages: meta.diagnostics.messages.map(message => o.obfuscate(message)),
				}
			: meta.diagnostics,
	};
}

function redactShareMessage(o: SecretObfuscator, message: AgentMessage): AgentMessage {
	switch (message.role) {
		case "user":
		case "developer":
			return {
				...message,
				providerPayload: undefined,
				content: redactShareContent(o, message.content),
			} as AgentMessage;
		case "custom":
		case "hookMessage":
			return { ...message, details: undefined, content: redactShareContent(o, message.content) } as AgentMessage;
		case "toolResult":
			return {
				...message,
				details: undefined,
				content: redactShareContent(o, message.content) as (TextContent | ImageContent)[],
			};
		case "assistant":
			// Drop opaque provider-replay state (encrypted reasoning / native history) the viewer
			// never reads and we cannot redact field-by-field: `providerPayload` and any
			// `redactedThinking` blocks.
			return {
				...message,
				providerPayload: undefined,
				errorMessage: message.errorMessage === undefined ? undefined : o.obfuscate(message.errorMessage),
				content: message.content.flatMap((block): AssistantMessage["content"] => {
					if (block.type === "redactedThinking") return [];
					if (block.type === "text") return [{ ...block, text: o.obfuscate(block.text) }];
					if (block.type === "thinking") return [{ ...block, thinking: o.obfuscate(block.thinking) }];
					if (block.type === "toolCall") {
						return [
							{
								...block,
								arguments: obfuscateToolArguments(o, block.arguments),
								intent: block.intent === undefined ? undefined : o.obfuscate(block.intent),
								rawBlock: block.rawBlock === undefined ? undefined : o.obfuscate(block.rawBlock),
							},
						];
					}
					return [block];
				}),
			};
		case "bashExecution":
			return {
				...message,
				command: o.obfuscate(message.command),
				output: o.obfuscate(message.output),
				meta: redactShareOutputMeta(o, message.meta),
			};
		case "pythonExecution":
			return {
				...message,
				code: o.obfuscate(message.code),
				output: o.obfuscate(message.output),
				meta: redactShareOutputMeta(o, message.meta),
			};
		case "branchSummary":
			return { ...message, summary: o.obfuscate(message.summary) };
		case "compactionSummary":
			return {
				...message,
				providerPayload: undefined,
				summary: o.obfuscate(message.summary),
				shortSummary: message.shortSummary === undefined ? undefined : o.obfuscate(message.shortSummary),
				blocks:
					message.blocks === undefined
						? undefined
						: (redactShareContent(o, message.blocks) as (TextContent | ImageContent)[]),
			};
		case "fileMention":
			return {
				...message,
				files: message.files.map(file => ({
					...file,
					path: o.obfuscate(file.path),
					content: o.obfuscate(file.content),
				})),
			};
		default:
			return message;
	}
}
