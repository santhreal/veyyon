/**
 * Wrapping a steering message in the interjection envelope the model reads.
 *
 * WHY IT IS NOT IN `session/messages.ts`. This is the only code in the message pipeline that renders a
 * PROMPT, and `prompts/registry.ts` is deliberately the single owner of every prompt file: it imports
 * all 143 of them, so it reaches 238 modules and nothing outside it may import a prompt directly
 * (`prompt-registry-coverage` pins that, and it is right to). Naming the registry for one template
 * therefore costs 164 modules that nothing else on the path reaches, and `session/messages.ts` is
 * imported by `session/session-context.ts` and through it by `session/session-manager.ts`, which 206
 * test files import. So one envelope template was priced into most of the suite.
 *
 * The registry is not the thing to change. What was wrong is that a function about STEERING lived in
 * the module about message shapes, and moving it puts the prompt cost on the one caller that renders a
 * prompt. `sdk.ts` passes {@link wrapSteeringForModel} as its context transformer and already reaches
 * the registry many times over.
 *
 * WHY EVERY STEERING MESSAGE IS WRAPPED, not just the trailing run: the wire bytes of a steering
 * message have to be a pure function of the message itself. See the note on
 * {@link wrapSteeringForModel}.
 */

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
	content.push(...getArrayContentImages(message.content));
	return { ...userMessageWithoutSteering(message), content };
}

export function wrapSteeringForModel(messages: AgentMessage[]): AgentMessage[] {
	// Wrap EVERY steering message, not just a trailing run. The wire bytes of a
	// steering message must be a pure function of the message itself, independent
	// of its position in the array. When only the trailing steer was wrapped, the
	// same persisted message was sent enveloped while it was the tail and raw once
	// the assistant's reply buried it — rewriting already-cached prefix bytes and
	// busting the provider prompt cache from that message onward on the next turn.
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
