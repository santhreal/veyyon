import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import { DEFAULT_PRUNE_CONFIG, findCutPoint, pruneToolOutputs } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ToolResultMessage, Usage } from "@veyyon/ai";

/**
 * SESS-4: compacting a very large session must never break the tool-call
 * structure.
 *
 * Every provider enforces the same shape: an assistant turn that emits a tool
 * call MUST be followed by a result for that exact id, and a result may not
 * appear without its call. Break it and the very next request is rejected
 * outright (Anthropic answers 400 "tool_use ids were found without
 * tool_result blocks"), so the session the user just spent an hour building
 * becomes unusable — and it fails at the moment compaction fires, which is
 * precisely when the session is long enough to be worth keeping.
 *
 * Compaction has two ways to break it. The CUT drops everything before a chosen
 * index, so a cut landing between an assistant's tool call and its result
 * orphans the result. PRUNING rewrites large tool outputs in place, so a prune
 * that removed the entry rather than replacing its content orphans the call.
 * `findValidCutPoints` excludes `toolResult` entries to prevent the first, and
 * pruning writes a placeholder to prevent the second. Neither of those
 * intentions is self-evident from the code, and both are one careless edit away
 * from being lost.
 *
 * So this suite builds a large session (hundreds of entries, over a hundred
 * call/result pairs, mixed roles and shapes) and sweeps the ENTIRE range of
 * keep-recent budgets, from "keep nothing" to "keep everything", asserting the
 * pairing invariant at every one. A single hand-picked budget proves nothing:
 * the cut point moves with the budget, and the failure appears only at the
 * budgets where it happens to land next to a pair.
 */

let idCounter = 0;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: `e-${idCounter++}`, parentId: null, timestamp: "2026-07-24T00:00:00.000Z", message };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: 1,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: usage(),
		stopReason: "stop",
	};
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	} as ToolResultMessage;
}

/**
 * A session shaped like a real long one: user turns, assistant prose, assistant
 * turns that call tools, the matching results, and the occasional bash
 * execution and multi-call turn.
 *
 * The variety is deliberate. A session of nothing but identical pairs would
 * make every cut point equivalent, and the invariant would hold by accident.
 * Multi-call turns matter most: one assistant message with three calls has
 * three results after it, so a cut that lands one entry late orphans two of
 * them rather than one, which is the shape a naive off-by-one produces.
 */
function largeSession(turns: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let turn = 0; turn < turns; turn++) {
		entries.push(messageEntry({ role: "user", content: [{ type: "text", text: `question ${turn}` }], timestamp: 1 }));
		entries.push(messageEntry(assistant([{ type: "text", text: `thinking about ${turn}` }])));

		const callsThisTurn = (turn % 3) + 1;
		const callIds = Array.from({ length: callsThisTurn }, (_unused, n) => `call-${turn}-${n}`);
		entries.push(
			messageEntry(
				assistant(
					callIds.map(id => ({
						type: "toolCall" as const,
						id,
						name: id.endsWith("-0") ? "read" : "bash",
						arguments: { path: `/src/file-${turn}.ts`, command: `run ${turn}` },
					})),
				),
			),
		);
		for (const id of callIds) {
			// Long enough that pruning has real candidates to work with.
			entries.push(messageEntry(toolResult(id, id.endsWith("-0") ? "read" : "bash", "x".repeat(2_000))));
		}
		if (turn % 5 === 0) {
			entries.push(
				messageEntry({ role: "bashExecution", command: `git status ${turn}`, output: "clean", timestamp: 1 } as never),
			);
		}
	}
	return entries;
}

/** Every tool-call id emitted by assistant messages in `entries`, in order. */
function callIds(entries: readonly SessionEntry[]): string[] {
	const ids: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type === "toolCall") ids.push(block.id);
		}
	}
	return ids;
}

/** Every tool-call id that has a result entry in `entries`, in order. */
function resultIds(entries: readonly SessionEntry[]): string[] {
	const ids: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		ids.push((entry.message as ToolResultMessage).toolCallId);
	}
	return ids;
}

/** Ids present on one side of the call/result pairing and missing on the other. */
function unpaired(entries: readonly SessionEntry[]): { orphanedResults: string[]; unansweredCalls: string[] } {
	const calls = new Set(callIds(entries));
	const results = new Set(resultIds(entries));
	return {
		orphanedResults: [...results].filter(id => !calls.has(id)).sort(),
		unansweredCalls: [...calls].filter(id => !results.has(id)).sort(),
	};
}

const SESSION = largeSession(60);

describe("cutting a large session", () => {
	it("is actually large enough for the sweep below to mean something", () => {
		// Guard on the fixture itself. If a later edit shrinks it, the sweep would
		// still pass while covering a handful of cut points, and the suite would
		// quietly stop testing what its name claims.
		expect(SESSION.length).toBeGreaterThan(250);
		expect(callIds(SESSION).length).toBeGreaterThan(75);
		expect(resultIds(SESSION)).toEqual(callIds(SESSION));
	});

	it("never orphans a tool result at ANY keep-recent budget", () => {
		// The sweep. Budgets step finely enough to land the cut next to every
		// structural boundary in the fixture, including inside the multi-call
		// turns where an off-by-one orphans more than one result.
		const failures: string[] = [];
		for (let budget = 0; budget <= 400_000; budget += 977) {
			const { firstKeptEntryIndex } = findCutPoint(SESSION, 0, SESSION.length, budget);
			const kept = SESSION.slice(firstKeptEntryIndex);
			const { orphanedResults } = unpaired(kept);
			if (orphanedResults.length > 0) {
				failures.push(`budget ${budget} (cut at ${firstKeptEntryIndex}) orphaned ${orphanedResults.join(", ")}`);
			}
		}

		expect(failures).toEqual([]);
	});

	it("never cuts onto a tool-result entry", () => {
		// The mechanism behind the invariant, asserted directly so a regression
		// reports its cause rather than only its symptom. A cut point that IS a
		// tool result means its call was just dropped.
		const landings = new Set<string>();
		for (let budget = 0; budget <= 400_000; budget += 977) {
			const { firstKeptEntryIndex } = findCutPoint(SESSION, 0, SESSION.length, budget);
			const entry = SESSION[firstKeptEntryIndex];
			landings.add(entry?.type === "message" ? entry.message.role : (entry?.type ?? "end"));
		}

		expect([...landings]).not.toContain("toolResult");
		// And it does land somewhere real, so the assertion above is not vacuous.
		expect(landings.size).toBeGreaterThan(1);
	});

	it("keeps the retained tail contiguous and in order", () => {
		// Compaction drops a PREFIX. Any reordering or gap would corrupt the
		// conversation even with the pairing intact, and it would be invisible to
		// a set-based check.
		const { firstKeptEntryIndex } = findCutPoint(SESSION, 0, SESSION.length, 50_000);
		const kept = SESSION.slice(firstKeptEntryIndex);

		expect(kept).toEqual(SESSION.slice(SESSION.length - kept.length));
		expect(resultIds(kept)).toEqual(resultIds(SESSION).slice(resultIds(SESSION).length - resultIds(kept).length));
	});

	it("keeps everything when the budget exceeds the whole session", () => {
		// The upper edge. Cutting anything at all here would discard history for
		// no reason, and it is the case a "cut at least once" bug hides in.
		const { firstKeptEntryIndex } = findCutPoint(SESSION, 0, SESSION.length, 10_000_000);

		expect(firstKeptEntryIndex).toBe(0);
		expect(unpaired(SESSION.slice(firstKeptEntryIndex))).toEqual({ orphanedResults: [], unansweredCalls: [] });
	});
});

describe("pruning tool outputs in a large session", () => {
	it("rewrites results in place and removes no entry", () => {
		// Pruning saves tokens by replacing a result's CONTENT, never by deleting
		// the entry: deleting one would orphan its call and break the next
		// request. Asserted on the exact entry count and the exact id sequence,
		// because a prune that dropped one entry and appended another would keep
		// the count and still be wrong.
		const entries = largeSession(60);
		const before = { count: entries.length, calls: callIds(entries), results: resultIds(entries) };

		const result = pruneToolOutputs(entries, { ...DEFAULT_PRUNE_CONFIG, protectTokens: 1_000, minimumSavings: 0 });

		expect(result.prunedCount).toBeGreaterThan(0); // the prune actually ran
		expect(entries.length).toBe(before.count);
		expect(callIds(entries)).toEqual(before.calls);
		expect(resultIds(entries)).toEqual(before.results);
		expect(unpaired(entries)).toEqual({ orphanedResults: [], unansweredCalls: [] });
	});

	it("leaves every pruned result readable rather than empty", () => {
		// A result rewritten to nothing is structurally valid and semantically a
		// trap: the model sees a tool that answered with silence and cannot tell
		// that from a tool that genuinely returned nothing. Pruned results carry a
		// placeholder saying what happened.
		const entries = largeSession(60);

		pruneToolOutputs(entries, { ...DEFAULT_PRUNE_CONFIG, protectTokens: 1_000, minimumSavings: 0 });

		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			const content = (entry.message as ToolResultMessage).content;
			expect(content.length).toBeGreaterThan(0);
			for (const block of content) {
				if (block.type === "text") expect(block.text.length).toBeGreaterThan(0);
			}
		}
	});

	it("survives pruning and then cutting, which is what a real compaction does", () => {
		// The two stages run together in production, and the invariant has to hold
		// across the composition rather than only for each stage alone: pruning
		// changes the token estimates the cut point is chosen from, so it moves
		// the cut.
		const entries = largeSession(60);
		pruneToolOutputs(entries, { ...DEFAULT_PRUNE_CONFIG, protectTokens: 1_000, minimumSavings: 0 });

		const failures: string[] = [];
		for (let budget = 0; budget <= 200_000; budget += 1_301) {
			const { firstKeptEntryIndex } = findCutPoint(entries, 0, entries.length, budget);
			const { orphanedResults } = unpaired(entries.slice(firstKeptEntryIndex));
			if (orphanedResults.length > 0) failures.push(`budget ${budget}: ${orphanedResults.join(", ")}`);
		}

		expect(failures).toEqual([]);
	});
});
