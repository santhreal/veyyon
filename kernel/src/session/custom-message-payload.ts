import type { CustomMessage } from "@veyyon/agent-core/compaction/messages";
import type { AssistantMessage, ImageContent, MessageAttribution, TextContent } from "@veyyon/ai";
import { isRecord } from "@veyyon/utils/type-guards";

/**
 * The custom-message payload a caller hands the session, and the sanitising a loaded
 * assistant message needs before it is replayed.
 *
 * These are the parts of the coding agent's `session/messages.ts` the session spine
 * itself calls: `SessionManager.appendCustomMessage` normalises a payload and strips
 * the internal fields, `buildSessionContext` recognises custom content, and rehydration
 * sanitises a Copilot Responses payload. None of them names a tool or a host; the
 * message kinds that do stay with the coding agent, which re-exports these names.
 */

/** Fallback type for extension-injected messages that omit a custom type. */
export const DEFAULT_CUSTOM_MESSAGE_TYPE = "custom-message";

/** Content shape accepted for extension-injected messages. */
export type CustomMessageContent = string | (TextContent | ImageContent)[];

/** Public input accepted by `pi.sendMessage` and `AgentSession.sendCustomMessage`. */
export type CustomMessagePayload<T = unknown> =
	| string
	| Partial<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">>;

/** Custom message payload after applying runtime defaults. */
export type NormalizedCustomMessagePayload<T = unknown> = Pick<
	CustomMessage<T>,
	"customType" | "content" | "display" | "details" | "attribution"
>;

/** Extract the optional `__queueChipText` field from a CustomMessage's
 *  `details` blob. Safe over `unknown`; returns undefined when the field is
 *  absent or non-string. */
export function readQueueChipText(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = (details as { __queueChipText?: unknown }).__queueChipText;
	return typeof candidate === "string" ? candidate : undefined;
}

/** Explicit allowlist of `details` field names that are AgentSession-internal
 *  transient bookkeeping and MUST be removed before SessionManager persists
 *  the CustomMessageEntry to disk. Scoped intentionally narrow: only fields
 *  declared here are stripped. Adding a new entry is a deliberate, reviewed
 *  change — unrelated future payload fields are never silently dropped. */
export const INTERNAL_DETAILS_FIELDS = ["__queueChipText"] as const;

/** Return a `details` copy with every key in `INTERNAL_DETAILS_FIELDS`
 *  removed. Returns the input unchanged when there is nothing to strip
 *  (null/non-object, or no listed fields present) so callers don't pay a
 *  clone cost on the common path. */
export function stripInternalDetailsFields<T>(details: T | undefined): T | undefined {
	if (details == null || typeof details !== "object") return details;
	const obj = details as Record<string, unknown>;
	let hit = false;
	for (const key of INTERNAL_DETAILS_FIELDS) {
		if (key in obj) {
			hit = true;
			break;
		}
	}
	if (!hit) return details;
	const cleaned: Record<string, unknown> = { ...obj };
	for (const key of INTERNAL_DETAILS_FIELDS) {
		delete cleaned[key];
	}
	return cleaned as T;
}

/** True when a persisted or extension-supplied value can be sent as custom-message content. */
export function isCustomMessageContent(content: unknown): content is CustomMessageContent {
	return typeof content === "string" || Array.isArray(content);
}

function normalizeCustomMessageContent(content: unknown): CustomMessageContent {
	return isCustomMessageContent(content) ? content : "";
}

function normalizeCustomMessageType(customType: unknown): string {
	return typeof customType === "string" && customType.length > 0 ? customType : DEFAULT_CUSTOM_MESSAGE_TYPE;
}

function normalizeCustomMessageAttribution(attribution: unknown): MessageAttribution {
	return attribution === "user" ? "user" : "agent";
}

function isCustomMessagePayloadObject<T>(
	payload: unknown,
): payload is Partial<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">> {
	return isRecord(payload);
}

/** Normalizes extension-provided custom message input before it reaches session state or disk. */
export function normalizeCustomMessagePayload<T = unknown>(
	payload: CustomMessagePayload<T> | unknown,
): NormalizedCustomMessagePayload<T> {
	if (typeof payload === "string") {
		return {
			customType: DEFAULT_CUSTOM_MESSAGE_TYPE,
			content: payload,
			display: true,
			attribution: "agent",
		};
	}
	if (!isCustomMessagePayloadObject<T>(payload)) {
		const content = payload === undefined || payload === null ? "" : String(payload);
		return {
			customType: DEFAULT_CUSTOM_MESSAGE_TYPE,
			content,
			display: content.length > 0,
			attribution: "agent",
		};
	}
	return {
		customType: normalizeCustomMessageType(payload.customType),
		content: normalizeCustomMessageContent(payload.content),
		display: typeof payload.display === "boolean" ? payload.display : false,
		details: payload.details,
		attribution: normalizeCustomMessageAttribution(payload.attribution),
	};
}

export function sanitizeRehydratedOpenAIResponsesAssistantMessage(message: AssistantMessage): AssistantMessage {
	if (message.providerPayload?.type !== "openaiResponsesHistory") {
		return message;
	}
	// Only GitHub Copilot rejects replayed assistant-side native history on a
	// warmed (resumed) session with HTTP 401 — that is the sole reason this strip
	// exists. For every other Responses-family provider (OpenAI, OpenAI-Codex,
	// Azure) the encrypted reasoning and native response items are self-contained
	// and MUST survive rehydration: remote compaction replays them to rebuild
	// faithful native history (user + assistant turns + encrypted reasoning), and
	// same-model live turns reuse them for prompt-cache continuity. Stripping them
	// for all providers is what left resumed sessions compacting tool-call-only
	// history with no reasoning and no assistant prose.
	if (message.provider !== "github-copilot") {
		return message;
	}

	let didSanitizeContent = false;
	const sanitizedContent = message.content.map(block => {
		if (block.type !== "thinking" || block.thinkingSignature === undefined) {
			return block;
		}
		didSanitizeContent = true;
		return { ...block, thinkingSignature: undefined };
	});

	// Strip the assistant-side native replay payload entirely. After rehydration
	// it belongs to a previous live Copilot connection and replaying it on a
	// warmed session causes 401 rejections. User/developer payloads are preserved
	// separately by the caller.
	return {
		...message,
		...(didSanitizeContent ? { content: sanitizedContent } : {}),
		providerPayload: undefined,
	};
}
