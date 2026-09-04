import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import {
	type CustomMessage,
	convertToLlm,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	replaceLlmImagesWithText,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
	sanitizeRehydratedOpenAIResponsesAssistantMessage,
} from "./messages";

function customMessage(customType: string, attribution: "agent" | "user"): CustomMessage<SkillPromptDetails> {
	return {
		role: "custom",
		customType,
		content: "Use this skill.",
		display: true,
		details: { name: "atomic-commit", path: "/tmp/SKILL.md", lineCount: 1 },
		attribution,
		timestamp: 1,
	};
}

const interruptedUsage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function abortedAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: interruptedUsage,
		stopReason: "aborted",
		timestamp: 1,
	};
}

function interruptedThinkingContinuity(): CustomMessage {
	return {
		role: "custom",
		customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
		content: "preserved reasoning",
		display: false,
		attribution: "agent",
		timestamp: 2,
	};
}

describe("convertToLlm", () => {
	it("presents user-invoked skill prompts as user turns", () => {
		const [message] = convertToLlm([customMessage(SKILL_PROMPT_MESSAGE_TYPE, "user")]);

		expect(message?.role).toBe("user");
		if (message?.role !== "user") {
			throw new Error(`Expected user role, received ${message?.role ?? "none"}`);
		}
		expect(message.attribution).toBe("user");
	});

	it("keeps auto-applied skill prompts and other custom messages as developer turns", () => {
		const [autoSkill, otherCustom] = convertToLlm([
			customMessage(SKILL_PROMPT_MESSAGE_TYPE, "agent"),
			customMessage("extension-note", "user"),
		]);

		expect(autoSkill?.role).toBe("developer");
		expect(otherCustom?.role).toBe("developer");
	});

	it("strips the demoted trailing thinking run from the assistant LLM view when its continuity message follows", () => {
		const messages: AgentMessage[] = [
			abortedAssistant([
				{ type: "text", text: "partial answer" },
				{ type: "thinking", thinking: "interrupted reasoning" },
			]),
			interruptedThinkingContinuity(),
		];

		const llm = convertToLlm(messages);
		const assistant = llm.find(entry => entry.role === "assistant");
		expect(Array.isArray(assistant?.content) && assistant.content.map(block => block.type)).toEqual(["text"]);
		expect(llm.some(entry => entry.role === "developer")).toBe(true);
	});

	it("keeps trailing thinking on the assistant LLM view when no continuity message follows", () => {
		const messages: AgentMessage[] = [
			abortedAssistant([
				{ type: "text", text: "partial answer" },
				{ type: "thinking", thinking: "interrupted reasoning" },
			]),
		];

		const llm = convertToLlm(messages);
		const assistant = llm.find(entry => entry.role === "assistant");
		expect(Array.isArray(assistant?.content) && assistant.content.map(block => block.type)).toEqual([
			"text",
			"thinking",
		]);
	});

	it("keeps a signed (complete) trailing thinking block in the assistant LLM view even with a continuity message", () => {
		const messages: AgentMessage[] = [
			abortedAssistant([
				{ type: "text", text: "partial answer" },
				{ type: "thinking", thinking: "complete reasoning", thinkingSignature: "sig" },
			]),
			interruptedThinkingContinuity(),
		];

		const llm = convertToLlm(messages);
		const assistant = llm.find(entry => entry.role === "assistant");
		expect(Array.isArray(assistant?.content) && assistant.content.map(block => block.type)).toEqual([
			"text",
			"thinking",
		]);
	});
});

describe("replaceLlmImagesWithText", () => {
	it("replaces image blocks in user, developer, and tool-result messages with the placeholder", () => {
		const converted = convertToLlm([
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: "aaaa", mimeType: "image/png" },
				],
				attribution: "user",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "inspect_image",
				content: [{ type: "image", data: "bbbb", mimeType: "image/png" }],
				isError: false,
				timestamp: 2,
			},
		]);

		const scrubbed = replaceLlmImagesWithText(converted, "[image omitted]");

		expect(scrubbed).not.toBe(converted);
		const types = scrubbed.flatMap(m => (Array.isArray(m.content) ? m.content.map(b => b.type) : []));
		expect(types).not.toContain("image");
		const user = scrubbed.find(m => m.role === "user");
		expect(Array.isArray(user?.content) && user.content.map(b => (b.type === "text" ? b.text : b.type))).toEqual([
			"look",
			"[image omitted]",
		]);
		const toolResult = scrubbed.find(m => m.role === "toolResult");
		expect(Array.isArray(toolResult?.content) && toolResult.content).toEqual([
			{ type: "text", text: "[image omitted]" },
		]);
	});

	it("collapses consecutive image blocks into a single placeholder", () => {
		const converted = convertToLlm([
			{
				role: "user",
				content: [
					{ type: "image", data: "aaaa", mimeType: "image/png" },
					{ type: "image", data: "bbbb", mimeType: "image/png" },
				],
				attribution: "user",
				timestamp: 1,
			},
		]);

		const scrubbed = replaceLlmImagesWithText(converted, "[image omitted]");
		const user = scrubbed.find(m => m.role === "user");
		expect(Array.isArray(user?.content) && user.content).toEqual([{ type: "text", text: "[image omitted]" }]);
	});

	it("returns the same array reference when there are no image blocks", () => {
		const converted = convertToLlm([
			{ role: "user", content: [{ type: "text", text: "hi" }], attribution: "user", timestamp: 1 },
		]);

		expect(replaceLlmImagesWithText(converted, "[image omitted]")).toBe(converted);
	});
});

/**
 * sanitizeRehydratedOpenAIResponsesAssistantMessage exists for one narrow bug: GitHub Copilot
 * rejects replayed assistant-side native Responses history on a warmed session with HTTP 401. So it
 * must strip the native payload for github-copilot ONLY and leave every other Responses provider
 * (OpenAI, Codex, Azure) untouched, because they need that payload for faithful compaction replay
 * and prompt-cache continuity. A regression that broadens the strip is what left resumed sessions
 * compacting reasoning-less, prose-less tool-call history. These pin the provider gate, the payload
 * strip, the thinking-signature scrub, and that the input message is never mutated.
 */
describe("sanitizeRehydratedOpenAIResponsesAssistantMessage", () => {
	const copilot = (content: AssistantMessage["content"]): AssistantMessage =>
		({
			role: "assistant",
			content,
			provider: "github-copilot",
			providerPayload: { type: "openaiResponsesHistory" },
		}) as unknown as AssistantMessage;

	it("returns the same message when the payload is not Responses history", () => {
		const message = {
			...copilot([{ type: "text", text: "hi" }]),
			providerPayload: { type: "other" },
		} as unknown as AssistantMessage;
		expect(sanitizeRehydratedOpenAIResponsesAssistantMessage(message)).toBe(message);
	});

	it("returns the same message for every Responses provider other than github-copilot", () => {
		const message = { ...copilot([{ type: "text", text: "hi" }]), provider: "openai" } as unknown as AssistantMessage;
		expect(sanitizeRehydratedOpenAIResponsesAssistantMessage(message)).toBe(message);
	});

	it("strips the payload and scrubs thinking signatures for copilot without mutating the input", () => {
		const message = copilot([
			{ type: "text", text: "hi" },
			{ type: "thinking", thinking: "t", thinkingSignature: "SIG" } as AssistantMessage["content"][number],
		]);
		const out = sanitizeRehydratedOpenAIResponsesAssistantMessage(message);

		expect(out.providerPayload).toBeUndefined();
		expect(out.content).toEqual([
			{ type: "text", text: "hi" },
			{ type: "thinking", thinking: "t" },
		]);
		// The original is untouched: same signature, same payload.
		expect((message.content[1] as { thinkingSignature?: string }).thinkingSignature).toBe("SIG");
		expect(message.providerPayload as unknown).toEqual({ type: "openaiResponsesHistory" });
	});

	it("keeps the content array reference when there is no thinking signature to scrub", () => {
		const message = copilot([{ type: "thinking", thinking: "t" } as AssistantMessage["content"][number]]);
		const out = sanitizeRehydratedOpenAIResponsesAssistantMessage(message);
		expect(out.content).toBe(message.content);
		expect(out.providerPayload).toBeUndefined();
	});
});
