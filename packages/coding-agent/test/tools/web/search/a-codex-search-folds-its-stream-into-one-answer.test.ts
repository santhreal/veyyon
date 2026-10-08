/**
 * WHY THIS SUITE EXISTS. `providers/codex-answer.ts` turns the Responses events of a Codex web search
 * into the answer, sources, model, request id and usage the search tool reports. A dropped event kind
 * is silent: the search succeeds with a shorter answer, a missing source, the requested model instead
 * of the one that answered, or token counts that bill cached input twice.
 *
 * THE CLASS. Every event kind the collector reads is driven here: text deltas, message items with and
 * without `url_citation` annotations, reasoning summaries, `response.completed` and `response.done`,
 * `error` and `response.failed`, and an event of a kind it skips.
 *
 * WHAT IT DOES NOT CATCH. Image placeholder detection and the link extraction used when annotations are
 * absent are driven through `searchCodex` in `web-search-codex.test.ts`, which also covers the request
 * and the HTTP error mapping.
 */
import { describe, expect, it } from "bun:test";
import {
	CodexAnswerCollector,
	type CodexSearchEvent,
} from "@veyyon/coding-agent/tools/web/search/providers/codex-answer";
import { SearchProviderError } from "@veyyon/coding-agent/tools/web/search/types";

function fold(events: CodexSearchEvent[], requestedModel = "gpt-requested") {
	const collector = new CodexAnswerCollector(requestedModel);
	for (const event of events) collector.accept(event);
	return collector.finish();
}

function caught(run: () => unknown): SearchProviderError {
	try {
		run();
	} catch (error) {
		if (error instanceof SearchProviderError) return error;
		throw error;
	}
	throw new Error("expected a SearchProviderError");
}

const message = (text: string, annotations: Array<{ type: string; url?: string; title?: string }> = []) =>
	({
		type: "response.output_item.done",
		item: { type: "message", content: [{ type: "output_text", text, annotations }] },
	}) satisfies CodexSearchEvent;

describe("a Codex search folds its stream into one answer", () => {
	it("joins message text and reasoning summaries in arrival order with a blank line", () => {
		const result = fold([
			message("First paragraph."),
			{
				type: "response.output_item.done",
				item: {
					type: "reasoning",
					summary: [
						{ type: "summary_text", text: "Reasoned step." },
						{ type: "other", text: "skipped" },
					],
				},
			},
			message("Second paragraph."),
		]);

		expect(result.answer).toBe("First paragraph.\n\nReasoned step.\n\nSecond paragraph.");
	});

	it("takes sources from url_citation annotations, once per URL, titled by the URL when untitled", () => {
		const result = fold([
			message("Cited.", [
				{ type: "url_citation", url: "https://a.example/one", title: "One" },
				{ type: "file_citation", url: "https://a.example/file" },
				{ type: "url_citation", url: "https://a.example/one", title: "One again" },
				{ type: "url_citation", url: "https://a.example/two" },
			]),
		]);

		expect(result.sources).toEqual([
			{ title: "One", url: "https://a.example/one" },
			{ title: "https://a.example/two", url: "https://a.example/two" },
		]);
	});

	it("answers with the final output text over the streamed deltas", () => {
		const result = fold([
			{ type: "response.output_text.delta", delta: "streamed " },
			{ type: "response.output_text.delta", delta: "text" },
			message("Final text."),
		]);

		expect(result.answer).toBe("Final text.");
	});

	it("answers with the joined deltas when no output item carries text", () => {
		const result = fold([
			{ type: "response.output_text.delta", delta: "streamed " },
			{ type: "response.output_text.delta", delta: 7 },
			{ type: "response.output_text.delta", delta: "text https://b.example/page" },
		]);

		expect(result.answer).toBe("streamed text https://b.example/page");
		expect(result.sources).toEqual([{ title: "https://b.example/page", url: "https://b.example/page" }]);
	});

	for (const type of ["response.completed", "response.done"] as const) {
		it(`reads the answering model, request id and usage net of cached input from ${type}`, () => {
			const result = fold([
				message("Answer."),
				{
					type,
					response: {
						id: "resp_1",
						model: "gpt-answered",
						usage: {
							input_tokens: 120,
							output_tokens: 30,
							total_tokens: 150,
							input_tokens_details: { cached_tokens: 100 },
						},
					},
				},
			]);

			expect(result).toMatchObject({
				model: "gpt-answered",
				requestId: "resp_1",
				usage: { inputTokens: 20, outputTokens: 30, totalTokens: 150 },
			});
		});
	}

	it("reports the requested model, no request id and no usage when the stream never completes", () => {
		const result = fold([message("Answer.")], "gpt-requested");

		expect(result.model).toBe("gpt-requested");
		expect(result.requestId).toBe("");
		expect(result.usage).toBeUndefined();
	});

	it("skips an event of a kind it does not read", () => {
		const unread = { type: "response.created", response: { model: "gpt-ignored" } } as unknown as CodexSearchEvent;

		expect(fold([unread, message("Answer.")]).model).toBe("gpt-requested");
	});

	it("fails on an error event with its code and message", () => {
		const collector = new CodexAnswerCollector("gpt-requested");
		const error = caught(() => collector.accept({ type: "error", code: "rate_limit", message: "slow down" }));

		expect(error.message).toBe("Codex error (rate_limit): slow down");
		expect(error.status).toBe(500);
		expect(caught(() => collector.accept({ type: "error" })).message).toBe("Codex error (): Unknown error");
	});

	it("fails on a response.failed event with the response's error message", () => {
		const collector = new CodexAnswerCollector("gpt-requested");
		const error = caught(() =>
			collector.accept({ type: "response.failed", response: { error: { message: "upstream timeout" } } }),
		);

		expect(error.message).toBe("Codex request failed: upstream timeout");
		expect(error.status).toBe(500);
		expect(caught(() => collector.accept({ type: "response.failed" })).message).toBe(
			"Codex request failed: Request failed",
		);
	});

	it("fails as image-only when the stream held no text and no source", () => {
		const error = caught(() => fold([{ type: "response.completed", response: { id: "resp_2" } }]));

		expect(error.message).toBe("Codex returned image-only response");
		expect(error.status).toBe(502);
	});
});
