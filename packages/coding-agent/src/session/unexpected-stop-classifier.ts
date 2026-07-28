import { type AssistantMessage, completeSimple, type Model, seedApiKeyResolver, withAuth } from "@veyyon/ai";
import { ProviderHttpError } from "@veyyon/ai/error";
import { assistantText } from "@veyyon/ai/utils/message-text";
import { errorMessage, logger, prompt } from "@veyyon/utils";

import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelectionWithInherit } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { turnControlPrompts } from "../prompts/turn-control/rows";
import { isTinyMemoryLocalModelKey, ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";
import { tinyModelClient } from "../tiny/title-client";
import { REASONING_SAFE_MAX_TOKENS } from "./classifier-tokens";

/**
 * The instruction half only: the online path sends the message as its own user
 * turn (see {@link classifyOnline}), so the template's `Message:` slot is left
 * unfilled and its heading suppressed. Rendering it unguarded used to emit a
 * bare `Message:` header with nothing under it, which told the model to judge
 * text that was not there.
 */
const CLASSIFIER_SYSTEM_PROMPT = prompt.render(turnControlPrompts["turn-control/unexpected-stop-classifier"].text, {});

/**
 * The answer is a single word. OpenAI-compatible endpoints reject values below
 * 16, so 16 is the smallest portable budget for this classifier.
 */
const ANSWER_MAX_TOKENS = 16;

export interface ClassifyUnexpectedStopDeps {
	settings: Settings;
	registry: ModelRegistry;
	/** Live main model — inherited when tiny/smol roles are unset. */
	model?: Model;
	sessionId: string;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	signal?: AbortSignal;
	/** Live final boundary for text sent to the online classifier. */
	obfuscateProviderText: (text: string) => string;
}

export function isUnexpectedStopCandidate(message: AssistantMessage): boolean {
	if (message.stopReason !== "stop") return false;
	let hasText = false;
	for (const content of message.content) {
		if (content.type === "toolCall") return false;
		if (content.type === "text" && /\S/.test(content.text)) {
			hasText = true;
		}
	}
	return hasText;
}

export async function classifyUnexpectedStop(
	text: string,
	deps: ClassifyUnexpectedStopDeps,
): Promise<boolean | undefined> {
	const backend = deps.settings.get("providers.unexpectedStopModel");
	try {
		if (backend === ONLINE_MEMORY_MODEL_KEY) {
			return await classifyOnline(text, deps);
		}
		if (isTinyMemoryLocalModelKey(backend)) {
			return await classifyLocal(text, backend, deps);
		}
		return undefined;
	} catch (error) {
		logger.debug("unexpected-stop: classification failed", {
			error: errorMessage(error),
			backend,
		});
		return undefined;
	}
}

function sanitizeClassifierText(text: string, deps: ClassifyUnexpectedStopDeps): string {
	try {
		const sanitized = deps.obfuscateProviderText(text);
		if (typeof sanitized !== "string") throw new TypeError("invalid transform result");
		return sanitized;
	} catch {
		// The transform can inspect secret-bearing text; never reflect its error
		// (which may quote that text) into logs.
		throw new Error("unexpected-stop: provider payload sanitization failed");
	}
}

function createOnlineClassificationError(response: AssistantMessage, deps: ClassifyUnexpectedStopDeps): Error {
	const detail = sanitizeClassifierText(response.errorMessage ?? "unknown error", deps);
	const message = `unexpected-stop: online classification failed: ${detail}`;
	return response.errorStatus === undefined
		? new Error(message)
		: new ProviderHttpError(message, response.errorStatus);
}

async function classifyOnline(text: string, deps: ClassifyUnexpectedStopDeps): Promise<boolean | undefined> {
	const resolved = resolveRoleSelectionWithInherit(
		["tiny", "smol"],
		deps.settings,
		deps.registry.getAvailable(),
		deps.model,
	);
	const model = resolved?.model;
	if (!model) {
		throw new Error("unexpected-stop: no tiny/smol model available for classification");
	}
	const apiKey = await deps.registry.getApiKey(model, deps.sessionId);
	if (!apiKey) {
		throw new Error(`unexpected-stop: no API key for ${model.provider}/${model.id}`);
	}
	const metadata = deps.metadataResolver?.(model.provider);
	const maxTokens = REASONING_SAFE_MAX_TOKENS;

	const response = await withAuth(
		seedApiKeyResolver(apiKey, deps.registry.resolver(model, deps.sessionId)),
		async key => {
			// withAuth enters this closure after every initial/refresh/rotation
			// credential resolution. Resolve the live confidentiality runtime now,
			// immediately before this physical provider attempt.
			const providerText = sanitizeClassifierText(text, deps);
			const attemptResponse = await completeSimple(
				model,
				{
					systemPrompt: [CLASSIFIER_SYSTEM_PROMPT],
					messages: [{ role: "user", content: providerText, timestamp: Date.now() }],
				},
				{
					apiKey: key,
					maxTokens,
					disableReasoning: true,
					metadata,
					signal: deps.signal,
				},
			);
			if (attemptResponse.stopReason === "error") {
				throw createOnlineClassificationError(attemptResponse, deps);
			}
			return attemptResponse;
		},
		{ signal: deps.signal },
	);

	const outputText = assistantText(response);
	return parseUnexpectedStopClassification(outputText);
}

async function classifyLocal(
	text: string,
	modelKey: string,
	deps: ClassifyUnexpectedStopDeps,
): Promise<boolean | undefined> {
	if (!isTinyMemoryLocalModelKey(modelKey)) {
		throw new Error(`unexpected-stop: unsupported local classifier model: ${modelKey}`);
	}
	const builtPrompt = prompt.render(turnControlPrompts["turn-control/unexpected-stop-classifier"].text, {
		message: text,
	});
	const output = await tinyModelClient.complete(modelKey, builtPrompt, {
		maxTokens: ANSWER_MAX_TOKENS,
		signal: deps.signal,
	});
	if (!output) {
		return undefined;
	}
	return parseUnexpectedStopClassification(output);
}

export function parseUnexpectedStopClassification(text: string): boolean | undefined {
	const trimmed = text.trim().toLowerCase();
	if (trimmed.startsWith("yes")) return true;
	if (trimmed.startsWith("no")) return false;
	return undefined;
}
