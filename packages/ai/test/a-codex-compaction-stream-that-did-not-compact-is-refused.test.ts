/**
 * WHY: `collectCodexCompactionV2Stream` is the only thing standing between a
 * backend that did not compact and a session that believes it did. Every
 * refusal it makes turns into a local compaction pass; every refusal it misses
 * turns into a stored history that never shrinks, for the rest of the session.
 *
 * The class this closes is "the stream ended, so it worked": zero compaction
 * items because the trigger item did not take and the span ran as an ordinary
 * turn, more than one because the window would be ambiguous, a stream cut off
 * before `response.completed`, and a terminal failure event read as an ordinary
 * one. Each of those leaves a plausible-looking result behind.
 *
 * It also pins that the provider's own words reach the message only through the
 * caller's sanitizer, because a compaction failure is one of the few paths that
 * quotes a provider error verbatim into a thrown string.
 *
 * What it does NOT catch: whether the backend honours the trigger item, or what
 * the caller does with the refusal. The route owns the first
 * (`packages/agent/test/a-chatgpt-oauth-session-compacts-on-the-codex-backend.test.ts`)
 * and the compaction caller owns the second.
 */
import { describe, expect, it } from "bun:test";
import { collectCodexCompactionV2Stream } from "../src/providers/openai-codex/compaction-v2";

const COMPACTION_ITEM: Record<string, unknown> = { type: "compaction", summary: "everything before this" };

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

describe("a codex compaction stream that did not compact is refused", () => {
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

	it("reports no usage when the completed event carried none", async () => {
		const result = await collectCodexCompactionV2Stream(
			sseStream([
				{ type: "response.output_item.done", item: COMPACTION_ITEM },
				{ type: "response.completed", response: { usage: { input_tokens: "many" } } },
			]),
			undefined,
			echo,
		);

		// A non-numeric count is absent, not zero: a caller that meters compaction
		// cost must not record a real spend as free.
		expect(result.usage).toBeUndefined();
	});

	it("refuses a stream that carried no compaction item", async () => {
		// The backend ran the span as an ordinary turn: the trigger did not take.
		// Storing that history leaves the session uncompacted and still growing.
		await expect(
			collectCodexCompactionV2Stream(
				sseStream([
					{ type: "response.output_item.done", item: { type: "message", role: "assistant" } },
					{ type: "response.completed", response: {} },
				]),
				undefined,
				echo,
			),
		).rejects.toThrow(/returned 0 compaction items among 1 output items/);
	});

	it("refuses a stream that carried more than one compaction item", async () => {
		await expect(
			collectCodexCompactionV2Stream(
				sseStream([
					{ type: "response.output_item.done", item: COMPACTION_ITEM },
					{ type: "response.output_item.done", item: { type: "compaction", summary: "a second window" } },
					{ type: "response.completed", response: {} },
				]),
				undefined,
				echo,
			),
		).rejects.toThrow(/returned 2 compaction items/);
	});

	it("refuses a stream that ended before the response completed", async () => {
		// A truncated stream can still have delivered the item. Accepting it would
		// store a window the backend never said it finished building.
		await expect(
			collectCodexCompactionV2Stream(
				sseStream([{ type: "response.output_item.done", item: COMPACTION_ITEM }]),
				undefined,
				echo,
			),
		).rejects.toThrow(/closed before response\.completed/);
	});

	it("names every terminal event it treats as a failure", async () => {
		for (const type of ["response.failed", "response.incomplete", "error"]) {
			await expect(collectCodexCompactionV2Stream(sseStream([{ type }]), undefined, echo)).rejects.toThrow(
				new RegExp(`Codex compaction stream ${type.replace(".", "\\.")}\\.`),
			);
		}
	});

	it("says the history was not compacted on every refusal", async () => {
		// The caller reads this sentence to decide to run a local pass. A refusal
		// that omits it is a refusal a reader can mistake for a transport hiccup.
		const streams = [
			[{ type: "response.output_item.done", item: COMPACTION_ITEM }],
			[{ type: "response.completed", response: {} }],
			[{ type: "response.failed" }],
		];
		for (const events of streams) {
			await expect(collectCodexCompactionV2Stream(sseStream(events), undefined, echo)).rejects.toThrow(
				/The history was NOT compacted; the caller falls back to local compaction\./,
			);
		}
	});

	it("sanitizes the provider's own words before they reach the failure message", async () => {
		const seen: string[] = [];
		const sanitize = (text: string): string => {
			seen.push(text);
			return text.replace("sk-live-abcdef", "[redacted]");
		};

		await expect(
			collectCodexCompactionV2Stream(
				sseStream([
					{
						type: "response.failed",
						response: { error: { code: "bad_key", message: "token sk-live-abcdef is invalid" } },
					},
				]),
				undefined,
				sanitize,
			),
		).rejects.toThrow(/\(bad_key\): token \[redacted\] is invalid/);

		// Both operator-visible strings go through the sanitizer, so neither can
		// reach a log or a transcript unfiltered.
		expect(seen).toEqual(["bad_key", "token sk-live-abcdef is invalid"]);
	});
});
