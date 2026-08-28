/** Wrapping a steering message in the interjection envelope the model reads. PROMPT, and `prompts/registry.ts` is deliberately the single owner of every prompt file: it imports */

import type { AgentMessage } from "@veyyon/agent-core";
import type { ImageContent, TextContent, UserMessage } from "@veyyon/ai";
import { prompt } from "@veyyon/utils";
import { steeringPrompts } from "../prompts/steering/rows";
import { contentText } from "./content-text";

function isSteeringUserMessage(message: AgentMessage | undefined): message is UserMessage & { steering: true } {
	return message?.role === "user" && message.steering === true;
}

function userMessageWithoutSteering(message: UserMessage): UserMessage {
	const { steering, ...rest } = message;
	void steering;
	return rest;
}

function renderSteeringEnvelope(message: string): string {
	return prompt.render(steeringPrompts["steering/user-interjection"].text, { message });
}

function getArrayContentImages(content: (TextContent | ImageContent)[]): ImageContent[] {
	let images: ImageContent[] | undefined;
	for (const part of content) {
		if (part.type !== "image") continue;
		if (images === undefined) images = [];
		images.push(part);
	}
	return images ?? [];
}

function wrapSteeringUserMessage(message: UserMessage): UserMessage {
	if (typeof message.content === "string") {
		if (message.content.length === 0) return message;
		return { ...userMessageWithoutSteering(message), content: renderSteeringEnvelope(message.content) };
	}

	const text = contentText(message.content);
	if (text.length === 0) return message;
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: renderSteeringEnvelope(text) }];
	const images = getArrayContentImages(message.content);
	for (let ii = 0; ii < images.length; ii++) content.push(images[ii]!);
	return { ...userMessageWithoutSteering(message), content };
}

export function wrapSteeringForModel(messages: AgentMessage[]): AgentMessage[] {
	// Wrap EVERY steering message, not just a trailing run. The wire bytes of a steering message must be a pure function of the message itself, independent
	let wrappedMessages: AgentMessage[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!isSteeringUserMessage(message)) continue;
		const wrappedMessage = wrapSteeringUserMessage(message);
		if (wrappedMessage === message) continue;
		if (wrappedMessages === undefined) {
			wrappedMessages = messages.slice();
		}
		wrappedMessages[i] = wrappedMessage;
	}
	return wrappedMessages ?? messages;
}
