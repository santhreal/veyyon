/**
 * How many tokens the session is holding, by category.
 *
 * This is accounting, not drawing. It lived under `modes/utils/` next to the panel
 * that renders it, which put a number the session engine needs behind the terminal
 * UI: `session/agent-session.ts` imported it, and the layering gate had to carry a
 * standing exception saying so. The panel is still in `modes/terminal/utils/context-usage.ts`
 * and imports from here.
 *
 * The category rows carry an id and a token count and no colour or glyph. Those are
 * the panel's choice, keyed on the id, so a second surface can report the same
 * numbers without inheriting the grid's palette.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import type { CompactionSettings } from "@veyyon/agent-core/compaction";
import { estimateTokens } from "@veyyon/agent-core/compaction";
import type { ContextSnapshot, Model } from "@veyyon/ai";
import type { SessionTelemetryDetail } from "@veyyon/ai/instrumentation";
import { resolveContextLimit } from "../config/compaction-strategy";
import type { AgentSession } from "./agent-session";
import { computeNonMessageBreakdown } from "./non-message-tokens";

export interface ContextSnapshotAttribution {
	storedMessagesTokens: number;
	tailTokens: number;
	promptTokensSource: "provider" | "estimate";
	compactionEntryId?: string;
}
/**
 * Split an already-computed prompt total into stored-message and request-tail
 * estimates. Clamping the tail to the message subtotal makes the relationship
 * additive even after compaction rebases a pending snapshot.
 */
export function estimateContextSnapshotAttribution(
	promptTokens: number,
	nonMessageTokens: number,
	tailTokens: number,
	promptTokensSource: ContextSnapshotAttribution["promptTokensSource"],
	compactionEntryId?: string,
): ContextSnapshotAttribution {
	const messageTokens = Math.max(0, promptTokens - nonMessageTokens);
	const normalizedTailTokens = Math.min(messageTokens, Math.max(0, tailTokens));
	return {
		storedMessagesTokens: messageTokens - normalizedTailTokens,
		tailTokens: normalizedTailTokens,
		promptTokensSource,
		compactionEntryId,
	};
}

/**
 * Build the persisted per-turn context record at the canonical telemetry detail.
 *
 * The caller supplies totals it already computed for request accounting. This
 * boundary deliberately does no tokenization: richer session data must not add
 * another walk over the prompt hot path.
 */
export function buildContextSnapshot(
	promptTokens: number,
	nonMessageTokens: number,
	detail: SessionTelemetryDetail,
	attribution: ContextSnapshotAttribution,
): ContextSnapshot {
	if (detail !== "rich" && detail !== "ultra") return { promptTokens, nonMessageTokens };

	const snapshot: ContextSnapshot = {
		promptTokens,
		nonMessageTokens,
		storedMessagesTokens: attribution.storedMessagesTokens,
		tailTokens: attribution.tailTokens,
		promptTokensSource: attribution.promptTokensSource,
		nonMessageTokensEstimated: true,
		storedMessagesTokensEstimated: true,
		tailTokensEstimated: true,
	};
	if (detail === "ultra" && attribution.compactionEntryId) {
		snapshot.compactionEntryId = attribution.compactionEntryId;
	}
	return snapshot;
}

export type CategoryId = "systemPrompt" | "systemContext" | "systemTools" | "skills" | "messages";

export interface CategoryInfo {
	id: CategoryId;
	label: string;
	tokens: number;
}

export interface ContextBreakdown {
	model: Model | undefined;
	contextWindow: number;
	categories: CategoryInfo[];
	usedTokens: number;
	autoCompactBufferTokens: number;
	freeTokens: number;
	/**
	 * Bytes this session has kept OUT of the request, cumulative across every
	 * turn so far.
	 *
	 * The panel above it answers "what is in my context". This answers "what is
	 * not, and why", which is the other half and was previously invisible: two
	 * mechanisms were quietly shrinking every request and the only way to know
	 * either was working was to read the source. A saving nobody can see is a
	 * saving nobody notices break.
	 */
	elidedBytes: { wirePaths: number; thoughtSignatures: number };
}
/**
 * Incremental cache for {@link computeStoredMessagesTokens} (P5, BACKLOG perf
 * hotspots). `estimateTokens` itself already memoizes each message's token
 * count by identity (see `estimateTokens`/`tokenEstimateCache` in
 * `@veyyon/agent-core/compaction`), but the pre-prompt, mid-turn, and
 * post-turn compaction checks each re-summed the FULL `session.messages`
 * array on every call — an O(n) history walk repeated several times per turn
 * even when nothing in the history had changed since the last call.
 *
 * Each slot's `settledLength`/`settledSum` cover `[0, settledLength)` for the
 * current `messagesRef`. The array's last slot is deliberately excluded from the
 * settled range and re-read every call: `agent-loop.ts` replaces
 * `messages[messages.length - 1]` in place while streaming (partial → final
 * assistant message), which keeps the same array reference and length but
 * swaps the message identity — folding that slot into the settled sum would
 * silently return a stale estimate. Any reference change or length shrink
 * (rewind, `Agent#pop`, compaction replacing the array) resets the cache.
 *
 * The running sum is kept per option variant, for the reason `estimateTokens`
 * keeps its own two slots: `excludeEncryptedReasoning` changes what a message
 * with encrypted reasoning measures, so one shared sum would answer a caller
 * with the total the other caller asked for.
 */
interface SettledPrefix {
	settledLength: number;
	settledSum: number;
}

interface StoredMessagesTokenCache {
	messagesRef: AgentMessage[];
	default: SettledPrefix;
	noReasoning: SettledPrefix;
}

const storedMessagesTokenCache = new WeakMap<AgentSession, StoredMessagesTokenCache>();

/**
 * Local token estimate of `session.messages` alone (no non-message or
 * pending-message contribution — callers add those separately, mirroring
 * {@link computeNonMessageTokens}). See {@link StoredMessagesTokenCache} for
 * why the array's last slot is always re-measured rather than cached.
 */
export function computeStoredMessagesTokens(
	session: AgentSession,
	options?: { excludeEncryptedReasoning?: boolean },
): number {
	const messages = session.messages ?? [];
	const settledLength = Math.max(0, messages.length - 1);

	let cache = storedMessagesTokenCache.get(session);
	if (
		!cache ||
		cache.messagesRef !== messages ||
		cache.default.settledLength > settledLength ||
		cache.noReasoning.settledLength > settledLength
	) {
		cache = {
			messagesRef: messages,
			default: { settledLength: 0, settledSum: 0 },
			noReasoning: { settledLength: 0, settledSum: 0 },
		};
	}
	const slot = options?.excludeEncryptedReasoning ? cache.noReasoning : cache.default;
	for (let i = slot.settledLength; i < settledLength; i++) {
		slot.settledSum += estimateTokens(messages[i]!, options);
	}
	slot.settledLength = settledLength;
	storedMessagesTokenCache.set(session, cache);

	const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
	const lastTokens = lastMessage ? estimateTokens(lastMessage, options) : 0;
	return slot.settledSum + lastTokens;
}

/**
 * Compute a breakdown of estimated context usage by category for the active
 * session and model.
 */
export function computeContextBreakdown(session: AgentSession): ContextBreakdown {
	const model = session.model;
	const contextWindow = model?.contextWindow ?? 0;

	const breakdown = typeof session.getContextBreakdown === "function" ? session.getContextBreakdown() : undefined;

	let messagesTokens = 0;
	let skillsTokens = 0;
	let toolsTokens = 0;
	let systemContextTokens = 0;
	let systemPromptTokens = 0;
	let usedTokens = 0;

	if (breakdown) {
		messagesTokens = breakdown.messagesTokens;
		skillsTokens = breakdown.skillsTokens;
		toolsTokens = breakdown.systemToolsTokens;
		systemContextTokens = breakdown.systemContextTokens;
		systemPromptTokens = breakdown.systemPromptTokens;
		usedTokens = breakdown.usedTokens;
	} else {
		const convo = session.messages;
		if (convo) {
			for (const message of convo) {
				messagesTokens += estimateTokens(message);
			}
		}
		const nonMessage = computeNonMessageBreakdown(session);
		skillsTokens = nonMessage.skillsTokens;
		toolsTokens = nonMessage.toolsTokens;
		systemContextTokens = nonMessage.systemContextTokens;
		systemPromptTokens = nonMessage.systemPromptTokens;
		usedTokens = skillsTokens + toolsTokens + systemContextTokens + systemPromptTokens + messagesTokens;
	}

	const categories: CategoryInfo[] = [
		{ id: "systemPrompt", label: "System prompt", tokens: systemPromptTokens },
		{ id: "systemTools", label: "System tools", tokens: toolsTokens },
		{ id: "systemContext", label: "System context", tokens: systemContextTokens },
		{ id: "skills", label: "Skills", tokens: skillsTokens },
		{ id: "messages", label: "Messages", tokens: messagesTokens },
	];

	// The buffer is the room between the fire point and the window: the part of the
	// window auto-compaction will not let you use. `resolveContextLimit` is the one
	// owner of where that point is, shared with the status-line gauge, so the panel
	// and the gauge cannot disagree about whether compaction will fire.
	//
	// There is no invented buffer when it will not fire. This used to substitute
	// `effectiveReserveTokens` whenever the computed buffer came out zero and
	// `compaction.enabled` was set — so a session with `strategy: "off"` was shown a
	// labelled "Autocompact buffer" that nothing would ever enforce, and the panel
	// disagreed with the status line, which correctly denominates against the whole
	// window in that configuration. A displayed reserve no mechanism honours is the
	// same class of bug as printing the fire point where the window belongs.
	let autoCompactBufferTokens = 0;
	if (contextWindow > 0) {
		const compactionSettings = session.settings.getGroup("compaction") as CompactionSettings;
		const limit = resolveContextLimit(contextWindow, compactionSettings);
		autoCompactBufferTokens = limit.kind === "compaction" ? Math.max(0, contextWindow - limit.tokens) : 0;
	}
	autoCompactBufferTokens = Math.min(autoCompactBufferTokens, Math.max(0, contextWindow - usedTokens));

	const freeTokens = Math.max(0, contextWindow - usedTokens - autoCompactBufferTokens);

	return {
		model,
		contextWindow,
		categories,
		usedTokens,
		autoCompactBufferTokens,
		freeTokens,
		elidedBytes: {
			wirePaths: session.wirePathBytesSaved ?? 0,
			thoughtSignatures: session.thoughtSignatureBytesSaved ?? 0,
		},
	};
}
