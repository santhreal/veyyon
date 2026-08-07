import { describe, expect, spyOn, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	resolveThresholdTokens,
	type SessionEntry,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Usage } from "@veyyon/ai";
import { logger } from "@veyyon/utils";

/**
 * THE REPORTED SYMPTOM: "Nothing to compact (session too small)" against a
 * context gauge reading 0% left.
 *
 * `compaction.keepRecentTokens` is a flat 20000 and was never measured against
 * the model. On a model whose prompt cannot hold that much conversation, it
 * asks compaction to keep more recent history than could ever be there, so the
 * whole compactable range always estimates under the budget, `findCutPoint`
 * never crosses it, and the dead-end guard is skipped because a range that fits
 * the budget is by definition a small session. `prepareCompaction` then returns
 * undefined, and the only sentence the caller has for that is that the session
 * is too small: said to a user whose window is full.
 *
 * The fix caps the budget at the space the conversation is allowed to occupy,
 * derived from the model's own trigger rather than picked. These cases pin both
 * halves: the full session compacts, and a genuinely small one is still refused
 * so the cap did not simply turn the refusal off.
 */

const CONTEXT_WINDOW = 64_000;
const NON_MESSAGE_TOKENS = 30_000;

/** Above the trigger for this window, so the gauge is at the ceiling. */
const PROMPT_TOKENS = 48_000;

function usage(promptTokens: number): Usage {
	return {
		input: promptTokens,
		output: 400,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: promptTokens + 400,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(text: string, promptTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "openai",
		model: "gpt-5.1",
		api: "openai-responses",
		usage: usage(promptTokens),
		stopReason: "stop",
	};
}

function entry(id: string, parentId: string | undefined, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date().toISOString(), message } as SessionEntry;
}

/**
 * A branch of `turns` exchanges whose newest assistant message reports
 * `promptTokens`. Each turn's text is sized so the local estimate of the whole
 * branch lands under the raw 20000 budget and over the capped one, which is the
 * band the defect lives in.
 */
function branch(turns: number, promptTokens: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parent: string | undefined;
	for (let i = 0; i < turns; i++) {
		const body = `turn ${i} ${"conversation text ".repeat(400)}`;
		entries.push(entry(`user-${i}`, parent, userMessage(body)));
		parent = `user-${i}`;
		entries.push(entry(`assistant-${i}`, parent, assistantMessage(`reply ${i}`, promptTokens)));
		parent = `assistant-${i}`;
	}
	return entries;
}

describe("compaction never keeps more recent history than the window can hold", () => {
	/**
	 * The end-to-end statement of the reported bug, in the terms the user saw
	 * it: the gauge says there is no room left, so compaction must not answer
	 * that the session is too small. `undefined` IS that answer, and the pair
	 * below is the whole defect: the same branch on the same model, refused
	 * while the budget is the flat configured number and compacted once it is
	 * capped at what the window can actually hold.
	 */
	test("a session at the compaction ceiling is compactable, not 'too small'", () => {
		const entries = branch(6, PROMPT_TOKENS);
		const settings = { ...DEFAULT_COMPACTION_SETTINGS };

		// The gauge the user is reading: at or past the trigger for this window.
		expect(PROMPT_TOKENS).toBeGreaterThanOrEqual(resolveThresholdTokens(CONTEXT_WINDOW, settings));

		const uncapped = prepareCompaction(entries, settings, { nonMessageTokens: NON_MESSAGE_TOKENS });
		expect(uncapped).toBeUndefined();

		const prepared = prepareCompaction(entries, settings, {
			nonMessageTokens: NON_MESSAGE_TOKENS,
			contextWindow: CONTEXT_WINDOW,
		});

		expect(prepared).toBeDefined();
		// Either half of the discarded span counts: a cut inside the oldest turn
		// puts its history in the turn prefix instead. What may not happen is
		// both being empty, which is the refusal the user was shown.
		expect((prepared?.messagesToSummarize.length ?? 0) + (prepared?.turnPrefixMessages.length ?? 0)).toBeGreaterThan(
			0,
		);
		expect(prepared?.recentMessages.length).toBeGreaterThan(0);
	});

	/**
	 * The cap must not become a second way to say yes. A branch well under the
	 * space the window allows is a genuinely small session and is still refused,
	 * so the case above is the cap working rather than the refusal being gone.
	 */
	test("a genuinely small session on the same model is still refused", () => {
		const entries = branch(1, 2_000);

		const prepared = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS, {
			nonMessageTokens: NON_MESSAGE_TOKENS,
			contextWindow: CONTEXT_WINDOW,
		});

		expect(prepared).toBeUndefined();
	});
});

/**
 * The non-message figure is an estimate the harness makes and the prompt count
 * is a number the provider reports, so subtracting the first from the second
 * goes negative whenever they disagree about what is in the prompt. Measured on
 * 11.6% of one day's Gemini turns. Nothing downstream breaks, because the
 * scaling only applies above 1, and that is exactly why it went unnoticed for
 * as long as it did: the one place both numbers are in hand said nothing.
 */
describe("a prefix estimate larger than the whole prompt is reported", () => {
	test("the disagreement is logged, and the pass still completes", () => {
		const warn = spyOn(logger, "warn");
		try {
			const prepared = prepareCompaction(branch(20, 20_000), DEFAULT_COMPACTION_SETTINGS, {
				// Deliberately larger than the reported prompt.
				nonMessageTokens: 40_000,
				contextWindow: 200_000,
			});

			expect(prepared).toBeDefined();
			const call = warn.mock.calls.find(([message]) => String(message).startsWith("compaction: non-message"));
			expect(call?.[1]).toMatchObject({ nonMessageTokens: 40_000, promptTokens: 20_000 });
		} finally {
			warn.mockRestore();
		}
	});

	/**
	 * The negative control. A prefix that fits inside the prompt is the ordinary
	 * case and must stay quiet, or the warning is noise nobody reads.
	 */
	test("agreeing figures log nothing", () => {
		const warn = spyOn(logger, "warn");
		try {
			prepareCompaction(branch(20, 60_000), DEFAULT_COMPACTION_SETTINGS, {
				nonMessageTokens: 40_000,
				contextWindow: 200_000,
			});

			expect(warn.mock.calls.filter(([message]) => String(message).startsWith("compaction: non-message"))).toEqual(
				[],
			);
		} finally {
			warn.mockRestore();
		}
	});
});
