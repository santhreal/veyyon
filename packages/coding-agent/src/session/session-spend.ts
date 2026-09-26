/**
 * Session spend: message counts, tokens, cost and premium requests over the messages the
 * compaction in effect summarized away plus the live context.
 *
 * The summarized half is every message entry on the branch before the compaction boundary, and on
 * a long session it is nearly the whole branch: hundreds of thousands of entries against a live
 * context of a few hundred. Goal accounting reads spend at every turn start, every tool completion
 * and every agent end, so a recount of that prefix per read is a per-tool-call cost that grows with
 * the session.
 *
 * The prefix is fixed once written. A branch is the path from the root to its leaf, so the entry
 * just before the boundary determines every entry before it, and no pass rewrites the role, the
 * tool calls or the usage of a recorded message. {@link SessionSpendLedger} tallies the prefix once
 * per boundary entry, extends that tally when a later compaction moves the boundary forward along
 * the same path, and walks only the live context on each read.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import type { Usage } from "@veyyon/ai";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { TOOL } from "../tools/core/builtin-names";
import type { SessionSpend } from "./agent-session-types";

/** A spend of zero. Key order is the order `getSessionStats` serializes. */
export function emptySessionSpend(): SessionSpend {
	return {
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
		premiumRequests: 0,
	};
}

function copySessionSpend(spend: SessionSpend): SessionSpend {
	return { ...spend, tokens: { ...spend.tokens } };
}

function addUsage(spend: SessionSpend, usage: Usage): void {
	spend.tokens.input += usage.input;
	spend.tokens.output += usage.output;
	spend.tokens.reasoning += usage.reasoningTokens ?? 0;
	spend.tokens.cacheRead += usage.cacheRead;
	spend.tokens.cacheWrite += usage.cacheWrite;
	spend.tokens.total += usage.totalTokens;
	spend.premiumRequests += usage.premiumRequests ?? 0;
	spend.cost += usage.cost.total;
}

/** The usage a `task` tool result records for the agents it ran, when it records one. */
function taskToolUsage(details: unknown): Usage | undefined {
	if (!details || typeof details !== "object") return undefined;
	const usage = (details as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object") return undefined;
	return usage as Usage;
}

/**
 * Add one message to a spend. An assistant message contributes its own usage; a `task` tool result
 * contributes the usage of the agents it ran, which no assistant message of this session records.
 */
export function addMessageSpend(spend: SessionSpend, message: AgentMessage): void {
	spend.totalMessages++;
	if (message.role === "user") {
		spend.userMessages++;
	} else if (message.role === "assistant") {
		spend.assistantMessages++;
		for (const block of message.content) {
			if (block.type === "toolCall") spend.toolCalls++;
		}
		addUsage(spend, message.usage);
	} else if (message.role === "toolResult") {
		spend.toolResults++;
		if (message.toolName === TOOL.task) {
			const usage = taskToolUsage(message.details);
			if (usage) addUsage(spend, usage);
		}
	}
}

function addEntrySpend(spend: SessionSpend, branch: readonly SessionEntry[], from: number, to: number): void {
	for (let index = from; index < to; index++) {
		const entry = branch[index];
		if (entry.type === "message") addMessageSpend(spend, entry.message);
	}
}

/**
 * Session spend with the summarized prefix tallied once per boundary. One ledger serves one
 * session for its lifetime; a session switch, a branch switch and a compaction each change the
 * entry before the boundary, which the ledger compares by identity.
 */
export class SessionSpendLedger {
	/** The last summarized entry the cached tally covers, or undefined before the first tally. */
	#through: SessionEntry | undefined;
	/** Entries the cached tally covers: the index just past {@link #through}. */
	#length = 0;
	#summarized: SessionSpend = emptySessionSpend();

	/**
	 * Spend over the message entries of `branch` before `boundary`, followed by `live`. The sum runs
	 * in branch order and then live order, so the result is the one a single pass over both returns,
	 * to the last bit of every floating-point total.
	 */
	total(branch: readonly SessionEntry[], boundary: number, live: readonly AgentMessage[]): SessionSpend {
		const spend = boundary > 0 ? copySessionSpend(this.#summarizedSpend(branch, boundary)) : emptySessionSpend();
		for (const message of live) addMessageSpend(spend, message);
		return spend;
	}

	#summarizedSpend(branch: readonly SessionEntry[], boundary: number): SessionSpend {
		const through = branch[boundary - 1];
		if (through === this.#through && boundary === this.#length) return this.#summarized;
		// A later compaction on the same path keeps the cached prefix intact and adds the entries
		// between the two boundaries. Anything else — a branch switch, a session switch, a boundary
		// that moved back — recounts from the root.
		const extendsCached =
			this.#through !== undefined && this.#length <= boundary && branch[this.#length - 1] === this.#through;
		const spend = extendsCached ? this.#summarized : emptySessionSpend();
		addEntrySpend(spend, branch, extendsCached ? this.#length : 0, boundary);
		this.#through = through;
		this.#length = boundary;
		this.#summarized = spend;
		return spend;
	}
}
