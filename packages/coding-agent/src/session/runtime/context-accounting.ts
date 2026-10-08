/**
 * Context accounting: how many tokens the next request carries, and where they go.
 *
 * This is a session collaborator. It holds the prompt snapshot of the run in flight, the revision
 * counter the status line memoizes on, and the branch entry that bounds which provider usage still
 * describes the prompt, and reaches the session only through {@link ContextAccountingHost}.
 *
 * - **The breakdown** ({@link breakdown}) anchors on the newest provider-reported prompt size after
 *   the latest compaction and in-place rewrite, estimates only the tail after it, and floors the
 *   total by the local estimate of the stored conversation, so the gauge and every compaction
 *   decision read one number.
 * - **The resting usage** ({@link restingUsage}) reads the same total with the non-message size the
 *   newest anchor recorded standing in for a measurement, so a reader at rest builds no tool schema.
 * - **The prompt snapshot** ({@link beginPrompt}, {@link endPrompt}) accounts for a submitted prompt
 *   until a response of the same run reports usage.
 * - **A history rewrite** ({@link markHistoryRewritten}, {@link rebaseAfterHistoryRewrite}) retires
 *   every usage anchor that measured the old history and re-measures the prompt snapshot.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import { calculatePromptTokens, compactionContextTokens, estimateTokens } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { type InstrumentationLevel, sessionTelemetryDetail } from "@veyyon/ai/instrumentation";
import { getLatestCompactionEntry } from "@veyyon/kernel/session/session-context";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { ContextUsageBreakdown, PendingContextSnapshot } from "../agent-session-types";
import { estimateContextSnapshotAttribution } from "../context-usage";

/** The four non-message token totals of the prompt: skills, tool schemas, system context, system prompt. */
export interface NonMessageBreakdown {
	skillsTokens: number;
	toolsTokens: number;
	systemContextTokens: number;
	systemPromptTokens: number;
}

/** The session log slice accounting reads. `SessionManager` satisfies this. */
export interface ContextAccountingStore {
	getBranch(): SessionEntry[];
}

/** What {@link ContextAccounting} needs from the session that holds it. */
export interface ContextAccountingHost {
	readonly sessionStore: ContextAccountingStore;
	model(): Model | undefined;
	/** The live context, in the order the next request sends it. */
	messages(): AgentMessage[];
	/** `session.instrumentation` as of now. */
	instrumentationLevel(): InstrumentationLevel;
	/** Tokens the prompt spends outside the message list. */
	nonMessageTokens(): number;
	nonMessageBreakdown(): NonMessageBreakdown;
	/** Local estimate of the live context's messages, excluding encrypted reasoning. */
	storedMessagesTokens(): number;
}

/** Local estimate options: encrypted reasoning is billed by the provider, not measured here. */
const STORED_ESTIMATE = { excludeEncryptedReasoning: true } as const;

function sumTokens(messages: readonly AgentMessage[], from = 0): number {
	let total = 0;
	for (let index = from; index < messages.length; index++) total += estimateTokens(messages[index]);
	return total;
}

function usableAnchor(message: AgentMessage): message is AssistantMessage {
	return (
		message.role === "assistant" &&
		message.stopReason !== "aborted" &&
		message.stopReason !== "error" &&
		!!message.usage
	);
}

function toUsage(tokens: number, contextWindow: number): ContextUsage {
	return { tokens, contextWindow, percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : 0 };
}

export class ContextAccounting {
	readonly #host: ContextAccountingHost;
	#pending: PendingContextSnapshot | undefined;
	/**
	 * Last branch entry present when a pass last rewrote history in place. Every provider usage
	 * anchor at or before it reports a prompt that no longer exists, so {@link breakdown} does not
	 * read one as ground truth.
	 */
	#rewriteBoundaryEntryId: string | undefined;
	#revision = 0;

	constructor(host: ContextAccountingHost) {
		this.#host = host;
	}

	/**
	 * Changes whenever the prompt snapshot is set or cleared. The status line memoizes the context
	 * figure on it, so clearing the snapshot at turn end or abort invalidates a mid-turn estimate
	 * even though the message list is unchanged.
	 */
	get revision(): number {
		return this.#revision;
	}

	/** The prompt accounting of the run in flight, if one is. */
	get pending(): PendingContextSnapshot | undefined {
		return this.#pending;
	}

	/**
	 * Current context usage by category. Uses the last assistant message's usage when one describes
	 * the current prompt, and estimates every message otherwise.
	 */
	breakdown(options?: { contextWindow?: number; pendingMessages?: AgentMessage[] }): ContextUsageBreakdown {
		const host = this.#host;
		const { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens } = host.nonMessageBreakdown();
		const categoryNonMessageTokens = skillsTokens + toolsTokens + systemContextTokens + systemPromptTokens;
		const branchEntries = host.sessionStore.getBranch();
		const pendingMessages = options?.pendingMessages ?? [];
		const pendingMessagesTokens = sumTokens(pendingMessages);
		const { anchored, usedTokens } = this.#usedTokens(
			host.nonMessageTokens(),
			branchEntries,
			this.#anchor(branchEntries),
			pendingMessages,
			pendingMessagesTokens,
		);
		return {
			contextWindow: this.#contextWindow(options?.contextWindow),
			anchored,
			usedTokens,
			systemPromptTokens,
			systemToolsTokens: toolsTokens,
			systemContextTokens,
			skillsTokens,
			messagesTokens: Math.max(0, usedTokens - categoryNonMessageTokens),
			pendingMessagesTokens,
		};
	}

	usage(options?: { contextWindow?: number }): ContextUsage {
		const breakdown = this.breakdown(options);
		return toUsage(breakdown.usedTokens, breakdown.contextWindow);
	}

	/**
	 * Context usage read without measuring the prompt's non-message half: the size the newest usage
	 * anchor recorded in its context snapshot stands in for the current one, so no tool schema is
	 * built. The figure equals {@link usage} while the tools, skills and system prompt match the ones
	 * that anchor was sent with. Undefined while a prompt is in flight and when no anchor recorded
	 * its non-message size.
	 */
	restingUsage(): ContextUsage | undefined {
		if (this.#pending) return undefined;
		const branchEntries = this.#host.sessionStore.getBranch();
		const anchor = this.#anchor(branchEntries);
		const recorded = anchor?.contextSnapshot?.nonMessageTokens;
		if (recorded === undefined) return undefined;
		const { usedTokens } = this.#usedTokens(recorded, branchEntries, anchor, [], 0);
		return toUsage(usedTokens, this.#contextWindow(undefined));
	}

	#contextWindow(requested: number | undefined): number {
		const raw = requested ?? this.#host.model()?.contextWindow ?? 0;
		return Number.isFinite(raw) && raw > 0 ? raw : 0;
	}

	/**
	 * The newest assistant response whose provider usage still describes the prompt: after the latest
	 * compaction and after the last in-place rewrite. A pass that rewrote history in place (a prune,
	 * the dedup, a shake, an image drop) moves that floor forward too. The provider computed its
	 * prompt tokens over bytes the rewrite has since removed, so an anchor at or before the rewrite
	 * reads high by exactly what was freed. Only a response received after the rewrite describes the
	 * current shape.
	 */
	#anchor(branchEntries: SessionEntry[]): AssistantMessage | undefined {
		const latestCompaction = getLatestCompactionEntry(branchEntries);
		const compactionIndex = latestCompaction ? branchEntries.lastIndexOf(latestCompaction) : -1;
		const rewriteBoundaryId = this.#rewriteBoundaryEntryId;
		const rewriteIndex = rewriteBoundaryId ? branchEntries.findIndex(entry => entry.id === rewriteBoundaryId) : -1;
		const anchorFloorIndex = Math.max(compactionIndex, rewriteIndex);
		for (let i = branchEntries.length - 1; i > anchorFloorIndex; i--) {
			const entry = branchEntries[i];
			if (entry.type === "message" && usableAnchor(entry.message)) return entry.message;
		}
		return undefined;
	}

	/**
	 * Tokens the next request carries when the prompt spends `currentNonMessageTokens` outside the
	 * message list, and whether a provider figure or the prompt snapshot contributed. The anchor is
	 * ground truth for everything up to it; only the tail after it is estimated.
	 */
	#usedTokens(
		currentNonMessageTokens: number,
		branchEntries: readonly SessionEntry[],
		anchor: AssistantMessage | undefined,
		pendingMessages: readonly AgentMessage[],
		pendingMessagesTokens: number,
	): { anchored: boolean; usedTokens: number } {
		const host = this.#host;
		let usedTokens = 0;
		let anchored = false;
		const pending = this.#pending;

		const messages = host.messages();
		let anchorIndex = -1;
		if (anchor) {
			anchorIndex = messages.indexOf(anchor);
			if (anchorIndex === -1) {
				anchorIndex = messages.findIndex(msg => msg.role === "assistant" && msg.timestamp === anchor.timestamp);
			}
		}

		// A real anchor supersedes the in-flight estimate only once a step of the current turn has
		// produced provider usage, i.e. it resolves at or after the pending cutoff. While the turn's
		// first response is still pending, or the newest real anchor predates this turn, the pending
		// snapshot is the only thing accounting for the submitted prompt, so it wins. This keeps a long
		// tool turn from stacking an estimate of the entire tail on top of a stale turn-start prompt.
		const useAnchor = anchor !== undefined && anchorIndex !== -1 && (!pending || anchorIndex >= pending.cutoffCount);

		if (useAnchor && anchor) {
			const promptTokens = anchor.contextSnapshot?.promptTokens ?? calculatePromptTokens(anchor.usage);
			const nonMessageTokens = anchor.contextSnapshot?.nonMessageTokens ?? currentNonMessageTokens;
			anchored = true;
			usedTokens =
				promptTokens +
				Math.max(0, currentNonMessageTokens - nonMessageTokens) +
				sumTokens(messages, anchorIndex + 1) +
				pendingMessagesTokens;
		} else if (pending) {
			anchored = true;
			let tailTokens = 0;
			for (let i = pending.cutoffCount; i < messages.length; i++) {
				const message = messages[i];
				// A submitted message is already inside `promptTokens`; anything else standing after the
				// turn boundary arrived since and is estimated.
				if (pending.submitted.has(message)) continue;
				tailTokens += estimateTokens(message);
			}
			usedTokens =
				pending.promptTokens +
				Math.max(0, currentNonMessageTokens - pending.nonMessageTokens) +
				tailTokens +
				pendingMessagesTokens;
		}

		if (!anchored && !pending && branchEntries.length === 0) {
			// A session with no branch (an in-memory or test session): anchor on the live context's
			// latest assistant usage instead.
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i];
				if (!usableAnchor(msg)) continue;
				const promptTokens = msg.contextSnapshot?.promptTokens ?? calculatePromptTokens(msg.usage);
				const nonMessageTokens = msg.contextSnapshot?.nonMessageTokens ?? currentNonMessageTokens;
				usedTokens =
					promptTokens +
					Math.max(0, currentNonMessageTokens - nonMessageTokens) +
					sumTokens(messages, i + 1) +
					pendingMessagesTokens;
				anchored = true;
				break;
			}
		}
		if (!anchored) {
			usedTokens = currentNonMessageTokens + sumTokens(messages) + pendingMessagesTokens;
		}

		// Every compaction decision floors the provider-anchored total by the local estimate of what
		// the session holds, because a provider reporting a prompt smaller than the stored conversation
		// must not suppress compaction. The gauge applies the same floor, so display and decision read
		// one total.
		return {
			anchored,
			usedTokens: compactionContextTokens(usedTokens, this.#storedTokens(currentNonMessageTokens, pendingMessages)),
		};
	}

	/**
	 * Local token estimate of the stored conversation plus {@link pendingMessages}, independent of
	 * provider-reported usage. A `before_provider_request` hook or other on-wire transform can shrink
	 * the request below the stored conversation, and the provider then reports a deflated prompt;
	 * this estimate is the floor the compaction decision respects, so on-wire compression cannot
	 * suppress compaction. Encrypted reasoning is excluded: its local size diverges from what the
	 * provider bills, and the provider usage already accounts for it.
	 */
	estimateStoredTokens(pendingMessages: readonly AgentMessage[] = []): number {
		return this.#storedTokens(this.#host.nonMessageTokens(), pendingMessages);
	}

	#storedTokens(nonMessageTokens: number, pendingMessages: readonly AgentMessage[]): number {
		let pendingTokens = 0;
		for (const message of pendingMessages) pendingTokens += estimateTokens(message, STORED_ESTIMATE);
		return nonMessageTokens + this.#host.storedMessagesTokens() + pendingTokens;
	}

	/** Account for a submitted prompt until a response of this run reports usage. */
	beginPrompt(messages: AgentMessage[]): void {
		const host = this.#host;
		const nonMessageTokens = host.nonMessageTokens();
		const breakdown = this.breakdown({ contextWindow: host.model()?.contextWindow ?? 0, pendingMessages: messages });
		const promptTokens = breakdown.usedTokens;
		const detail = sessionTelemetryDetail(host.instrumentationLevel(), "context-breakdown");
		const snapshot: PendingContextSnapshot = {
			promptTokens,
			nonMessageTokens,
			cutoffCount: host.messages().length,
			submitted: new Set(messages),
			detail,
		};
		if (detail === "rich" || detail === "ultra") {
			const attribution = estimateContextSnapshotAttribution(
				promptTokens,
				nonMessageTokens,
				breakdown.pendingMessagesTokens,
				"estimate",
				detail === "ultra" ? getLatestCompactionEntry(host.sessionStore.getBranch())?.id : undefined,
			);
			snapshot.storedMessagesTokens = attribution.storedMessagesTokens;
			snapshot.tailTokens = attribution.tailTokens;
			snapshot.compactionEntryId = attribution.compactionEntryId;
		}
		this.#setPending(snapshot);
	}

	/** The run ended or aborted: the prompt snapshot no longer accounts for anything. */
	endPrompt(): void {
		this.#setPending(undefined);
	}

	/**
	 * A pass rewrote history in place. Usage anchors at or before the current leaf measured the old
	 * history, so {@link breakdown} stops reading them, and the prompt snapshot is re-measured.
	 */
	markHistoryRewritten(): void {
		this.#rewriteBoundaryEntryId = this.#host.sessionStore.getBranch().at(-1)?.id;
		this.rebaseAfterHistoryRewrite();
	}

	/**
	 * Re-measure the prompt snapshot over the current message set after any pass rewrote history
	 * mid-run: a compaction, its dead-end rescue, a prune, a dedup, or an operator `/shake`.
	 *
	 * The snapshot captures the prompt as submitted at run start and lives for the whole run. Until a
	 * step of the current turn produces provider usage it is the only thing accounting for that
	 * prompt, and after a compaction it is the only thing left (every earlier usage anchor is
	 * hidden). A rewrite that leaves it alone reports the bytes it removed as live context until the
	 * next provider response, and the post-compaction headroom and retry-fit checks measure that
	 * inflated residual. No-op while no prompt is in flight.
	 */
	rebaseAfterHistoryRewrite(): void {
		const current = this.#pending;
		if (!current) return;
		const host = this.#host;
		const messages = host.messages();
		const nonMessageTokens = host.nonMessageTokens();
		const promptTokens = nonMessageTokens + sumTokens(messages);
		const rebased: PendingContextSnapshot = {
			promptTokens,
			nonMessageTokens,
			cutoffCount: messages.length,
			// A rewrite recomputed the prompt over the whole current history, so nothing standing in
			// `messages` is outside `promptTokens` any more.
			submitted: new Set<AgentMessage>(),
			detail: current.detail,
		};
		if (current.detail === "rich" || current.detail === "ultra") {
			const attribution = estimateContextSnapshotAttribution(
				promptTokens,
				nonMessageTokens,
				0,
				"estimate",
				current.detail === "ultra" ? getLatestCompactionEntry(host.sessionStore.getBranch())?.id : undefined,
			);
			rebased.storedMessagesTokens = attribution.storedMessagesTokens;
			rebased.tailTokens = attribution.tailTokens;
			rebased.compactionEntryId = attribution.compactionEntryId;
		}
		this.#setPending(rebased);
	}

	#setPending(snapshot: PendingContextSnapshot | undefined): void {
		this.#pending = snapshot;
		this.#revision++;
	}
}
