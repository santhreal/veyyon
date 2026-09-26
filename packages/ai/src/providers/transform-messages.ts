import * as logger from "@veyyon/utils/logger";
import { escapeXmlAttribute } from "@veyyon/utils/sanitize-text";
import { isRecord } from "@veyyon/utils/type-guards";
import { renderDemotedThinking } from "../dialect/demotion";
import type {
	Api,
	AssistantMessage,
	DemotedReasoningSource,
	Message,
	Model,
	ProviderPayload,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types";
import { type DemotedThinkingCarrier, isDemotedThinking, kDemotedThinking } from "../utils/block-symbols";

const enum ToolCallStatus {
	/** A tool result has already been emitted for this tool call; later duplicates must be skipped. */
	Resolved = 1,
	/** A synthetic aborted result was emitted; later real results must be skipped. */
	Aborted = 2,
}

/**
 * Wrap a tool result whose originating tool call is no longer in the request.
 *
 * Compaction, session-tree branching, a locally rejected call and a
 * `providerPayload` splice all produce a result with no call to pair it to.
 * Every provider rejects the unpaired block, and dropping it loses output the
 * model needs, so the payload is preserved as an ordinary message instead.
 *
 * A caller MUST attach this to `role: "user"`, never `role: "assistant"`.
 * The assistant role puts tool output in the model's own voice, and a model
 * that reads its own prior turn ending in a note shaped like a tool result
 * reproduces that shape: `grok-4.6` on `openai-responses` emitted a whole
 * `search` result as visible prose, with a provider `textSignature` proving it
 * generated the text token by token rather than the note being echoed back.
 * The user role also keeps stale, model-untrusted output from gaining
 * instruction priority: `developer` maps to `system` on Ollama and stays above
 * user priority on OpenAI reasoning models, while `user` is plain content
 * everywhere.
 *
 * The tag matters as much as the role. An XML envelope reads as data the model
 * quotes from, where a bare `[Orphan tool result; call_id=…]: ` prefix reads as
 * a message template it can imitate.
 */
export function staleToolResultNote(options: {
	toolName: string;
	toolCallId: string;
	text: string;
	isError?: boolean;
}): string {
	const errorAttr = options.isError ? ' is-error="true"' : "";
	// Attributes are escaped through the one owner; the body stays raw, matching
	// `<tool_response>` in dialect/rendering.ts, because escaping a tool payload
	// turns every `<` in the code the model is reading into `&lt;`.
	const tool = escapeXmlAttribute(options.toolName);
	const id = escapeXmlAttribute(options.toolCallId);
	return `<stale-tool-result tool="${tool}" id="${id}"${errorAttr}>\n${options.text}\n</stale-tool-result>`;
}

/**
 * The note format persisted before the repair moved to `role: "user"`:
 * `[Orphan <tool> result; call_id=<id>]: <output>` from the Responses repair,
 * and `[Previous …]` from the Codex one.
 */
const LEGACY_STALE_TOOL_NOTE = /^\[(?:Orphan|Previous) [^\]]*result; call_id=[^\]]*\]: /;

/**
 * Text of every tool result the model read between the previous assistant turn
 * and `index`. An imitated note copies one of these verbatim, so they are the
 * only evidence of where the copy ends and the model's own reply begins.
 */
function precedingToolOutputs(messages: readonly Message[], index: number): string[] {
	const outputs: string[] = [];
	for (let i = index - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "assistant") break;
		if (message.role !== "toolResult") continue;
		const text = message.content
			.filter((block): block is TextContent => block.type === "text")
			.map(block => block.text)
			.join("\n");
		if (text.length > 0) outputs.push(text);
	}
	return outputs;
}

/**
 * Strip a legacy note from one assistant text.
 *
 * Returns the text unchanged when it holds no note, the reply that followed the
 * copied payload when the copy is byte-equal to one of `priorToolOutputs`, and
 * `undefined` when nothing of the model's own can be separated from the copy.
 * A copy that drifts from the tool output (paraphrased, truncated) cannot be
 * split soundly, so the block goes in full rather than keeping tool output in
 * the assistant's voice; measured over recorded sessions, about a third of the
 * notes are exact copies and a quarter of those carry a reply after them.
 */
function stripLegacyStaleToolNote(text: string, priorToolOutputs: readonly string[]): string | undefined {
	const match = LEGACY_STALE_TOOL_NOTE.exec(text);
	if (!match) return text;
	const rest = text.slice(match[0].length);
	for (const output of priorToolOutputs) {
		if (!rest.startsWith(output)) continue;
		const reply = rest.slice(output.length).trim();
		return reply.length > 0 ? reply : undefined;
	}
	return undefined;
}

/**
 * Apply {@link stripLegacyStaleToolNote} to the transport-native copy of the
 * turn. A Responses-family provider replays `providerPayload.items` verbatim
 * once its session is warm, in preference to `content`, so a note left in an
 * `output_text` part would keep priming the model on the live path no matter
 * what `content` says.
 */
function stripLegacyStaleToolNotesFromPayload(
	payload: ProviderPayload,
	priorToolOutputs: readonly string[],
): ProviderPayload {
	const items = payload.items.flatMap(item => {
		const parts: unknown = item.content;
		if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(parts)) return [item];
		const content = parts.flatMap((part: unknown) => {
			if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") return [part];
			const text = stripLegacyStaleToolNote(part.text, priorToolOutputs);
			if (text === part.text) return [part];
			return text === undefined ? [] : [{ ...part, text }];
		});
		return content.length > 0 ? [{ ...item, content }] : [];
	});
	return { ...payload, items };
}

/**
 * Remove legacy stale-tool notes from assistant history.
 *
 * The payload is not re-emitted as a user note. It is truncated output from a
 * call that left the request many turns ago, and a message inserted between an
 * assistant `tool_use` and its `tool_result` would break the contiguity
 * Anthropic requires, so the cost of keeping it exceeds what it can inform.
 */
function dropLegacyStaleToolNotes(messages: Message[]): Message[] {
	// This runs on every request for every provider, and all but a handful of
	// sessions hold no such note, so the common path must not copy the history:
	// scan first and hand back the same array. `content` is the detector for
	// `providerPayload` too: both come from the same response, so a note in one
	// is in the other.
	let hasNote = false;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		if (message.content.some(block => block.type === "text" && LEGACY_STALE_TOOL_NOTE.test(block.text))) {
			hasNote = true;
			break;
		}
	}
	if (!hasNote) return messages;

	const result: Message[] = [];
	for (const [index, message] of messages.entries()) {
		if (message.role !== "assistant") {
			result.push(message);
			continue;
		}
		if (!message.content.some(block => block.type === "text" && LEGACY_STALE_TOOL_NOTE.test(block.text))) {
			result.push(message);
			continue;
		}
		const priorToolOutputs = precedingToolOutputs(messages, index);
		const kept = message.content.flatMap((block): AssistantMessage["content"] => {
			if (block.type !== "text") return [block];
			const text = stripLegacyStaleToolNote(block.text, priorToolOutputs);
			if (text === block.text) return [block];
			// The signature covered the text as generated; the shortened text no
			// longer matches it, so it must not be replayed as signed.
			return text === undefined ? [] : [{ ...block, text, textSignature: undefined }];
		});
		// An assistant turn holding nothing but the note has no tool call and no
		// reply left, so replaying it contributes an empty turn.
		if (kept.length === 0) continue;
		const providerPayload = message.providerPayload
			? stripLegacyStaleToolNotesFromPayload(message.providerPayload, priorToolOutputs)
			: undefined;
		result.push({ ...message, content: kept, ...(providerPayload ? { providerPayload } : {}) });
	}
	return result;
}

/**
 * Maximum tool-call id length the strictest replay provider accepts.
 *
 * Anthropic requires `^[a-zA-Z0-9_-]+$` with a 64-char cap; Google and Codex
 * `normalizeToolCallId` implementations cap individual id segments to the same
 * 64-char ceiling. Replacement ids minted here flow back through
 * `convertAnthropicMessages` (and friends) unchanged, so the `_dupN` suffix
 * MUST not push a normalized id past this bound.
 */
const MAX_TOOL_CALL_ID_LENGTH = 64;

function appendDuplicateSuffix(originalId: string, suffix: string, maxLength: number): string {
	// Responses-family ids are composites (`callId|itemId`): the wire call_id is
	// the FIRST segment (normalizeResponsesToolCallId splits on `|`), so the
	// suffix must land on every segment or the duplicate collapses back onto the
	// original call_id at encode time. The length budget applies per segment,
	// matching the per-segment caps of the provider normalizers.
	if (originalId.includes("|")) {
		return originalId
			.split("|")
			.map(segment => appendSegmentDuplicateSuffix(segment, suffix, maxLength))
			.join("|");
	}
	return appendSegmentDuplicateSuffix(originalId, suffix, maxLength);
}

function appendSegmentDuplicateSuffix(segment: string, suffix: string, maxLength: number): string {
	if (segment.length + suffix.length <= maxLength) return `${segment}${suffix}`;
	const prefixBudget = Math.max(0, maxLength - suffix.length);
	return `${segment.slice(0, prefixBudget)}${suffix}`;
}

type PendingToolResultRewrite = { replacementId: string } | undefined;

function deduplicateToolCallIds(
	messages: Message[],
	maxToolCallIdLength = MAX_TOOL_CALL_ID_LENGTH,
	duplicateSuffixPrefix = "_dup",
): Message[] {
	const seenToolCallIds = new Map<string, number>();
	const pendingToolResultRewrites = new Map<string, PendingToolResultRewrite[]>();

	return messages.map(msg => {
		if (msg.role === "toolResult") {
			const rewrites = pendingToolResultRewrites.get(msg.toolCallId);
			if (!rewrites || rewrites.length === 0) return msg;

			const rewrite = rewrites.shift();
			if (rewrites.length === 0) pendingToolResultRewrites.delete(msg.toolCallId);
			if (rewrite) return { ...msg, toolCallId: rewrite.replacementId };
			return msg;
		}

		if (msg.role !== "assistant") return msg;

		const enqueueToolResultRewrite = (id: string, rewrite: PendingToolResultRewrite): void => {
			const rewrites = pendingToolResultRewrites.get(id);
			if (rewrites) {
				rewrites.push(rewrite);
				return;
			}
			pendingToolResultRewrites.set(id, [rewrite]);
		};

		// Ids this turn has already touched; used to scope the "drop carried-over
		// pending rewrites" semantics to the FIRST occurrence per turn so multiple
		// blocks of the same id within one turn still accumulate as duplicates.
		const idsTouchedInTurn = new Set<string>();
		let contentChanged = false;
		const content = msg.content.map(block => {
			if (block.type !== "toolCall") return block;

			// Drop any pending rewrites carried over from a prior assistant turn
			// for this id on its first appearance this turn. When a later turn
			// re-emits the same id, the older duplicate call's expected result
			// never landed in time — the second pass synthesizes
			// "No result provided" for it, and the upcoming real result(id) must
			// route to one of THIS turn's calls. Without this guard the older
			// `_dup` id would steal the next result.
			if (!idsTouchedInTurn.has(block.id)) {
				pendingToolResultRewrites.delete(block.id);
				idsTouchedInTurn.add(block.id);
			}

			const previousCount = seenToolCallIds.get(block.id) ?? 0;
			if (previousCount === 0) {
				seenToolCallIds.set(block.id, 1);
				enqueueToolResultRewrite(block.id, undefined);
				return block;
			}

			let duplicateIndex = previousCount;
			let replacementId = appendDuplicateSuffix(
				block.id,
				`${duplicateSuffixPrefix}${duplicateIndex}`,
				maxToolCallIdLength,
			);
			while (seenToolCallIds.has(replacementId)) {
				duplicateIndex += 1;
				replacementId = appendDuplicateSuffix(
					block.id,
					`${duplicateSuffixPrefix}${duplicateIndex}`,
					maxToolCallIdLength,
				);
			}
			seenToolCallIds.set(block.id, duplicateIndex + 1);
			seenToolCallIds.set(replacementId, 1);
			enqueueToolResultRewrite(block.id, { replacementId });
			contentChanged = true;
			return { ...block, id: replacementId };
		});

		if (!contentChanged) return msg;
		return { ...msg, content };
	});
}

/**
 * Drop assistant `toolCall` blocks whose `id` or `name` is empty / whitespace-only,
 * the `toolResult` messages they point at, and any assistant turn that has no
 * replayable content left.
 *
 * Models occasionally emit malformed calls such as `{ "name": "", "arguments": "{}" }`
 * (observed: GLM-5.2 + thinking on long turns, #3458) or a structurally valid
 * `toolCall` whose provider/native passthrough id never materialized (`id: ""`).
 * The agent loop rejects or skips these at execution time, but the malformed block
 * and its error tool-result can stay in `currentContext.messages`, so every
 * subsequent request replays them. Every provider validates the call shape —
 * Anthropic 400s on `tool_use.name` / `tool_use.id` (alongside an orphan
 * `tool_result`), OpenAI Chat Completions 400s on malformed
 * `tool_calls[i].function.*` — wedging the session in a 400 loop until manual
 * `/clear`.
 *
 * Run before any other transform so the rest of the pipeline never sees a
 * malformed call. Idempotent: a re-run on an already-sanitized list returns
 * the input untouched. Provider-agnostic — any wire model could surface this.
 */
function isMalformedToolCallName(name: string | undefined): boolean {
	return !name || name.trim().length === 0;
}

function isMalformedToolCallId(id: string | undefined): boolean {
	return !id || id.trim().length === 0;
}

function isMalformedToolCall(block: { id: string; name: string }): boolean {
	return isMalformedToolCallId(block.id) || isMalformedToolCallName(block.name);
}

function hasMalformedToolCall(messages: readonly Message[]): boolean {
	return messages.some(
		msg =>
			msg.role === "assistant" && msg.content.some(block => block.type === "toolCall" && isMalformedToolCall(block)),
	);
}

/**
 * Drop an assistant turn's malformed tool calls, queueing each call occurrence's malformed-ness
 * by id so the matching tool result is dropped with it. Undefined when no block survives.
 */
function dropMalformedToolCalls(
	msg: AssistantMessage,
	dropQueues: Map<string, boolean[]>,
): AssistantMessage | undefined {
	const filtered: AssistantMessage["content"] = [];
	for (const block of msg.content) {
		if (block.type === "toolCall") {
			const malformed = isMalformedToolCall(block);
			const queue = dropQueues.get(block.id);
			if (queue) queue.push(malformed);
			else dropQueues.set(block.id, [malformed]);
			if (malformed) continue;
		}
		filtered.push(block);
	}
	if (filtered.length === 0) return undefined;
	return filtered.length === msg.content.length ? msg : { ...msg, content: filtered };
}

/** Whether a tool result answers the malformed occurrence at the head of its id's queue. */
function answersMalformedToolCall(msg: ToolResultMessage, dropQueues: Map<string, boolean[]>): boolean {
	const queue = dropQueues.get(msg.toolCallId);
	if (!queue || queue.length === 0) return false;
	const drop = queue.shift() === true;
	if (queue.length === 0) dropQueues.delete(msg.toolCallId);
	return drop;
}

function sanitizeMalformedToolCalls(messages: Message[]): Message[] {
	// Fast path: skip the rewrite entirely when nothing is malformed.
	if (!hasMalformedToolCall(messages)) return messages;

	// Positional FIFO pairing within one assistant→tool-result window: a tool-call
	// id can repeat across history when an OpenAI-Responses composite id
	// (`callId|itemId`) collapses on the wire to the same `callId` (see
	// `deduplicateToolCallIds` + `transform-messages-dedup`). A set-based "drop
	// every result for this id" loses the real output for the surviving valid
	// occurrence whenever one duplicate is malformed. Track each `toolCall`
	// occurrence's malformed-ness on a per-id queue and pop on matching
	// `toolResult`, but clear the queues at every non-result boundary so a
	// malformed call whose rejection result never arrived cannot consume a later
	// valid call's real result when the id is reused.
	const dropQueues = new Map<string, boolean[]>();
	const result: Message[] = [];
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			if (!answersMalformedToolCall(msg, dropQueues)) result.push(msg);
			continue;
		}
		dropQueues.clear();
		const kept = msg.role === "assistant" ? dropMalformedToolCalls(msg, dropQueues) : msg;
		if (kept) result.push(kept);
	}
	return result;
}

/**
 * True when `model` would refuse or reject prior-turn reasoning that is already
 * demoted to prose. This is the unsigned-thinking replay policy of the
 * assistant branch below, applied to a text message that carries the same
 * reasoning: a signing Anthropic endpoint drops it on same-model replay, and
 * any `anthropic-messages` target drops it once `replayDemotedPriorReasoning`
 * is off, whether by catalog or learned from a `reasoning_extraction` refusal
 * (the transport clones the compat with the flag cleared before retrying, so
 * the retry and every later request of the session take this branch).
 */
function dropsDemotedPriorReasoning(source: DemotedReasoningSource, model: Model): boolean {
	if (!isAnthropicMessagesModel(model)) return false;
	if (!model.compat.replayDemotedPriorReasoning) return true;
	return model.compat.signingEndpoint && source.provider === model.provider && source.model === model.id;
}

/**
 * Drop text messages whose body is demoted prior reasoning the target cannot be
 * sent. The message carries the run outside the assistant turn, so the
 * per-block thinking policy never sees it; without this pass the prose reaches
 * the classifier on every request of the session, and the refusal retry that
 * clears `replayDemotedPriorReasoning` re-sends the same bytes.
 */
function dropUndeliverableDemotedReasoning(messages: Message[], model: Model): Message[] {
	let drops = false;
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "developer") continue;
		if (message.demotedReasoningSource && dropsDemotedPriorReasoning(message.demotedReasoningSource, model)) {
			drops = true;
			break;
		}
	}
	if (!drops) return messages;
	return messages.filter(
		message =>
			(message.role !== "user" && message.role !== "developer") ||
			!message.demotedReasoningSource ||
			!dropsDemotedPriorReasoning(message.demotedReasoningSource, model),
	);
}

function shouldDropTruncatedThinkingOnlyAssistant(msg: AssistantMessage): boolean {
	const isTruncatedStop = msg.stopReason === "length" || msg.stopReason === "error" || msg.stopReason === "aborted";
	return isTruncatedStop && !msg.content.some(block => block.type === "toolCall" || block.type === "text");
}

function getLatestSurvivingAssistantIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const msg = messages[index]!;
		if (msg.role === "assistant" && !shouldDropTruncatedThinkingOnlyAssistant(msg)) {
			return index;
		}
	}
	return -1;
}

function isAnthropicMessagesModel(model: Model): model is Model<"anthropic-messages"> {
	return model.api === "anthropic-messages";
}

/**
 * Targets that have proven they read unsigned foreign thinking when replayed
 * natively. This is a semantic-carry allowlist only: OpenAI-compatible
 * `reasoning_content` schema requirements and llama.cpp cache-prefix replay are
 * handled by their encoders and MUST NOT make foreign thinking look meaningful.
 */
function targetReadsForeignThinking(model: Model, compat: Model["compat"]): boolean {
	if (compat === undefined) return false;
	if (model.api === "anthropic-messages") {
		return "replayUnsignedThinking" in compat && compat.replayUnsignedThinking === true;
	}
	if (model.api !== "openai-completions") return false;
	if (!("thinkingFormat" in compat)) return false;
	if (compat.requiresThinkingAsText) return false;
	return model.reasoning && compat.thinkingFormat === "zai";
}

const ANTHROPIC_TOOL_CALL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function isValidAnthropicToolCallId(id: string): boolean {
	return ANTHROPIC_TOOL_CALL_ID_PATTERN.test(id);
}

function fallbackAnthropicToolCallId(originalId: string): string {
	return `toolu_${Bun.hash(originalId).toString(36)}`;
}

function normalizeAnthropicTargetToolCallId<TApi extends Api>(
	id: string,
	model: Model<TApi>,
	source: AssistantMessage,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): string {
	if (isValidAnthropicToolCallId(id)) return id;
	const normalized =
		normalizeToolCallId?.(id, model, source) ?? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_CALL_ID_LENGTH);
	if (isValidAnthropicToolCallId(normalized)) return normalized;
	return fallbackAnthropicToolCallId(id);
}

/**
 * The assistant turns whose thinking a later history rewrite orphaned, by index.
 *
 * Preserved thinking (Fable 5.1+): a thinking block's signature is bound to
 * the exact bytes of every message before it, so reasoning recorded before a
 * client-side history rewrite — a compaction or branch summary replacing the
 * turns it was produced against, or a tool result pruned in place — can no
 * longer be replayed. Anthropic rejects such a block with 400 unless the
 * request opts into `drop_block`; dropping it here keeps the request
 * append-only from the API's point of view and costs only reasoning the
 * summary already subsumes.
 */
function assistantsBeforeHistoryRewrite(messages: readonly Message[]): Set<number> {
	const indexes = new Set<number>();
	let latestRewriteAt: number | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!message) continue;
		const rewriteAt =
			message.role === "user" || message.role === "developer"
				? message.historyRewriteAt
				: message.role === "toolResult"
					? message.prunedAt
					: undefined;
		if (rewriteAt !== undefined) {
			latestRewriteAt = latestRewriteAt === undefined ? rewriteAt : Math.max(latestRewriteAt, rewriteAt);
		} else if (
			message.role === "assistant" &&
			latestRewriteAt !== undefined &&
			message.timestamp <= latestRewriteAt
		) {
			indexes.add(index);
		}
	}
	return indexes;
}

type AssistantBlock = AssistantMessage["content"][number];

/** Caller hook that rewrites a tool call id the target model cannot accept. */
type ToolCallIdNormalizer<TApi extends Api> = (id: string, model: Model<TApi>, source: AssistantMessage) => string;

/** How one assistant message replays to the target model: the facts each of its blocks' transforms reads. */
interface AssistantReplay<TApi extends Api> {
	readonly source: AssistantMessage;
	readonly model: Model<TApi>;
	readonly targetCompat: Model<TApi>["compat"];
	/** The source message came from the target model: the same provider, API and model id. */
	readonly isSameModel: boolean;
	readonly isAnthropicTarget: boolean;
	/** An `anthropic-messages` turn replayed to an `anthropic-messages` target. */
	readonly isAnthropicReplay: boolean;
	readonly isLatestSurvivingAssistant: boolean;
	readonly isSigningAnthropicTarget: boolean;
	/** A signing Anthropic endpoint is on either end of the replay. */
	readonly signingAnthropicInvolved: boolean;
	/** An Anthropic target that takes unsigned thinking natively instead of demoting it to text. */
	readonly replaysUnsignedAnthropicThinking: boolean;
	/** An Anthropic target that replays demoted prior reasoning instead of dropping it. */
	readonly replaysDemotedPriorReasoning: boolean;
	readonly officialAnthropicTarget: boolean;
	/** The turn stopped on `aborted` or `error`. */
	readonly invalidStopReason: boolean;
	/** The turn carries tool calls but ended without requesting their execution. */
	readonly abandonedToolUse: boolean;
	readonly lastBlockIndex: number;
	/** A history rewrite after this turn orphaned its thinking; see {@link assistantsBeforeHistoryRewrite}. */
	readonly thinkingOrphaned: boolean;
	/** A same-model replay to a signing endpoint keeps none of the turn's visible thinking. */
	readonly dropsAllSameModelVisibleThinking: boolean;
}

/** The replay facts {@link thinkingSurvivesAnthropicReplay} reads. */
type ThinkingReplayFacts = Pick<
	AssistantReplay<Api>,
	| "isSameModel"
	| "isAnthropicReplay"
	| "isLatestSurvivingAssistant"
	| "isSigningAnthropicTarget"
	| "invalidStopReason"
	| "abandonedToolUse"
	| "lastBlockIndex"
>;

/** Whether a visible thinking block of an Anthropic turn survives its replay. */
function thinkingSurvivesAnthropicReplay(
	facts: ThinkingReplayFacts,
	candidate: AssistantBlock,
	candidateIndex: number,
): boolean {
	if (candidate.type !== "thinking") return false;
	if (!facts.isAnthropicReplay) return false;
	if (facts.isLatestSurvivingAssistant && facts.abandonedToolUse) return true;
	const candidateSignatureUntrustworthy =
		facts.abandonedToolUse || (facts.invalidStopReason && candidateIndex === facts.lastBlockIndex);
	const replaySignature =
		candidateSignatureUntrustworthy && candidate.thinkingSignature ? undefined : candidate.thinkingSignature;
	if (!replaySignature && (!candidate.thinking || candidate.thinking.trim() === "")) return false;
	if (facts.isSameModel && facts.isSigningAnthropicTarget && (!replaySignature || replaySignature.trim() === "")) {
		return false;
	}
	return true;
}

function assistantReplay<TApi extends Api>(
	source: AssistantMessage,
	model: Model<TApi>,
	targetCompat: Model<TApi>["compat"],
	isLatestSurvivingAssistant: boolean,
	thinkingOrphaned: boolean,
): AssistantReplay<TApi> {
	const isSameModel = source.provider === model.provider && source.api === model.api && source.model === model.id;
	const isAnthropicTarget = isAnthropicMessagesModel(model);
	// Anthropic's all-or-none contract on prior-turn thinking blocks
	// applies to every `anthropic-messages → anthropic-messages` replay,
	// not just the latest assistant turn. The legacy
	// `mustPreserveLatestAnthropicThinking` flag only honored it for the
	// latest turn; every prior turn fell through to the cross-API
	// text-demotion path whenever the conversation crossed a model id,
	// silently dropping the reasoning chain on continuation for custom
	// anthropic-messages providers configured via `models.yaml` and
	// session-level model swaps (#2257).
	const isAnthropicReplay = isAnthropicTarget && source.api === "anthropic-messages";
	// Signature policy is a second axis. Anthropic cryptographically
	// binds reasoning signatures to its key+session+model, so cross-model
	// signatures must be stripped whenever a signing Anthropic endpoint
	// is on either end of the replay:
	//   * official Anthropic (source): the 3p target can't reverify a
	//     foreign signature and keeping it leaks continuation metadata
	//     for no benefit.
	//   * signing Anthropic (target): official Anthropic, GitHub Copilot,
	//     ZenMux, Cloudflare AI Gateway `/anthropic`, and Google Vertex
	//     `publishers/anthropic/…` all forward to signature-enforcing
	//     Anthropic. Any stale/cross-model signature on the wire triggers
	//     `400 Invalid signature in thinking block` — same failure class
	//     whether `officialEndpoint` is true or the endpoint is one of
	//     the known signing proxies (#4297).
	// 3p ↔ 3p replays preserve signatures because compatible providers
	// (Z.AI, DeepSeek, custom `models.yaml` providers) treat them as
	// opaque continuation hints rather than verified material; stripping
	// degrades the reasoning chain into unsigned/text on the next turn
	// (#2265). Source-side official detection uses the canonical catalog
	// provider id `"anthropic"` because assistant messages carry no
	// `baseUrl` — a user who manually points `provider: "anthropic"` at
	// a custom proxy via `models.yaml` will see signatures stripped, the
	// conservative direction (degraded reasoning, not broken requests).
	const isOfficialAnthropicSource = isAnthropicReplay && source.provider === "anthropic";
	const isSigningAnthropicTarget = isAnthropicTarget && model.compat.signingEndpoint;
	// Thinking signatures can be untrustworthy for two distinct reasons with very
	// different blast radii:
	//
	// 1. Aborted/errored turns: the stream stopped mid-block, so only the block
	//    that was streaming at the abort point — always the FINAL content block —
	//    can carry a partially-streamed (invalid) signature. Every earlier block
	//    completed: Anthropic delivers a block's signature at its
	//    `content_block_stop`, which necessarily fired before the next block began,
	//    so those signatures are whole and valid. Stripping them would needlessly
	//    discard a replayable thinking chain — e.g. interrupting during the visible
	//    text output after thinking already finished leaves a fully-signed thinking
	//    block that must be kept, or Anthropic rejects the replay with HTTP 400
	//    "Invalid `signature` in `thinking` block".
	//
	// 2. Abandoned tool-use turns: a turn that carries toolCall blocks but did NOT
	//    request tool execution (stopReason !== "toolUse" — e.g. adaptive-thinking
	//    Opus emitting tool calls and then ending on `end_turn`/`stop`). The agent
	//    loop pairs those calls with placeholder tool_results to keep the
	//    tool_use/tool_result contract valid. The turn completed cleanly, but its
	//    signatures are end_turn-bound and cannot be replayed in that synthesized
	//    continuation, so EVERY thinking signature is stripped.
	//
	// Latest abandoned turns are exempt because Anthropic requires thinking blocks
	// from its most recent response to remain byte-for-byte unmodified.
	const invalidStopReason = source.stopReason === "aborted" || source.stopReason === "error";
	const abandonedToolUse =
		!invalidStopReason && source.stopReason !== "toolUse" && source.content.some(b => b.type === "toolCall");
	const facts: ThinkingReplayFacts = {
		isSameModel,
		isAnthropicReplay,
		isLatestSurvivingAssistant,
		isSigningAnthropicTarget,
		invalidStopReason,
		abandonedToolUse,
		lastBlockIndex: source.content.length - 1,
	};
	return {
		...facts,
		source,
		model,
		targetCompat,
		isAnthropicTarget,
		signingAnthropicInvolved: isOfficialAnthropicSource || isSigningAnthropicTarget,
		// Compatible Anthropic-messages reasoning targets that accept
		// unsigned thinking natively (Z.AI, DeepSeek, the generic
		// `reasoning && !official` case in the compat builder). Used to keep
		// `redacted_thinking` siblings beside unsigned visible thinking on
		// targets that won't text-demote it.
		replaysUnsignedAnthropicThinking: isAnthropicTarget && model.compat.replayUnsignedThinking,
		replaysDemotedPriorReasoning: isAnthropicTarget && model.compat.replayDemotedPriorReasoning,
		officialAnthropicTarget: isAnthropicTarget && model.compat.officialEndpoint,
		thinkingOrphaned,
		dropsAllSameModelVisibleThinking:
			isAnthropicReplay &&
			isSameModel &&
			isSigningAnthropicTarget &&
			source.content.some(block => block.type === "thinking") &&
			!source.content.some((block, index) => thinkingSurvivesAnthropicReplay(facts, block, index)),
	};
}

/** Replay a thinking block of an `anthropic-messages` turn to an `anthropic-messages` target. */
function replayAnthropicThinking<TApi extends Api>(
	replay: AssistantReplay<TApi>,
	thinking: ThinkingContent,
): ThinkingContent | [] {
	let sanitized = thinking;
	// Cross-model prior turns crossing an official Anthropic endpoint
	// must strip the source signature so the downstream encoder
	// applies its `replayUnsignedThinking` policy (unsigned thinking
	// is emitted natively on Anthropic-compatible reasoning endpoints
	// and demoted to text on official Anthropic). 3p ↔ 3p replays
	// keep the signature so the reasoning chain stays signed on
	// continuation (#2265).
	if (
		!replay.isLatestSurvivingAssistant &&
		!replay.isSameModel &&
		replay.signingAnthropicInvolved &&
		sanitized.thinkingSignature
	) {
		sanitized = { ...sanitized, thinkingSignature: undefined };
	}
	// Drop blocks with neither a signature anchor nor any text —
	// nothing for the next turn to replay.
	if (!sanitized.thinkingSignature && (!sanitized.thinking || sanitized.thinking.trim() === "")) {
		return [];
	}
	// An unsigned thinking block cannot be replayed natively where the
	// endpoint enforces Anthropic's signature protocol, so it is dropped
	// entirely rather than demoted to text. Both undefined and empty
	// string signatures are invalid. Demotion would cause the
	// reasoning_extraction safety classifier to refuse the response.
	//
	// Same-model replay to a statically known signing endpoint always
	// drops: there is no reasoning to preserve across a switch that did
	// not happen.
	//
	// Otherwise the block keeps demoting by default, so cross-vendor
	// reasoning survives a model switch (#3434, #3528), and drops once
	// this endpoint has answered `reasoning_extraction` for it. That
	// second condition is keyed on the endpoint demoting unsigned
	// thinking rather than on `signingEndpoint`, because the prose the
	// classifier reads is produced by the demotion: it covers an
	// endpoint recognised up front, one learned from a live signing 400
	// (#4297, which clears `replayUnsignedThinking` and never
	// `signingEndpoint`), and a gateway that fronts Claude under its own
	// host, such as OpenCode Zen's `/zen/v1/messages`. The model
	// identity the block came from is invisible to the classifier, which
	// reads only the request.
	const signatureIsInvalid = !sanitized.thinkingSignature || sanitized.thinkingSignature.trim() === "";
	const demotesUnsignedThinking = !replay.replaysUnsignedAnthropicThinking;
	if (
		signatureIsInvalid &&
		((replay.isSameModel && replay.isSigningAnthropicTarget) ||
			(demotesUnsignedThinking && !replay.replaysDemotedPriorReasoning))
	) {
		return [];
	}
	return sanitized;
}

/** Replay a thinking block to a target that is not an Anthropic replay of it. */
function replayForeignThinking<TApi extends Api>(
	replay: AssistantReplay<TApi>,
	sanitized: ThinkingContent,
): ThinkingContent | TextContent | [] {
	// Cross-API target: same-model replay keeps signatures untouched
	// (the encoder needs them for native replay; an OpenAI encrypted
	// reasoning blob has empty text but a load-bearing signature).
	if (replay.isSameModel && sanitized.thinkingSignature) return sanitized;
	// Nothing left for the next turn to replay: drop empty/no-anchor
	// thinking blocks before the cross-model paths.
	if (!sanitized.thinking || sanitized.thinking.trim() === "") return [];
	if (replay.isSameModel) return sanitized;
	// Cross-model + cross-API: preserve native thinking only for
	// targets proven to read unsigned foreign reasoning (Z.AI-format
	// OpenAI-compatible targets, plus Anthropic-compatible
	// `replayUnsignedThinking`). Tool-call schema requirements and
	// llama.cpp cache-prefix replay are orthogonal encoder concerns;
	// keeping inert foreign CoT native for those flags loses the
	// canonical visible-text fallback without adding model context.
	if (targetReadsForeignThinking(replay.model, replay.targetCompat)) {
		return sanitized.thinkingSignature ? { ...sanitized, thinkingSignature: undefined } : sanitized;
	}
	// Other cross-API targets (openai-responses encrypted blobs, google
	// thought parts, anthropic-target from a non-Anthropic source, or any
	// reasoning-disabled target) can't replay an unsigned thinking block:
	// the native reasoning slot either rejects a foreign signature or — as
	// verified end-to-end against Gemini 3 — silently discards unsigned
	// thought content (it is neither recalled nor influences generation).
	// Demote to text so the reasoning survives as context, wrapped in the
	// TARGET model's own canonical thinking-block dialect (e.g. a ```thinking
	// fence for Gemini) so it reads as reasoning rather than bare prose the
	// model might mimic.
	// Mark the demoted block (symbol-keyed, never serialized) instead of
	// baking a separator into its text: the openai-completions flatten —
	// the one consumer that joins adjacent text blocks into a single
	// string — inserts a paragraph break after marked blocks, so the
	// bare Anthropic-dialect output (or any dialect's wrapped output
	// whose closing tag isn't a natural word boundary) can't glue onto
	// the following visible-text block, while ordinary adjacent text
	// blocks stitched from streaming / bridges / imported transcripts
	// stay byte-identical. A separator baked into the block text would
	// leak to non-flattening targets: Anthropic/Bedrock reject a
	// terminal assistant message whose text ends with whitespace.
	const demoted: TextContent & DemotedThinkingCarrier = {
		type: "text",
		text: renderDemotedThinking(replay.model.id, sanitized.thinking),
		[kDemotedThinking]: true,
	};
	return demoted;
}

function replayThinking<TApi extends Api>(
	replay: AssistantReplay<TApi>,
	block: ThinkingContent,
	blockIndex: number,
): ThinkingContent | TextContent | [] {
	// Only an aborted/errored turn's final (mid-stream) block can hold a
	// partial signature; abandoned tool-use turns strip all. Drop the
	// untrustworthy signature so the encoder can downgrade the block to text.
	const signatureUntrustworthy =
		replay.abandonedToolUse || (replay.invalidStopReason && blockIndex === replay.lastBlockIndex);
	const sanitized =
		signatureUntrustworthy && block.thinkingSignature ? { ...block, thinkingSignature: undefined } : block;
	if (!replay.isAnthropicReplay) return replayForeignThinking(replay, sanitized);
	// Latest abandoned turn: Anthropic's byte-for-byte rule forbids
	// even stripping a signature on the latest message.
	if (replay.isLatestSurvivingAssistant && replay.abandonedToolUse) return block;
	return replayAnthropicThinking(replay, sanitized);
}

/**
 * Redacted thinking is native-only. Keep it for same-model signed replay, the latest
 * byte-for-byte Anthropic turn, or compatible targets that will also emit sibling unsigned
 * thinking natively. Drop it when the matching visible thinking was discarded, or when
 * visible thinking was cross-model stripped and will be demoted to text.
 */
function redactedThinkingSurvivesReplay<TApi extends Api>(replay: AssistantReplay<TApi>): boolean {
	if (!replay.isAnthropicReplay) return replay.isSameModel;
	if (replay.dropsAllSameModelVisibleThinking) return false;
	return replay.isSameModel || replay.isLatestSurvivingAssistant || replay.replaysUnsignedAnthropicThinking;
}

/** Replay a tool call, normalizing an id the target cannot accept and recording the rename for its result. */
function replayToolCall<TApi extends Api>(
	replay: AssistantReplay<TApi>,
	toolCall: ToolCall,
	toolCallIdMap: Map<string, string>,
	normalizeToolCallId: ToolCallIdNormalizer<TApi> | undefined,
): ToolCall {
	let normalizedToolCall: ToolCall =
		!replay.isSameModel && toolCall.thoughtSignature ? { ...toolCall, thoughtSignature: undefined } : toolCall;
	const normalizedId = replay.isAnthropicTarget
		? normalizeAnthropicTargetToolCallId(toolCall.id, replay.model, replay.source, normalizeToolCallId)
		: !replay.isSameModel && normalizeToolCallId
			? normalizeToolCallId(toolCall.id, replay.model, replay.source)
			: toolCall.id;
	if (normalizedId !== toolCall.id) {
		toolCallIdMap.set(toolCall.id, normalizedId);
		normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
	}
	return normalizedToolCall;
}

function replayAssistantBlock<TApi extends Api>(
	replay: AssistantReplay<TApi>,
	block: AssistantBlock,
	blockIndex: number,
	toolCallIdMap: Map<string, string>,
	normalizeToolCallId: ToolCallIdNormalizer<TApi> | undefined,
): AssistantBlock | [] {
	switch (block.type) {
		case "thinking":
			return replay.thinkingOrphaned ? [] : replayThinking(replay, block, blockIndex);
		case "redactedThinking":
			return !replay.thinkingOrphaned && redactedThinkingSurvivesReplay(replay) ? block : [];
		case "fallback":
			// Server-side-fallback boundary marker (Anthropic beta
			// `server-side-fallback-2026-06-01`). Only the official
			// Anthropic endpoint accepts this block on replay: every
			// other target either rejects unknown content blocks with a
			// 400 (anthropic-compatible endpoints like Umans/Z.AI/MiniMax,
			// and older veyyon gateways whose schema pre-dates this feature)
			// or throws in its converter (Bedrock). Even the official
			// replay path only accepts the block when the current request
			// itself opts into the beta — but we don't know that here, so
			// keep it and let `convertAnthropicMessages` re-check the
			// per-request opt-in before serializing.
			return replay.officialAnthropicTarget ? block : [];
		case "text":
			return replay.isSameModel ? block : { type: "text", text: block.text };
		case "toolCall":
			return replayToolCall(replay, block, toolCallIdMap, normalizeToolCallId);
		default:
			return block;
	}
}

function replayAssistantMessage<TApi extends Api>(
	replay: AssistantReplay<TApi>,
	toolCallIdMap: Map<string, string>,
	normalizeToolCallId: ToolCallIdNormalizer<TApi> | undefined,
): AssistantMessage {
	const content = replay.source.content.flatMap((block, blockIndex) =>
		replayAssistantBlock(replay, block, blockIndex, toolCallIdMap, normalizeToolCallId),
	);
	// A demoted-thinking block that survived as the message's final block can
	// still end with the thinking text's own trailing whitespace (bare
	// Anthropic-dialect demotion copies it verbatim), and Anthropic rejects a
	// terminal assistant message whose text ends with trailing whitespace
	// ("final assistant content cannot end with trailing whitespace").
	// trimEnd() is safe: demoted text is synthesized context, never
	// byte-exact replay material.
	const finalBlock = content[content.length - 1];
	if (finalBlock?.type === "text" && isDemotedThinking(finalBlock)) {
		content[content.length - 1] = { ...finalBlock, text: finalBlock.text.trimEnd() };
	}
	return { ...replay.source, content };
}

type IndexedToolResult = { index: number; msg: ToolResultMessage; consumed: boolean };

/**
 * The second pass of {@link transformMessages}: each surviving assistant tool call is followed
 * immediately by exactly one corresponding tool result.
 */
class ToolResultPairing {
	readonly output: Message[] = [];
	// All real tool results, keyed by id, in document order. One id can map to
	// more than one result: compaction can fold an assistant `tool_use` into a
	// summary string while its `tool_result` survives, and a later turn may reuse
	// the id. `#takeRealToolResult` pulls the earliest unconsumed result positioned
	// AFTER the call's assistant turn, so an orphaned earlier result is never
	// pulled forward onto a later call (which would surface a prior turn's output).
	readonly #realToolResultsById = new Map<string, IndexedToolResult[]>();
	// Anthropic rejects `tool_result` blocks whose `tool_use_id` does not appear in a prior
	// `tool_use` block. After handoff/compaction folds an assistant turn into a summary
	// string, the user-side `toolResult` for that turn can survive while the originating
	// `tool_use` disappears — leaving an orphan that triggers HTTP 400. Track the set of
	// `tool_use` ids that survive transformation so orphans are dropped cleanly.
	readonly #validToolUseIds = new Set<string>();
	// Track which tool calls already have an emitted result so delayed/duplicate
	// toolResult messages cannot create a second provider-visible result.
	readonly #toolCallStatus = new Map<string, ToolCallStatus>();
	readonly #model: Pick<Model, "provider" | "id">;
	#pendingToolCalls: ToolCall[] = [];
	// Index of the assistant turn that declared `#pendingToolCalls`; a pulled
	// result must be positioned after it (see `#takeRealToolResult`).
	#pendingToolCallsStartIndex = -1;
	#pendingAbortedToolCalls = new Map<string, ToolCall>();
	#pendingAbortedTimestamp: number | undefined;
	#pendingAbortedStartIndex = -1;

	constructor(messages: readonly Message[], model: Pick<Model, "provider" | "id">) {
		this.#model = model;
		for (let index = 0; index < messages.length; index++) {
			const msg = messages[index];
			if (msg.role === "toolResult") {
				const entry: IndexedToolResult = { index, msg, consumed: false };
				const entries = this.#realToolResultsById.get(msg.toolCallId);
				if (entries) entries.push(entry);
				else this.#realToolResultsById.set(msg.toolCallId, [entry]);
			} else if (msg.role === "assistant") {
				for (const block of msg.content) {
					if (block.type === "toolCall") this.#validToolUseIds.add(block.id);
				}
			}
		}
	}

	/** Append a message that neither declares nor answers a tool call. */
	append(msg: Message): void {
		this.output.push(msg);
	}

	/** Append an assistant turn and open the result window for its tool calls. */
	appendAssistant(msg: AssistantMessage, index: number): void {
		const toolCalls = msg.content.filter(b => b.type === "toolCall") as ToolCall[];
		this.output.push(msg);
		if (msg.stopReason === "error" || msg.stopReason === "aborted") {
			// Keep the assistant message with tool calls intact. Real tool results are
			// emitted immediately if available; otherwise synthesize aborted results
			// before the next turn boundary.
			this.#pendingAbortedToolCalls = new Map(toolCalls.map(toolCall => [toolCall.id, toolCall] as const));
			this.#pendingAbortedTimestamp = msg.timestamp;
			this.#pendingAbortedStartIndex = index;
			return;
		}
		if (toolCalls.length > 0) {
			this.#pendingToolCalls = toolCalls;
			this.#pendingToolCallsStartIndex = index;
		}
	}

	/** Append a tool result that answers a call in an open window, or fold one whose call is gone. */
	appendToolResult(msg: ToolResultMessage, timestamp: number): void {
		const id = msg.toolCallId;
		if (this.#toolCallStatus.has(id)) return;
		if (this.#pendingAbortedToolCalls.has(id)) {
			this.#pendingAbortedToolCalls.delete(id);
			this.#emitReal(msg);
			return;
		}
		if (this.#pendingToolCalls.some(tc => tc.id === id)) {
			this.#emitReal(msg);
			return;
		}
		// The matching tool_use exists elsewhere, but this result is not in
		// the currently open result window. Emitting it here would break the
		// provider invariant; the first real result is pulled into the correct
		// slot by the pending-call flush instead.
		if (this.#validToolUseIds.has(id)) return;
		// Orphan `tool_result`: the originating `tool_use` is not present in the
		// transformed history (typically because handoff/compaction folded the
		// assistant message into a summary string while the user-side result
		// survived). Sending the block as-is would 400 the request, so it must
		// be dropped.
		//
		// If a pending tool-call window is still open (either normal or
		// aborted), the orphan cannot be replaced with a developer note here:
		//
		// * Anthropic requires the next message after an assistant `tool_use`
		//   to be the matching `tool_result`. Inserting a developer message
		//   would break that contiguity.
		// * Flushing pending aborted calls here would wedge synthetic results
		//   between the assistant turn and a real result that may still arrive
		//   inside the current contiguous result window.
		//
		// Drop the orphan silently in that case; the pending calls will be
		// resolved in their own contiguous result window or at the next boundary.
		if (
			this.#pendingToolCalls.some(tc => !this.#toolCallStatus.has(tc.id)) ||
			this.#pendingAbortedToolCalls.size > 0
		) {
			return;
		}
		this.#foldOrphan(msg, timestamp);
	}

	/**
	 * Answer every call in the open result windows: with its real result when one follows its
	 * turn, and with a placeholder error result otherwise.
	 */
	closeWindows(timestamp: number): void {
		if (this.#pendingToolCalls.length > 0) {
			this.#answer(
				this.#pendingToolCalls,
				this.#pendingToolCallsStartIndex,
				"No result provided",
				timestamp,
				ToolCallStatus.Resolved,
			);
			this.#pendingToolCalls = [];
		}
		if (this.#pendingAbortedTimestamp !== undefined) {
			this.#answer(
				this.#pendingAbortedToolCalls.values(),
				this.#pendingAbortedStartIndex,
				"aborted",
				this.#pendingAbortedTimestamp,
				ToolCallStatus.Aborted,
			);
			this.#pendingAbortedToolCalls = new Map();
			this.#pendingAbortedTimestamp = undefined;
		}
	}

	#emitReal(msg: ToolResultMessage): void {
		this.#toolCallStatus.set(msg.toolCallId, ToolCallStatus.Resolved);
		this.output.push(msg);
	}

	#answer(
		toolCalls: Iterable<ToolCall>,
		afterIndex: number,
		placeholder: string,
		timestamp: number,
		placeholderStatus: ToolCallStatus,
	): void {
		for (const tc of toolCalls) {
			if (this.#toolCallStatus.has(tc.id)) continue;
			const realToolResult = this.#takeRealToolResult(tc.id, afterIndex);
			if (realToolResult) {
				this.#emitReal(realToolResult);
				continue;
			}
			this.output.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
				content: [{ type: "text", text: placeholder }],
				isError: true,
				timestamp,
			} as ToolResultMessage);
			this.#toolCallStatus.set(tc.id, placeholderStatus);
		}
	}

	#takeRealToolResult(id: string, afterIndex: number): ToolResultMessage | undefined {
		const entries = this.#realToolResultsById.get(id);
		if (!entries) return undefined;
		for (const entry of entries) {
			if (entry.consumed || entry.index <= afterIndex) continue;
			entry.consumed = true;
			return entry.msg;
		}
		return undefined;
	}

	/**
	 * Preserve an orphan result's text as a user note so the model still sees what the tool
	 * returned. staleToolResultNote owns both the envelope and the rule that it rides on
	 * `role: "user"`.
	 */
	#foldOrphan(msg: ToolResultMessage, timestamp: number): void {
		const textParts: string[] = [];
		for (const part of msg.content) {
			if (part.type === "text" && part.text.trim() !== "") textParts.push(part.text);
		}
		if (textParts.length === 0) return;
		logger.warn("transform-messages: folding a tool result whose call is missing from the history", {
			provider: this.#model.provider,
			model: this.#model.id,
			toolName: msg.toolName,
			toolCallId: msg.toolCallId,
		});
		this.output.push({
			role: "user",
			content: staleToolResultNote({
				toolName: msg.toolName,
				toolCallId: msg.toolCallId,
				text: textParts.join("\n"),
				isError: msg.isError,
			}),
			timestamp,
		} as UserMessage);
	}
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 *
 * For aborted/errored turns, this function:
 * - Preserves tool call structure (unlike converting to text summaries)
 * - Injects synthetic "aborted" tool results
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
	maxNormalizedToolCallIdLength = MAX_TOOL_CALL_ID_LENGTH,
	duplicateToolCallIdSuffixPrefix = "_dup",
	targetCompat: Model<TApi>["compat"] = model.compat,
): Message[] {
	// Sessions recorded before the repair rode `role: "user"` hold the note as
	// real assistant text, because the model reproduced it and the reply was
	// persisted like any other. Replaying one primes the same imitation again,
	// so a resumed session would keep emitting tool results as prose long after
	// the repair was fixed. Strip it on the way out of storage.
	messages = dropLegacyStaleToolNotes(messages);

	// Drop assistant `toolCall` blocks with empty/whitespace `id` or `name`
	// (and their matched `toolResult` messages) before anything else looks at
	// the history. Replays of these would 400 every provider — see
	// `sanitizeMalformedToolCalls`.
	messages = sanitizeMalformedToolCalls(messages);

	// Prior reasoning carried as prose is subject to the same replay policy as
	// an unsigned thinking block, and the target is only known here.
	messages = dropUndeliverableDemotedReasoning(messages, model);

	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	const latestSurvivingAssistantIndex = getLatestSurvivingAssistantIndex(messages);
	const orphanedThinkingAssistantIndexes = model.thinking?.prefixBinding
		? assistantsBeforeHistoryRewrite(messages)
		: undefined;
	// First pass: transform messages (thinking blocks, tool call ID normalization)
	const normalizedMessages = messages.map((msg, index): Message => {
		// User and developer messages pass through unchanged
		if (msg.role === "user" || msg.role === "developer") {
			return msg;
		}
		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			return normalizedId && normalizedId !== msg.toolCallId ? { ...msg, toolCallId: normalizedId } : msg;
		}
		if (msg.role === "assistant") {
			const replay = assistantReplay(
				msg as AssistantMessage,
				model,
				targetCompat,
				index === latestSurvivingAssistantIndex,
				orphanedThinkingAssistantIndexes?.has(index) === true,
			);
			return replayAssistantMessage(replay, toolCallIdMap, normalizeToolCallId);
		}
		return msg;
	});
	const transformed = deduplicateToolCallIds(
		normalizedMessages,
		maxNormalizedToolCallIdLength,
		duplicateToolCallIdSuffixPrefix,
	);

	// Second pass: ensure each surviving assistant tool call is immediately
	// followed by exactly one corresponding tool result.
	const pairing = new ToolResultPairing(transformed, model);
	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];
		const messageTimestamp = "timestamp" in msg && typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
		if (msg.role === "toolResult") {
			pairing.appendToolResult(msg, messageTimestamp);
			continue;
		}
		pairing.closeWindows(messageTimestamp);
		if (msg.role !== "assistant") {
			pairing.append(msg);
			continue;
		}
		// Drop assistant turns that carry no actionable content (no `text`, no `toolCall`)
		// AND were terminated by a truncating stop reason (`length` / `error` / `aborted`).
		// These are produced when the provider returns `stop_reason: "max_tokens"` (or a
		// stream error) mid-thinking, leaving a `[thinking]`-only message with a valid
		// signature but nothing for the next turn to anchor on. Keeping it creates
		// back-to-back assistant turns once the next response lands, which Anthropic
		// rejects with "messages.X.content.Y: `thinking` blocks in the latest assistant
		// message cannot be modified".
		//
		// `stopReason: "stop"` thinking-only messages are intentionally preserved: they
		// represent reasoning-only assistant turns used for replay round-trips
		// (OpenAI completions `reasoning_text`, Google signed thought parts).
		const originalMsg = messages[i]!;
		if (originalMsg.role === "assistant" && shouldDropTruncatedThinkingOnlyAssistant(originalMsg)) {
			continue;
		}
		pairing.appendAssistant(msg as AssistantMessage, i);
	}
	pairing.closeWindows(Date.now());
	return pairing.output;
}
