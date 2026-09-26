/**
 * WHY: session spend covers the messages the compaction in effect summarized away, and on a long
 * session that prefix is nearly the whole branch. `SessionSpendLedger` tallies the prefix once per
 * boundary and reuses the tally, so the defect class this closes is a stale or aliased tally: a
 * cache keyed on something weaker than the path it covers (the boundary index alone), an extension
 * that re-adds entries it already counted or keeps a prefix from an abandoned branch, a boundary
 * that moved back without a recount, and a returned total that shares state with the cache so a
 * caller's edit leaks into the next read.
 *
 * Every step of each walk compares the ledger against a full recount of the same branch, so each
 * of those shows up as a total that differs from the recount at the step that triggers it. The
 * totals carry fractional costs, so a sum taken in a different order also differs.
 *
 * What it does not catch: a pass that rewrites the usage of a message already inside the
 * summarized prefix. The ledger assumes a recorded message's usage never changes; no pass does
 * that today, and a new one would need its own invalidation.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { KEEP_NOTHING_ENTRY_ID, resolveCompactionBoundaryIndex } from "@veyyon/agent-core/compaction/entries";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@veyyon/ai";
import type { SessionSpend } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionSpendLedger } from "@veyyon/coding-agent/session/session-spend";
import { getLatestCompactionEntry } from "@veyyon/kernel/session/session-context";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

let clock = 0;

function usage(input: number, cost: number, extra: Partial<Usage> = {}): Usage {
	return {
		input,
		output: input / 2,
		cacheRead: input * 3,
		cacheWrite: 1,
		totalTokens: input * 4 + input / 2 + 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		...extra,
	};
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: ++clock };
}

function assistant(spent: Usage, toolCalls = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "ok" },
			...Array.from({ length: toolCalls }, (_, index) => ({
				type: "toolCall" as const,
				id: `call-${clock}-${index}`,
				name: "read",
				arguments: {},
			})),
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: spent,
		stopReason: toolCalls > 0 ? "toolUse" : "stop",
		timestamp: ++clock,
	};
}

function toolResult(toolName: string, details?: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${clock}`,
		toolName,
		content: [{ type: "text", text: "done" }],
		details,
		isError: false,
		timestamp: ++clock,
	};
}

/** One turn with every message kind that contributes to spend, costs chosen to be inexact floats. */
function appendTurn(session: SessionManager, seed: number): void {
	session.appendMessage(user(`turn ${seed}`));
	session.appendMessage(assistant(usage(seed * 7, seed * 0.1 + 0.07, { reasoningTokens: seed }), 2));
	session.appendMessage(toolResult("read"));
	session.appendMessage(toolResult("task", { usage: usage(seed * 11, seed * 0.3 + 0.01, { premiumRequests: 1 }) }));
	session.appendMessage(assistant(usage(seed * 5, seed * 0.2 + 0.03)));
}

/** The entry id of the `n`-th message of the current branch, counting from its root. */
function entryIdAt(session: SessionManager, n: number): string {
	return session.getBranch()[n].id;
}

function compactKeeping(session: SessionManager, firstKeptEntryId: string): void {
	session.appendCompaction("summary", undefined, firstKeptEntryId, 1000);
}

/** A second full recount, written the way the spend was computed before the ledger existed. */
function fullRecount(branch: readonly SessionEntry[], boundary: number, live: readonly AgentMessage[]): SessionSpend {
	const summarized: AgentMessage[] = [];
	for (let index = 0; index < boundary; index++) {
		const entry = branch[index];
		if (entry.type === "message") summarized.push(entry.message);
	}
	const messages = [...summarized, ...live];
	const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	let cost = 0;
	let premiumRequests = 0;
	let toolCalls = 0;
	const add = (spent: Usage) => {
		tokens.input += spent.input;
		tokens.output += spent.output;
		tokens.reasoning += spent.reasoningTokens ?? 0;
		tokens.cacheRead += spent.cacheRead;
		tokens.cacheWrite += spent.cacheWrite;
		tokens.total += spent.totalTokens;
		premiumRequests += spent.premiumRequests ?? 0;
		cost += spent.cost.total;
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			toolCalls += message.content.filter(block => block.type === "toolCall").length;
			add(message.usage);
		}
		if (message.role === "toolResult" && message.toolName === "task") {
			const recorded = (message.details as { usage?: Usage } | undefined)?.usage;
			if (recorded) add(recorded);
		}
	}
	return {
		userMessages: messages.filter(message => message.role === "user").length,
		assistantMessages: messages.filter(message => message.role === "assistant").length,
		toolCalls,
		toolResults: messages.filter(message => message.role === "toolResult").length,
		totalMessages: messages.length,
		tokens,
		cost,
		premiumRequests,
	};
}

/** The live context a session would hold: the messages from the boundary forward. */
function liveMessages(branch: readonly SessionEntry[], boundary: number): AgentMessage[] {
	const live: AgentMessage[] = [];
	for (let index = boundary; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type === "message") live.push(entry.message);
	}
	return live;
}

describe("a cached session spend", () => {
	let session: SessionManager;
	let ledger: SessionSpendLedger;

	/**
	 * Read the ledger for the current branch and require it to equal a full recount. The boundary is
	 * the latest compaction's unless `firstKeptEntryId` names another, which is what a provider
	 * switch does when it makes an earlier compaction the one in effect.
	 */
	function expectRecountParity(firstKeptEntryId?: string): SessionSpend {
		const branch = session.getBranch();
		const boundary = resolveCompactionBoundaryIndex(
			branch,
			firstKeptEntryId ?? getLatestCompactionEntry(branch)?.firstKeptEntryId,
		);
		const live = liveMessages(branch, boundary);
		const cached = ledger.total(branch, boundary, live);
		expect(cached).toEqual(fullRecount(branch, boundary, live));
		return cached;
	}

	beforeEach(() => {
		clock = 0;
		session = SessionManager.inMemory();
		ledger = new SessionSpendLedger();
	});

	it("counts the live context alone before any compaction", () => {
		appendTurn(session, 1);
		appendTurn(session, 2);
		const spend = expectRecountParity();
		expect(spend.userMessages).toBe(2);
		expect(spend.toolCalls).toBe(4);
	});

	it("extends the summarized tally across successive compactions on one path", () => {
		for (let round = 1; round <= 4; round++) {
			appendTurn(session, round * 3);
			appendTurn(session, round * 3 + 1);
			// Keep the latest turn: the boundary sits five messages from the tail.
			compactKeeping(session, entryIdAt(session, session.getBranch().length - 5));
			expectRecountParity();
			// A second read at the same boundary must return the same total, not a doubled one.
			expectRecountParity();
			appendTurn(session, round * 3 + 2);
			expectRecountParity();
		}
	});

	it("recounts when a branch switch moves the boundary back", () => {
		appendTurn(session, 1);
		appendTurn(session, 2);
		compactKeeping(session, entryIdAt(session, 5));
		const firstCompaction = session.getBranch().at(-1)!.id;
		appendTurn(session, 3);
		appendTurn(session, 4);
		compactKeeping(session, entryIdAt(session, 16));
		expectRecountParity();

		session.branch(firstCompaction);
		appendTurn(session, 9);
		expectRecountParity();
	});

	it("recounts when an earlier compaction on the same path takes effect again", () => {
		appendTurn(session, 1);
		appendTurn(session, 2);
		const firstKept = entryIdAt(session, 5);
		compactKeeping(session, firstKept);
		appendTurn(session, 3);
		appendTurn(session, 4);
		compactKeeping(session, entryIdAt(session, 16));
		expectRecountParity();

		// Same branch, same leaf; only the compaction in effect moved back.
		expectRecountParity(firstKept);
		expectRecountParity();
	});

	it("recounts a different path whose boundary sits at the same index", () => {
		appendTurn(session, 1);
		const fork = session.getBranch().at(-1)!.id;
		appendTurn(session, 2);
		compactKeeping(session, entryIdAt(session, 7));
		const first = expectRecountParity();

		session.branch(fork);
		appendTurn(session, 20);
		compactKeeping(session, entryIdAt(session, 7));
		const second = expectRecountParity();
		expect(second.tokens.input).not.toBe(first.tokens.input);
	});

	it("recounts a different path whose boundary sits further along", () => {
		appendTurn(session, 1);
		const fork = session.getBranch().at(-1)!.id;
		appendTurn(session, 2);
		compactKeeping(session, entryIdAt(session, 7));
		expectRecountParity();

		session.branch(fork);
		appendTurn(session, 30);
		appendTurn(session, 31);
		compactKeeping(session, entryIdAt(session, 12));
		expectRecountParity();
	});

	it("counts everything before a compaction that kept nothing", () => {
		appendTurn(session, 1);
		appendTurn(session, 2);
		compactKeeping(session, KEEP_NOTHING_ENTRY_ID);
		const spend = expectRecountParity();
		expect(spend.userMessages).toBe(2);
		appendTurn(session, 3);
		expectRecountParity();
	});

	it("returns a total the caller may change without touching the next read", () => {
		appendTurn(session, 1);
		appendTurn(session, 2);
		compactKeeping(session, entryIdAt(session, 5));
		const first = expectRecountParity();
		first.tokens.input += 1_000_000;
		first.cost += 1_000_000;
		first.userMessages += 1_000_000;
		expectRecountParity();
	});
});
