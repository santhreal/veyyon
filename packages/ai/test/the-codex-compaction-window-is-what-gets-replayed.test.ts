/**
 * The window Codex remote compaction v2 hands back.
 *
 * There is no window on the wire under v2: the host returns one `compaction`
 * item and nothing else, so `buildCodexCompactionV2Window` IS the artifact the
 * session stores and replays on the next turn. Everything the window drops is
 * gone from the conversation, and everything it keeps is paid for on every
 * later request, so the budget arithmetic is a product contract rather than an
 * implementation detail.
 *
 * The class this closes: a budget the caller supplies that the builder cannot
 * use. The clamp was written inline three ways in this codebase and one of them
 * returned NaN for a non-finite budget, which produced a window holding the
 * compaction item and not one user turn — a silent, total context loss that
 * reads on screen as compaction having worked.
 *
 * What it does not catch: the truncation marker's exact wording, and whether
 * the backend accepts the window it builds. Both belong to the wire suites.
 */
import { describe, expect, it } from "bun:test";
import {
	buildCodexCompactionV2Window,
	CODEX_COMPACTION_V2_RETAINED_TOKEN_BUDGET,
} from "@veyyon/ai/providers/openai-codex/compaction-v2";

const COMPACTION_ITEM = { type: "compaction", encrypted_content: "opaque" } as const;

/** A user message costing `tokens` (the estimator is 4 chars per token). */
function userMessage(label: string, tokens: number): Record<string, unknown> {
	return { role: "user", content: [{ type: "input_text", text: `${label}${"x".repeat(tokens * 4 - label.length)}` }] };
}

function texts(window: Array<Record<string, unknown>>): string[] {
	return window
		.filter(item => item.role === "user")
		.map(item => {
			const parts = Array.isArray(item.content) ? item.content : [];
			const first = parts[0];
			return typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
		});
}

describe("the window a Codex v2 compaction replays", () => {
	it("ends with the compaction item, which stands for everything dropped", () => {
		const window = buildCodexCompactionV2Window([userMessage("a", 10)], COMPACTION_ITEM);

		expect(window.at(-1)).toBe(COMPACTION_ITEM);
	});

	it("spends the budget newest-first, so the oldest turn is the one cut down", () => {
		const input = [userMessage("old", 40), userMessage("mid", 40), userMessage("new", 40)];

		const kept = texts(buildCodexCompactionV2Window(input, COMPACTION_ITEM, 90));

		expect(kept).toHaveLength(3);
		expect(kept[1]).toHaveLength(40 * 4);
		expect(kept[2]).toHaveLength(40 * 4);
		expect(kept[0]?.length).toBeLessThan(40 * 4);
		expect(kept[0]).toContain("tokens truncated");
	});

	it("drops a turn entirely once the budget is spent", () => {
		const input = [userMessage("old", 40), userMessage("mid", 40), userMessage("new", 40)];

		// 80 tokens buys the two newest exactly, leaving nothing for the third.
		const kept = texts(buildCodexCompactionV2Window(input, COMPACTION_ITEM, 80));

		expect(kept).toHaveLength(2);
		expect(kept[0]?.startsWith("mid")).toBe(true);
		expect(kept[1]?.startsWith("new")).toBe(true);
	});

	it("replays the kept turns oldest-first, the order the model read them in", () => {
		const input = [userMessage("first", 10), userMessage("second", 10)];

		const kept = texts(buildCodexCompactionV2Window(input, COMPACTION_ITEM, 1000));

		expect(kept[0]?.startsWith("first")).toBe(true);
		expect(kept[1]?.startsWith("second")).toBe(true);
	});

	it("truncates the turn that straddles the budget rather than dropping it whole", () => {
		const kept = texts(buildCodexCompactionV2Window([userMessage("big", 400)], COMPACTION_ITEM, 100));

		expect(kept).toHaveLength(1);
		expect(kept[0]?.length).toBeLessThan(400 * 4);
		expect(kept[0]).toContain("tokens truncated");
	});

	it("drops every session-synthesized user turn, keeping the ones the operator typed", () => {
		// The prefixes are the ones the session wraps around context it injects as
		// a user message. Replaying them costs the budget twice, because the next
		// request rebuilds them anyway. A new prefix added to the source list
		// without a case here leaves that kind replayed forever.
		const synthesized = [
			"<environment_context>",
			"<user_instructions>",
			"<additional_context>",
			"<skills>",
			"<token_budget>",
			"<model_switch>",
		].map(prefix => ({ role: "user", content: [{ type: "input_text", text: `${prefix}injected` }] }));
		const input = [...synthesized, userMessage("typed", 10)];

		const kept = texts(buildCodexCompactionV2Window(input, COMPACTION_ITEM, 1000));

		expect(kept).toHaveLength(1);
		expect(kept[0]?.startsWith("typed")).toBe(true);
	});
});

describe("the retained-token budget", () => {
	it("keeps at least one turn when the caller passes a budget smaller than any turn", () => {
		// A budget of 0 or 1 still has to produce a usable window: a window that is
		// only the compaction item loses the turn the user is mid-way through.
		const kept = texts(buildCodexCompactionV2Window([userMessage("only", 50)], COMPACTION_ITEM, 0));

		expect(kept).toHaveLength(1);
		expect(kept[0]?.length).toBeGreaterThan(0);
	});

	it("keeps at least one turn when the caller passes a non-finite budget", () => {
		// The defect: an inline Math.max(1, Math.min(cap, NaN)) is NaN, the loop
		// never runs, and the whole conversation vanishes behind the compaction
		// item while the turn reports success.
		for (const budget of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const window = buildCodexCompactionV2Window([userMessage("only", 50)], COMPACTION_ITEM, budget);

			expect(texts(window)).toHaveLength(1);
			expect(window.at(-1)).toBe(COMPACTION_ITEM);
		}
	});

	it("cannot be raised above the ceiling by the caller", () => {
		// The ceiling is what the backend accepts on the next request. A caller
		// asking for more must not get a window the host then rejects.
		const turns = Array.from({ length: 40 }, (_, index) => userMessage(`t${index}`, 4_000));

		const kept = texts(
			buildCodexCompactionV2Window(turns, COMPACTION_ITEM, CODEX_COMPACTION_V2_RETAINED_TOKEN_BUDGET * 10),
		);

		expect(kept.length).toBeLessThanOrEqual(CODEX_COMPACTION_V2_RETAINED_TOKEN_BUDGET / 4_000);
	});

	it("uses the ceiling when the caller names no budget", () => {
		const turns = Array.from({ length: 20 }, (_, index) => userMessage(`t${index}`, 4_000));

		const kept = texts(buildCodexCompactionV2Window(turns, COMPACTION_ITEM));

		expect(kept).toHaveLength(16);
	});
});
