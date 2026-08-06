/**
 * Compaction either frees context or refuses. It must never report success and
 * free nothing, and it must never refuse while the range is over budget.
 *
 * Both failures reach the user as the same sentence, "Nothing to compact (session
 * too small)", printed against a context gauge sitting at the ceiling. The
 * session is objectively enormous, so the message is not merely unhelpful, it is
 * false, and there is no action it suggests that helps.
 *
 * The mechanism is that a tool result is never a valid cut point: cutting there
 * would separate it from the call it answers. A turn whose result is larger than
 * the whole keep-recent budget therefore has no usable boundary behind it, and
 * every cut the search can reach either keeps the entire range (nothing to
 * summarize, refuse) or keeps the oversized result (summarize a little, free
 * nothing, be asked again next turn).
 *
 * Each shape below is a real session skeleton that produced one of those two
 * outcomes. They are deliberately tiny: a failure points at the cut-point search
 * and nothing else.
 */
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import {
	DEFAULT_COMPACTION_SETTINGS,
	findCutPoint,
	KEEP_NOTHING_ENTRY_ID,
	prepareCompaction,
	resolveCompactionBoundaryIndex,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ToolResultMessage, Usage } from "@veyyon/ai";

let idCounter = 0;

const usage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function entry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: `e-${idCounter++}`, parentId: null, timestamp: "2026-08-06T00:00:00.000Z", message };
}

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	timestamp: 1,
	provider: "mock",
	model: "mock",
	api: "mock",
	usage: usage(),
	stopReason: "stop",
});

const withCall = () => assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "big" } }]);

const result = (text: string): ToolResultMessage =>
	({
		role: "toolResult",
		toolCallId: "c1",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	}) as ToolResultMessage;

const HUGE = "x".repeat(800_000);
const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 30_000 };

/** Every shape here is over budget by two orders of magnitude. */
const overBudgetShapes: Array<[string, SessionEntry[]]> = [
	["a call and its oversized result", [entry(withCall()), entry(result(HUGE))]],
	["a whole turn ending in an oversized result", [entry(user("q")), entry(withCall()), entry(result(HUGE))]],
	["an oversized result with nothing before it", [entry(result(HUGE))]],
	["one oversized assistant message", [entry(assistant([{ type: "text", text: HUGE }]))]],
];

describe("an over-budget range always frees something", () => {
	for (const [label, entries] of overBudgetShapes) {
		test(`${label}: prepares a compaction`, () => {
			expect(prepareCompaction(entries, settings)).toBeDefined();
		});

		test(`${label}: summarizes every entry, keeping none`, () => {
			// Keeping any of them keeps the thing that blew the budget, which is the
			// "succeeded and freed nothing" failure. There is no boundary that keeps
			// less, so the whole range is summarized.
			const prepared = prepareCompaction(entries, settings);

			expect(prepared!.messagesToSummarize.length).toBe(entries.length);
			expect(prepared!.recentMessages).toEqual([]);
		});

		test(`${label}: reports the cut as keeping nothing`, () => {
			const cut = findCutPoint(entries, 0, entries.length, settings.keepRecentTokens);

			expect(cut.firstKeptEntryIndex).toBe(entries.length);
			expect(cut.isSplitTurn).toBe(false);
			expect(cut.turnStartIndex).toBe(-1);
		});
	}

	test("a boundary that does leave a usable tail is still preferred over keeping nothing", () => {
		// The counterpart: an assistant message AFTER the oversized result is a valid
		// cut point that leaves a tail within budget, so keeping nothing would be
		// destroying context for no reason.
		const entries = [entry(withCall()), entry(result(HUGE)), entry(assistant([{ type: "text", text: "done" }]))];
		const cut = findCutPoint(entries, 0, entries.length, settings.keepRecentTokens);

		expect(cut.firstKeptEntryIndex).toBe(2);

		const prepared = prepareCompaction(entries, settings);
		expect(prepared!.messagesToSummarize.length).toBe(2);
		expect(prepared!.recentMessages.map(m => m.role)).toEqual(["assistant"]);
	});

	test("a range that fits the budget is still refused", () => {
		// "Free something" must not become "compact everything". A small session has
		// nothing to gain and refusing is the correct answer.
		const entries = [entry(user("hello")), entry(assistant([{ type: "text", text: "hi" }]))];

		expect(prepareCompaction(entries, settings)).toBeUndefined();
		expect(findCutPoint(entries, 0, entries.length, settings.keepRecentTokens).firstKeptEntryIndex).toBe(0);
	});
});

describe("a keep-nothing boundary puts the whole pre-compaction range behind it", () => {
	// Prune and shake skip entries BEFORE the boundary: those were summarized away
	// and are never sent, so rewriting them churns persisted history for no prompt
	// saving. Both resolved the boundary with a plain `findIndex` and clamped -1
	// to 0, and the keep-nothing id matches no entry on purpose, so it resolved to
	// "nothing is behind the boundary" — the exact opposite, aiming every pass at
	// the entries it must not touch.
	function branch(): SessionEntry[] {
		idCounter = 0;
		return [
			entry(user("old question")),
			entry(assistant([{ type: "text", text: "old answer" }])),
			{
				type: "compaction",
				id: "comp-1",
				parentId: null,
				timestamp: "2026-08-06T00:00:00.000Z",
				summary: "everything so far",
				firstKeptEntryId: KEEP_NOTHING_ENTRY_ID,
				tokensBefore: 900_000,
			} as unknown as SessionEntry,
			entry(user("new question")),
		];
	}

	test("everything before the compaction is behind the boundary", () => {
		expect(resolveCompactionBoundaryIndex(branch(), KEEP_NOTHING_ENTRY_ID)).toBe(3);
	});

	test("entries added after the compaction are still live", () => {
		// The boundary lands just past the compaction entry, not at the end: work
		// done since the compaction is ordinary live context.
		const entries = branch();

		expect(resolveCompactionBoundaryIndex(entries, KEEP_NOTHING_ENTRY_ID)).toBeLessThan(entries.length);
	});

	test("an ordinary id still resolves to its own entry", () => {
		const entries = branch();

		expect(resolveCompactionBoundaryIndex(entries, entries[1].id)).toBe(1);
	});

	test("no boundary means the whole branch is live", () => {
		expect(resolveCompactionBoundaryIndex(branch(), undefined)).toBe(0);
	});

	test("an id that is simply missing is still treated as no boundary", () => {
		// A forked or migrated branch can name an entry that is not on this path.
		// That is unknown, not "keep nothing", so the safe reading is the old one.
		expect(resolveCompactionBoundaryIndex(branch(), "e-does-not-exist")).toBe(0);
	});
});

describe("the recent-token budget is not scaled by the harness", () => {
	// The budget is scaled by how far the local estimate undershoots what the
	// provider charged for the SAME messages. The system prompt and tool schemas
	// are in the provider's count and in no entry, so counting them made an
	// unrelated harness the multiplier: the same conversation kept less and less
	// as the tool set grew, for no reason the user could see or change.
	function conversation(): SessionEntry[] {
		idCounter = 0;
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 12; i++) {
			entries.push(entry(user(`question ${i} `.repeat(400))));
			entries.push(entry(assistant([{ type: "text", text: `answer ${i} `.repeat(400) }])));
		}
		return entries;
	}

	function keptWith(nonMessageTokens: number | undefined, promptTokens: number): number {
		const entries = conversation();
		const last = entries[entries.length - 1] as SessionMessageEntry;
		(last.message as AssistantMessage).usage = { ...usage(), input: promptTokens };
		const prepared = prepareCompaction(entries, settings, { nonMessageTokens });
		return prepared ? prepared.recentMessages.length : -1;
	}

	test("a harness reported as non-message tokens does not shrink the kept tail", () => {
		const messagesOnly = 24_844;

		expect(keptWith(0, messagesOnly)).toBe(keptWith(20_000, messagesOnly + 20_000));
		expect(keptWith(0, messagesOnly)).toBe(keptWith(60_000, messagesOnly + 60_000));
	});

	test("an under-counted estimate for the messages themselves still scales the budget", () => {
		// The scaling exists for a real reason: when the provider charges more for
		// the same messages than the local estimate predicts, keeping "30k estimated
		// tokens" keeps more than 30k real ones. This conversation fits the budget on
		// the local estimate and is refused; told the provider charged four times as
		// much for those same messages, the budget shrinks and it compacts.
		const messagesOnly = 24_844;

		expect(keptWith(0, messagesOnly)).toBe(-1);
		expect(keptWith(0, messagesOnly * 4)).toBeGreaterThan(0);
	});
});
