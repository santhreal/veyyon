/**
 * WHY: `compaction-v2.ts` decides what survives a Codex remote compaction. It
 * shipped with its route covered end to end and its own rules covered nowhere,
 * so the two decisions that lose data silently -- which user turns are real,
 * and what happens at the budget edge -- were asserted by nothing.
 *
 * The class this closes is "a retained window that is wrong but well-formed":
 * a synthesized turn kept and duplicated on replay, a real turn dropped because
 * its `type` was absent, an overflowing turn discarded instead of truncated, a
 * caller-supplied budget escaping the cap. Each is invisible downstream, since
 * every one of them still produces a valid array ending in the compaction item.
 *
 * The synthesized-prefix cell sweeps the exported list rather than restating
 * it, so a prefix added to the module without working is red here.
 *
 * What it does NOT catch: whether the backend actually honours the trigger item
 * or serves the wire this module reads. That is the route's contract and
 * `packages/agent/test/a-chatgpt-oauth-session-compacts-on-the-codex-backend.test.ts`
 * owns it. Nor does it pin the token estimator's arithmetic, which is an
 * approximation by construction -- the cells assert ordering, retention and
 * bounds, which hold whatever the estimate is.
 */
import { describe, expect, it } from "bun:test";
import {
	buildCodexCompactionV2Window,
	CODEX_COMPACTION_V2_RETAINED_TOKEN_BUDGET,
	CONTEXTUAL_USER_PREFIXES,
	collectCodexCompactionV2Stream,
} from "../src/providers/openai-codex/compaction-v2";

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

function texts(window: Array<Record<string, unknown>>): string[] {
	return window.slice(0, -1).map(firstText);
}

function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			controller.close();
		},
	});
}

const echo = (text: string): string => text;

describe("a compacted codex window keeps the real user turns", () => {
	it("ends with the compaction item and replays the kept turns oldest first", () => {
		const window = buildCodexCompactionV2Window(
			[
				userMessage("first"),
				{ role: "assistant", content: [{ type: "output_text", text: "reply" }] },
				userMessage("second"),
			],
			COMPACTION_ITEM,
		);

		// Retention walks newest-first to spend the budget; the stored history is
		// replayed in order, so the result must come back chronological.
		expect(texts(window)).toEqual(["first", "second"]);
		expect(window.at(-1)).toBe(COMPACTION_ITEM);
	});

	it("keeps a user turn whose type field is absent", () => {
		// `buildResponsesInput` omits `type` on user items. Requiring
		// `type === "message"` retained nothing and every window came back as the
		// bare compaction item, which is the defect this cell pins.
		const withType = buildCodexCompactionV2Window([userMessage("typed", { type: "message" })], COMPACTION_ITEM);
		const without = buildCodexCompactionV2Window([userMessage("untyped")], COMPACTION_ITEM);

		expect(texts(withType)).toEqual(["typed"]);
		expect(texts(without)).toEqual(["untyped"]);
	});

	it("retains no item that is not a real user message", () => {
		const window = buildCodexCompactionV2Window(
			[
				{ role: "assistant", content: [{ type: "output_text", text: "assistant" }] },
				{ role: "system", content: [{ type: "input_text", text: "system" }] },
				userMessage("tool result", { type: "function_call_output" }),
				null,
				"a bare string",
			],
			COMPACTION_ITEM,
		);

		expect(window).toEqual([COMPACTION_ITEM]);
	});

	it("drops every synthesized user turn the session rebuilds each turn", () => {
		// Swept from the module's own list: a prefix added there without working
		// is red here rather than a duplicated turn on the next replay.
		expect(CONTEXTUAL_USER_PREFIXES.length).toBeGreaterThan(0);
		for (const prefix of CONTEXTUAL_USER_PREFIXES) {
			const window = buildCodexCompactionV2Window(
				[userMessage(`${prefix} injected`), userMessage("real")],
				COMPACTION_ITEM,
			);
			expect(texts(window)).toEqual(["real"]);
		}
	});

	it("matches a synthesized prefix past leading whitespace and case, and only at the start", () => {
		const prefix = CONTEXTUAL_USER_PREFIXES[0];
		if (prefix === undefined) throw new Error("the module exports no contextual prefixes");
		const window = buildCodexCompactionV2Window(
			[
				userMessage(`\n  ${prefix.toUpperCase()} indented and shouted`),
				userMessage(`a real turn that mentions ${prefix} in passing`),
			],
			COMPACTION_ITEM,
		);

		expect(texts(window)).toEqual([`a real turn that mentions ${prefix} in passing`]);
	});

	it("spends the budget on the newest turns and truncates the one that straddles the edge", () => {
		const oldest = "o".repeat(4000); // ~1000 tokens
		const newest = "n".repeat(4000);
		const window = buildCodexCompactionV2Window([userMessage(oldest), userMessage(newest)], COMPACTION_ITEM, 1200);

		// The newest fits whole; the older one is cut down to the remainder rather
		// than dropped, so the window still shows that the turn happened.
		const kept = texts(window);
		expect(kept).toHaveLength(2);
		expect(kept[1]).toBe(newest);
		expect(kept[0]).not.toBe(oldest);
		expect(kept[0]).toContain("tokens truncated");
		expect(kept[0]?.length).toBeLessThan(oldest.length);
	});

	it("clamps the caller's budget to the retained ceiling at both ends", () => {
		const turns = Array.from({ length: 40 }, (_, index) => userMessage(`${index}:${"t".repeat(8000)}`));

		// Above the ceiling: a caller cannot buy a larger window than the backend
		// budget by passing a bigger number.
		const huge = buildCodexCompactionV2Window(
			turns,
			COMPACTION_ITEM,
			CODEX_COMPACTION_V2_RETAINED_TOKEN_BUDGET * 100,
		);
		const capped = buildCodexCompactionV2Window(turns, COMPACTION_ITEM, CODEX_COMPACTION_V2_RETAINED_TOKEN_BUDGET);
		expect(huge.length).toBe(capped.length);
		expect(huge.length).toBeLessThan(turns.length + 1);

		// At or below zero: the floor is one token, so the newest turn is still
		// represented and the walk terminates instead of spinning on a dead budget.
		for (const budget of [0, -1, Number.NEGATIVE_INFINITY]) {
			const window = buildCodexCompactionV2Window(turns, COMPACTION_ITEM, budget);
			expect(window.at(-1)).toBe(COMPACTION_ITEM);
			expect(window.length).toBeLessThanOrEqual(2);
		}
	});
});

describe("a codex compaction stream that did not compact says so", () => {
	it("returns the single compaction item with the usage beside it", async () => {
		const result = await collectCodexCompactionV2Stream(
			sseStream([
				{ type: "response.output_item.done", item: COMPACTION_ITEM },
				{ type: "response.completed", response: { usage: { input_tokens: 120, output_tokens: 7 } } },
			]),
			undefined,
			echo,
		);

		expect(result.compactionItem).toEqual(COMPACTION_ITEM);
		expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 7 });
	});

	it("refuses a stream that carried no compaction item", async () => {
		// The backend ran the span as an ordinary turn: the trigger did not take.
		// Storing that history would leave the session uncompacted and growing.
		const promise = collectCodexCompactionV2Stream(
			sseStream([
				{ type: "response.output_item.done", item: { type: "message", role: "assistant" } },
				{ type: "response.completed", response: {} },
			]),
			undefined,
			echo,
		);

		await expect(promise).rejects.toThrow(/returned 0 compaction items among 1 output items/);
	});

	it("refuses a stream that carried more than one compaction item", async () => {
		const promise = collectCodexCompactionV2Stream(
			sseStream([
				{ type: "response.output_item.done", item: COMPACTION_ITEM },
				{ type: "response.output_item.done", item: { type: "compaction", summary: "a second window" } },
				{ type: "response.completed", response: {} },
			]),
			undefined,
			echo,
		);

		await expect(promise).rejects.toThrow(/returned 2 compaction items/);
	});

	it("refuses a stream that ended before the response completed", async () => {
		const promise = collectCodexCompactionV2Stream(
			sseStream([{ type: "response.output_item.done", item: COMPACTION_ITEM }]),
			undefined,
			echo,
		);

		await expect(promise).rejects.toThrow(/closed before response\.completed/);
	});

	it("sanitizes the provider's own words before they reach the failure message", async () => {
		const secrets: string[] = [];
		const sanitize = (text: string): string => {
			secrets.push(text);
			return text.replace("sk-live-abcdef", "[redacted]");
		};

		const promise = collectCodexCompactionV2Stream(
			sseStream([
				{
					type: "response.failed",
					response: { error: { code: "bad_key", message: "token sk-live-abcdef is invalid" } },
				},
			]),
			undefined,
			sanitize,
		);

		// Both operator-supplied strings go through the sanitizer, and the raw
		// credential never reaches the thrown message.
		await expect(promise).rejects.toThrow(/\(bad_key\): token \[redacted\] is invalid/);
		expect(secrets).toEqual(["bad_key", "token sk-live-abcdef is invalid"]);
	});

	it("names the terminal event that failed", async () => {
		for (const type of ["response.failed", "response.incomplete", "error"]) {
			const promise = collectCodexCompactionV2Stream(sseStream([{ type }]), undefined, echo);
			await expect(promise).rejects.toThrow(new RegExp(`Codex compaction stream ${type.replace(".", "\\.")}\\.`));
		}
	});
});
