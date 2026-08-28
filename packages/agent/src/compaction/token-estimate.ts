import type { AssistantMessage } from "@veyyon/ai";
import { stringifyJson } from "@veyyon/utils/json";
import { countTokens } from "../tokenizer";
import type { AgentMessage } from "../types";
import { LEGACY_FRAME_TOKEN_ESTIMATE } from "./legacy-snapcompact-archive";

const IMAGE_TOKEN_ESTIMATE = 1200;

const tokenEstimateCache = new WeakMap<
	AgentMessage,
	{ default?: { value: number; shape: number }; noReasoning?: { value: number; shape: number } }
>();

export function estimateTokens(message: AgentMessage, options?: { excludeEncryptedReasoning?: boolean }): number {
	const slotKey = options?.excludeEncryptedReasoning ? "noReasoning" : "default";
	let shape = 0;
	const shapeExtra = walkCountedFragments(message, options, text => {
		shape = (shape * 31 + text.length) | 0;
	});
	shape = (shape * 31 + shapeExtra) | 0;

	const cached = tokenEstimateCache.get(message);
	const hit = cached?.[slotKey];
	if (hit !== undefined && hit.shape === shape) return hit.value;
	const value = estimateTokensUncached(message, options);
	tokenEstimateCache.set(message, { ...cached, [slotKey]: { value, shape } });
	return value;
}

function estimateTokensUncached(message: AgentMessage, options?: { excludeEncryptedReasoning?: boolean }): number {
	const fragments: string[] = [];
	const extra = walkCountedFragments(message, options, text => {
		fragments.push(text);
	});
	if (fragments.length === 0) return extra;
	return extra + countTokens(fragments);
}

const HOST_ROLE_TEXT_FIELDS: Record<string, readonly string[]> = {
	bashExecution: ["command", "output"],
	pythonExecution: ["code", "output"],
};

function walkCountedFragments(
	message: AgentMessage,
	options: { excludeEncryptedReasoning?: boolean } | undefined,
	sink: (text: string) => void,
): number {
	let extra = 0;
	const hostRole = (message as { role?: string }).role;
	const textFields = hostRole === undefined ? undefined : HOST_ROLE_TEXT_FIELDS[hostRole];
	if (textFields) {
		const record = message as unknown as Record<string, unknown>;
		for (const field of textFields) {
			const value = record[field];
			if (typeof value === "string") sink(value);
		}
		return 0;
	}
	if (hostRole === "fileMention") {
		const files = (message as unknown as { files?: readonly unknown[] }).files;
		for (const entry of files ?? []) {
			const file = entry as { path?: unknown; content?: unknown; image?: unknown };
			if (typeof file.path === "string") sink(file.path);
			if (typeof file.content === "string") sink(file.content);
			if (file.image) extra += IMAGE_TOKEN_ESTIMATE;
		}
		return extra;
	}

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				sink(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						sink(block.text);
					} else if (block.type === "image") {
						extra += IMAGE_TOKEN_ESTIMATE;
					}
				}
			}
			break;
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					sink(block.text);
				} else if (block.type === "thinking") {
					sink(block.thinking);
					if (block.thinkingSignature && !options?.excludeEncryptedReasoning) {
						sink(block.thinkingSignature);
					}
				} else if (block.type === "toolCall") {
					sink(block.name);
					sink(stringifyJson(block.arguments) ?? "null");
				} else if (block.type === "redactedThinking") {
					if (!options?.excludeEncryptedReasoning) sink(block.data);
				}
			}
			break;
		}
		case "developer":
		case "custom":
		case "hookMessage":
		case "toolResult": {
			if (typeof message.content === "string") {
				sink(message.content);
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						sink(block.text);
					} else if (block.type === "image") {
						extra += IMAGE_TOKEN_ESTIMATE;
					}
				}
			}
			break;
		}
		case "branchSummary":
		case "compactionSummary": {
			sink(message.summary);
			if (message.role === "compactionSummary") {
				if (message.blocks) {
					for (const block of message.blocks) {
						if (block.type === "text") sink(block.text);
						else extra += LEGACY_FRAME_TOKEN_ESTIMATE;
					}
				} else if (message.images) {
					extra += message.images.length * LEGACY_FRAME_TOKEN_ESTIMATE;
				}
			}
			break;
		}
		default:
			return 0;
	}

	return extra;
}
