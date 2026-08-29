import * as path from "node:path";

import {
	type Api,
	type ApiKeyResolver,
	type AssistantMessage,
	type Context,
	completeSimple,
	type Model,
} from "@veyyon/ai";
import { StreamMarkupHealing } from "@veyyon/ai/utils/stream-markup-healing";
import { $env, isTerminalHeadless, logger, prompt } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";

import { resolveRoleSelectionWithInherit } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { titlesPrompts } from "../prompts/titles/rows";
import { isSecretPlaceholder, PLACEHOLDER_RE } from "../secrets/placeholder";
import type { SideCompleteImpl } from "../session/side-complete";
import { formatTitleUserMessage } from "../tiny/message-preproc";
import { isTinyTitleLocalModelKey, ONLINE_TINY_TITLE_MODEL_KEY } from "../tiny/models";
import { isLowSignalTitleInput, normalizeGeneratedTitle } from "../tiny/text";
import { tinyTitleClient } from "../tiny/title-client";

const TITLE_SYSTEM_PROMPT = prompt.render(titlesPrompts["titles/system"].text);
const TITLE_MARKER_INSTRUCTION = prompt.render(titlesPrompts["titles/marker-instruction"].text);

const DEFAULT_TERMINAL_TITLE = "vey";
const TERMINAL_TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const TITLE_MAX_TOKENS = 1024;

const PLACEHOLDER_SHIELD_START = 0xe100;
const PLACEHOLDER_SHIELD_END = 0xf8ff;

function withAtomicSecretPlaceholders(text: string, transform: (value: string) => string): string {
	const unavailable = new Set(text);
	let nextCodePoint = PLACEHOLDER_SHIELD_START;
	const allocateShield = (): string => {
		while (nextCodePoint <= PLACEHOLDER_SHIELD_END) {
			const candidate = String.fromCharCode(nextCodePoint++);
			if (!unavailable.has(candidate)) {
				unavailable.add(candidate);
				return candidate;
			}
		}
		throw new Error("Too many distinct secret placeholders to preprocess safely.");
	};
	const padding = allocateShield();
	const shields = new Map<string, string>();
	const shielded = text.replace(PLACEHOLDER_RE, candidate => {
		if (!isSecretPlaceholder(candidate)) return candidate;
		let shield = shields.get(candidate);
		if (!shield) {
			shield = allocateShield();
			shields.set(candidate, shield);
		}
		return shield + padding.repeat(candidate.length - 1);
	});
	let transformed = transform(shielded).split(padding).join("");
	for (const [placeholder, shield] of shields) {
		transformed = transformed.split(shield).join(placeholder);
	}
	return transformed;
}

const TITLE_MARKER_GLOBAL_RE = /<title>([\s\S]*?)<\/title>|<title\s*\/>|<title>\s*$/gi;
const TITLE_VISIBILITY_SENTINEL = "\uE000veyyon-title-visible\uE000";
const THINKING_TAG_ENVELOPE_RE = /<(think|thinking|reasoning)>\s*[\s\S]*?<\/\1>/gi;
const THINKING_FENCE_ENVELOPE_RE = /```(?:thinking|reasoning)\b[\s\S]*?```/gi;
const LEADING_THINKING_TAG_RE = /^\s*<(think|thinking|reasoning)>\s*[\s\S]*?<\/\1>\s*/i;
const LEADING_THINKING_FENCE_RE = /^\s*```(?:thinking|reasoning)\b[\s\S]*?```\s*/i;
const LEADING_PROSE_THINKING_PREAMBLE_RE =
	/^[ \t]*(?:(?:here(?:['’]s| is)[ \t]+(?:a|the|my)[ \t]+)|my[ \t]+)?(?:thinking|thought|reasoning)[ \t]+process[ \t]*:?[ \t]*(?:\r?\n|$)/i;

function getTitleModel(registry: ModelRegistry, settings: Settings, currentModel?: Model<Api>): Model<Api> | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;

	return resolveRoleSelectionWithInherit(["tiny", "commit", "smol"], settings, availableModels, currentModel)?.model;
}

export function autoTitleDisabled(): boolean {
	return Boolean($env.VEYYON_NO_TITLE);
}

export async function generateSessionTitle(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	customSystemPrompt?: string,
	obfuscateProviderText?: (text: string) => string,
	completeImpl?: SideCompleteImpl,
): Promise<string | null> {
	if (autoTitleDisabled()) {
		logger.debug("title-generator: skipped, auto-titling disabled", { sessionId, reason: "no-title" });
		return null;
	}
	if (isLowSignalTitleInput(firstMessage)) {
		logger.debug("title-generator: skipped low-signal input", { sessionId, reason: "low-signal" });
		return null;
	}

	const tinyModel = settings.get("providers.tinyModel");
	if (tinyModel === ONLINE_TINY_TITLE_MODEL_KEY) {
		return generateTitleOnline(
			firstMessage,
			registry,
			settings,
			sessionId,
			currentModel,
			metadataResolver,
			undefined,
			customSystemPrompt,
			obfuscateProviderText,
			completeImpl,
		);
	}

	if (!isTinyTitleLocalModelKey(tinyModel)) {
		logger.warn("title-generator: unknown local tiny model; skipping title (will not fall back to online)", {
			sessionId,
			model: tinyModel,
			reason: "unknown-local-model",
		});
		return null;
	}
	const customTitleSystemPrompt = customSystemPrompt?.trim() || undefined;
	try {
		const localTitle = customTitleSystemPrompt
			? await tinyTitleClient.generate(tinyModel, firstMessage, {
					systemPrompt: customTitleSystemPrompt,
				})
			: await tinyTitleClient.generate(tinyModel, firstMessage);
		if (!localTitle) {
			logger.warn("title-generator: local tiny model produced no title; skipping (no online fallback)", {
				sessionId,
				model: tinyModel,
				reason: "local-no-output",
			});
			return null;
		}
		return localTitle;
	} catch {
		logger.warn("title-generator: local tiny model errored; skipping (no online fallback)", {
			sessionId,
			model: tinyModel,
			reason: "local-error",
		});
		return null;
	}
}

async function generateTitleOnline(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	signal?: AbortSignal,
	customSystemPrompt?: string,
	obfuscateProviderText?: (text: string) => string,
	completeImpl?: SideCompleteImpl,
): Promise<string | null> {
	const model = getTitleModel(registry, settings, currentModel);
	if (!model) {
		logger.warn("title-generator: no title model found", { sessionId, reason: "no-title-model" });
		return null;
	}

	const modelName = `${model.provider}/${model.id}`;
	const modelContext = {
		sessionId,
		provider: model.provider,
		id: model.id,
		model: modelName,
	};
	logger.debug("title-generator: start", modelContext);

	try {
		const apiKey = await registry.getApiKey(model, sessionId);
		if (!apiKey) {
			logger.warn("title-generator: no API key", { ...modelContext, reason: "missing-api-key" });
			return null;
		}
		const metadata = metadataResolver?.(model.provider);

		const requestContext: Context = { systemPrompt: [], messages: [] };
		const refreshProviderContext = (): void => {
			const sanitize = obfuscateProviderText ?? ((text: string) => text);
			const providerFirstMessage = sanitize(firstMessage);
			const providerCustomPrompt = customSystemPrompt ? sanitize(customSystemPrompt).trim() || undefined : undefined;
			requestContext.systemPrompt = providerCustomPrompt
				? [providerCustomPrompt, sanitize(TITLE_MARKER_INSTRUCTION)]
				: [sanitize(TITLE_SYSTEM_PROMPT)];
			requestContext.messages = [
				{
					role: "user",
					content: withAtomicSecretPlaceholders(providerFirstMessage, formatTitleUserMessage),
					timestamp: Date.now(),
				},
			];
		};
		refreshProviderContext();
		const resolveApiKey = registry.resolver(model, sessionId);
		const resolveAttemptApiKey: ApiKeyResolver = async options => {
			const key = await resolveApiKey(options);
			refreshProviderContext();
			return key;
		};

		const maxTokens = TITLE_MAX_TOKENS;
		logger.debug("title-generator: request", { ...modelContext, maxTokens });

		const complete = completeImpl ?? completeSimple;
		const response = await complete(model, requestContext, {
			apiKey: resolveAttemptApiKey,
			maxTokens,
			disableReasoning: true,
			metadata,
			signal,
		});

		if (response.stopReason === "error") {
			logger.warn("title-generator: response error", {
				...modelContext,
				reason: "provider-response-error",
				stopReason: response.stopReason,
			});
			return null;
		}

		const title = normalizeGeneratedTitle(extractGeneratedTitle(response.content), firstMessage);

		if (!title) {
			logger.debug("title-generator: no title returned", {
				...modelContext,
				reason: "model-returned-none",
				usage: response.usage,
				stopReason: response.stopReason,
			});
			return null;
		}

		logger.debug("title-generator: success", {
			...modelContext,
			title,
			usage: response.usage,
			stopReason: response.stopReason,
		});

		return title;
	} catch {
		logger.warn("title-generator: error", {
			...modelContext,
			reason: "exception",
		});
		return null;
	}
}

function extractGeneratedTitle(contentBlocks: AssistantMessage["content"]): string {
	let textTitle = "";
	for (const content of contentBlocks) {
		if (content.type === "text") {
			textTitle += content.text;
		}
	}
	const markedTitle = extractVisibleMarkedTitle(textTitle);
	if (markedTitle !== undefined) return unwrapJsonTitle(markedTitle);
	const cleanedTextTitle = stripLeadingLeakedThinkingMarkup(textTitle)
		.replace(/<\/?title>/gi, "")
		.trim();
	if (LEADING_PROSE_THINKING_PREAMBLE_RE.test(cleanedTextTitle)) return "";
	return unwrapJsonTitle(cleanedTextTitle);
}

function extractVisibleMarkedTitle(text: string): string | undefined {
	TITLE_MARKER_GLOBAL_RE.lastIndex = 0;
	let marker: RegExpExecArray | null = TITLE_MARKER_GLOBAL_RE.exec(text);
	while (marker !== null) {
		const content = marker[1];
		if (isVisibleTitleMarker(text, marker.index)) return content?.trim() ?? "";
		marker = TITLE_MARKER_GLOBAL_RE.exec(text);
	}
	return undefined;
}

function isVisibleTitleMarker(text: string, markerIndex: number): boolean {
	if (isInsideKnownThinkingEnvelope(text, markerIndex)) return false;
	return stripLeakedThinkingMarkup(`${text.slice(0, markerIndex)}${TITLE_VISIBILITY_SENTINEL}`).endsWith(
		TITLE_VISIBILITY_SENTINEL,
	);
}

function isInsideKnownThinkingEnvelope(text: string, index: number): boolean {
	return (
		isInsideEnvelopeMatchedBy(THINKING_TAG_ENVELOPE_RE, text, index) ||
		isInsideEnvelopeMatchedBy(THINKING_FENCE_ENVELOPE_RE, text, index)
	);
}

function isInsideEnvelopeMatchedBy(pattern: RegExp, text: string, index: number): boolean {
	pattern.lastIndex = 0;
	let marker = pattern.exec(text);
	while (marker !== null) {
		const start = marker.index;
		const end = start + marker[0].length;
		if (index > start && index < end) return true;
		if (start > index) return false;
		marker = pattern.exec(text);
	}
	return false;
}

function stripLeadingLeakedThinkingMarkup(text: string): string {
	let current = text;
	while (true) {
		const withoutTag = current.replace(LEADING_THINKING_TAG_RE, "");
		const withoutFence = withoutTag.replace(LEADING_THINKING_FENCE_RE, "");
		if (withoutFence === current) return current;
		current = withoutFence;
	}
}

function stripLeakedThinkingMarkup(text: string): string {
	const healer = new StreamMarkupHealing({ pattern: "thinking" });
	return healer.feed(text) + healer.flushPending();
}

function unwrapJsonTitle(candidate: string): string {
	const text = candidate
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/```$/, "")
		.trim();
	if (!text.startsWith("{")) return candidate;
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && "title" in parsed && typeof parsed.title === "string") {
			return parsed.title.trim();
		}
	} catch {
		const quoted = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
		if (quoted) {
			const salvaged: unknown = JSON.parse(quoted[1]);
			if (typeof salvaged === "string") return salvaged.trim();
		}
	}
	return candidate;
}

function sanitizeTerminalTitlePart(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value.replace(TERMINAL_TITLE_CONTROL_CHARS, "").trim();
	return sanitized || undefined;
}

function getFallbackTerminalTitle(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	const resolvedCwd = path.resolve(cwd);
	const baseName = path.basename(resolvedCwd);
	if (!baseName || baseName === path.parse(resolvedCwd).root) return undefined;
	return sanitizeTerminalTitlePart(baseName);
}

function formatSessionTerminalTitle(sessionName: string | undefined, cwd?: string): string {
	const label = sanitizeTerminalTitlePart(sessionName) ?? getFallbackTerminalTitle(cwd);
	return label ? `${DEFAULT_TERMINAL_TITLE}: ${label}` : DEFAULT_TERMINAL_TITLE;
}

export function setTerminalTitle(title: string): void {
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	process.stdout.write(`\x1b]0;${sanitizeTerminalTitlePart(title) ?? DEFAULT_TERMINAL_TITLE}\x07`);
}

export function setSessionTerminalTitle(sessionName: string | undefined, cwd?: string): void {
	setTerminalTitle(formatSessionTerminalTitle(sessionName, cwd));
}

export function pushTerminalTitle(): void {
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	process.stdout.write("\x1b[22;2t");
}

export function popTerminalTitle(): void {
	if (!process.stdout.isTTY || isTerminalHeadless()) return;
	process.stdout.write("\x1b[23;2t");
}
