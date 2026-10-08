/**
 * The replay-relevant view of a session message, and the comparison a same-session reload uses to
 * decide whether the conversation it restored differs from the one it replaced.
 *
 * A projection selects the fields a provider replays and leaves every nested value as the message
 * holds it: `Bun.deepEquals` compares nested content structurally, so copying it first only costs
 * an allocation per node of every message on both sides.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { OutputMeta } from "../tools/core/output-notice";

/** The fields of `message` a provider replay depends on. Nested values are the message's own. */
export function projectSessionMessageForProviderReplay(message: AgentMessage): unknown {
	switch (message.role) {
		case "user":
			return {
				role: message.role,
				content: message.content,
				providerPayload: message.providerPayload,
				synthetic: message.synthetic,
				steering: message.steering,
				attribution: message.attribution,
				demotedReasoningSource: message.demotedReasoningSource,
			};
		case "developer":
			return {
				role: message.role,
				content: message.content,
				providerPayload: message.providerPayload,
				attribution: message.attribution,
				demotedReasoningSource: message.demotedReasoningSource,
			};
		case "assistant": {
			const isResponsesFamilyMessage =
				message.api === "openai-responses" || message.api === "openai-codex-responses";
			return {
				role: message.role,
				content:
					isResponsesFamilyMessage && Array.isArray(message.content)
						? message.content.flatMap((block): unknown[] => {
								if (block.type === "thinking") return [];
								if (block.type === "toolCall") {
									return [{ type: block.type, id: block.id, name: block.name, arguments: block.arguments }];
								}
								if (block.type === "text") {
									return [{ type: block.type, text: block.text, textSignature: block.textSignature }];
								}
								return [block];
							})
						: message.content,
				api: message.api,
				provider: message.provider,
				model: message.model,
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				providerPayload: isResponsesFamilyMessage ? undefined : message.providerPayload,
			};
		}
		case "toolResult":
			return {
				role: message.role,
				toolName: message.toolName,
				toolCallId: message.toolCallId,
				isError: message.isError,
				content: message.content,
			};
		case "bashExecution":
			return {
				role: message.role,
				command: message.command,
				output: message.output,
				exitCode: message.exitCode,
				signal: message.signal,
				cancelled: message.cancelled,
				meta: projectExecutionMeta(message.meta),
				excludeFromContext: message.excludeFromContext,
			};
		case "pythonExecution":
			return {
				role: message.role,
				code: message.code,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				meta: projectExecutionMeta(message.meta),
				excludeFromContext: message.excludeFromContext,
			};
		case "custom":
		case "hookMessage":
			return { role: message.role, customType: message.customType, content: message.content };
		case "branchSummary":
			return { role: message.role, summary: message.summary };
		case "compactionSummary":
			return { role: message.role, summary: message.summary, providerPayload: message.providerPayload };
		case "fileMention":
			return {
				role: message.role,
				files: message.files.map(file => ({ path: file.path, content: file.content, image: file.image })),
			};
		default:
			return message;
	}
}

function projectExecutionMeta(meta: OutputMeta | undefined): unknown {
	if (!meta) return undefined;
	return {
		truncation: meta.truncation,
		limits: meta.limits,
		diagnostics: meta.diagnostics
			? { summary: meta.diagnostics.summary, messages: meta.diagnostics.messages }
			: undefined,
	};
}

/**
 * Whether two message lists differ in anything a provider replays. A message object shared by both
 * lists is unchanged by definition and is not projected.
 */
export function didSessionMessagesChange(previous: readonly AgentMessage[], next: readonly AgentMessage[]): boolean {
	if (previous.length !== next.length) return true;
	for (let i = 0; i < previous.length; i++) {
		const before = previous[i]!;
		const after = next[i]!;
		if (before === after) continue;
		if (
			!Bun.deepEquals(projectSessionMessageForProviderReplay(before), projectSessionMessageForProviderReplay(after))
		) {
			return true;
		}
	}
	return false;
}
