/**
 * WHY: `buildCodexCompactionV2Window` decides which items of a span are real
 * user turns. Everything it rejects is gone from the replayed history, and
 * everything it accepts is replayed forever, so the predicate is the whole
 * contract -- the budget arithmetic downstream of it only decides how much of
 * an accepted turn survives.
 *
 * The class this closes is "the predicate answers the wrong question": a
 * session-synthesized block retained and duplicated on every later turn, a real
 * turn rejected because the Responses input omits `type` on user items, an
 * assistant or tool item admitted because only the content shape was checked.
 * Each produces a well-formed window, so nothing downstream can notice.
 *
 * The synthesized-prefix cell sweeps `CONTEXTUAL_USER_PREFIXES` from the module
 * rather than restating it, so a prefix added there without working is red here.
 *
 * What it does NOT catch: how much of an accepted turn is kept.
 * `the-codex-compaction-window-is-what-gets-replayed.test.ts` owns the budget,
 * the ordering and the truncation, and this suite deliberately does not restate
 * them.
 */
import { describe, expect, it } from "bun:test";
import { buildCodexCompactionV2Window, CONTEXTUAL_USER_PREFIXES } from "../src/providers/openai-codex/compaction-v2";

const COMPACTION_ITEM: Record<string, unknown> = { type: "compaction", summary: "everything before this" };

function userMessage(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { role: "user", content: [{ type: "input_text", text }], ...extra };
}

/** Read one message's first text part, checked rather than asserted. */
function firstText(item: Record<string, unknown> | undefined): string {
	if (!item || !Array.isArray(item.content)) throw new Error("item carries no content array");
	const part = item.content[0];
	if (!part || typeof part !== "object" || !("text" in part)) throw new Error("first part carries no text");
	const text = part.text;
	if (typeof text !== "string") throw new Error("text part is not a string");
	return text;
}

function retainedTexts(input: readonly unknown[]): string[] {
	const window = buildCodexCompactionV2Window(input, COMPACTION_ITEM);
	expect(window.at(-1)).toBe(COMPACTION_ITEM);
	return window.slice(0, -1).map(firstText);
}

describe("a synthesized turn never survives a codex compaction", () => {
	it("keeps a user turn whose type field is absent", () => {
		// `buildResponsesInput` omits `type` on user items. Requiring
		// `type === "message"` retained nothing and every window came back as the
		// bare compaction item, which is the defect this cell pins.
		expect(retainedTexts([userMessage("untyped")])).toEqual(["untyped"]);
		expect(retainedTexts([userMessage("typed", { type: "message" })])).toEqual(["typed"]);
	});

	it("retains no item that is not a real user message", () => {
		expect(
			retainedTexts([
				{ role: "assistant", content: [{ type: "output_text", text: "assistant" }] },
				{ role: "system", content: [{ type: "input_text", text: "system" }] },
				userMessage("tool result", { type: "function_call_output" }),
				null,
				"a bare string",
			]),
		).toEqual([]);
	});

	it("drops every synthesized prefix the module declares", () => {
		// Swept from the module's own list: a prefix added there without working
		// is red here rather than a duplicated block on the next replay.
		expect(CONTEXTUAL_USER_PREFIXES.length).toBeGreaterThan(0);
		for (const prefix of CONTEXTUAL_USER_PREFIXES) {
			expect(retainedTexts([userMessage(`${prefix} injected`), userMessage("real")])).toEqual(["real"]);
		}
	});

	it("matches a synthesized prefix past leading whitespace and case, and only at the start", () => {
		const prefix = CONTEXTUAL_USER_PREFIXES[0];
		if (prefix === undefined) throw new Error("the module exports no contextual prefixes");
		const mentioned = `a real turn that mentions ${prefix} in passing`;

		expect(
			retainedTexts([userMessage(`\n  ${prefix.toUpperCase()} indented and shouted`), userMessage(mentioned)]),
		).toEqual([mentioned]);
	});

	it("rejects a turn when any of its parts opens with a synthesized prefix", () => {
		const prefix = CONTEXTUAL_USER_PREFIXES[0];
		if (prefix === undefined) throw new Error("the module exports no contextual prefixes");

		// The predicate scans every part, not the first, so one synthesized part
		// discards the whole turn. That is the safe direction for the injected
		// blocks it is aimed at, which arrive as a message of their own; the cost
		// is that an operator turn quoting the tag in a later part goes with it.
		// Pinned as the rule rather than filed as a defect: narrowing it to the
		// first part is a behavior change, not a merge decision.
		const quoted: Record<string, unknown> = {
			role: "user",
			content: [
				{ type: "input_text", text: "what does this tag do?" },
				{ type: "input_text", text: `${prefix} something` },
			],
		};

		expect(retainedTexts([quoted, userMessage("plain")])).toEqual(["plain"]);
	});
});
