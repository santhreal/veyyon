/**
 * WHY
 *
 * THE DEFECT. `hasRenderableSearchContent` decides two things at once: whether a response is handed
 * to the model, and whether the provider chain stops. It counted `relatedQuestions` and
 * `searchQueries` as content. Neither answers anything — the type calls them "follow-up question
 * suggestions" and "intermediate search queries" — so a provider that found nothing but offered a
 * "did you mean" ended the search, and the model received a list of questions where the results
 * should have been. SearXNG reaches this on an ordinary misspelling: `searxng.ts` maps the engine's
 * `suggestions` straight into `relatedQuestions`, so zero results plus a spelling suggestion looked
 * like a successful search and a provider with real results was never called.
 *
 * THE CLASS. Metadata standing in for content — the same shape as the bot wall that was counted as
 * an answer, one field further in. It closes on the property rather than the field: for every
 * accompaniment the response type carries, a response holding ONLY accompaniments must fall
 * through. The accompaniment set is derived from the response shape at run time, so a sixth field
 * added later turns this suite red until someone classifies it.
 *
 * The suite drives the real `WebSearchTool.execute` over the real provider-fallback loop, with only
 * the provider chain itself faked — the decision under test is the loop's, not a provider's.
 *
 * WHAT IT DOES NOT CATCH: whether any individual provider populates these fields correctly, which
 * is each provider's own suite, and how the result is drawn, which is `render.ts`.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@veyyon/ai";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { WebSearchTool } from "@veyyon/coding-agent/web/search";
import * as provider from "@veyyon/coding-agent/web/search/provider";
import type { SearchParams } from "@veyyon/coding-agent/web/search/providers/base";
import type { SearchProviderId, SearchResponse } from "@veyyon/coding-agent/web/search/types";
import { useIsolatedAgentDir } from "../../helpers/isolated-agent-dir";
import { makeToolSession } from "../../helpers/tool-session";

useIsolatedAgentDir();

const FAKE_SESSION: ToolSession = makeToolSession({
	authStorage: {
		getApiKey: async () => undefined,
		resolver: () => async () => undefined,
		getOAuthAccountId: () => undefined,
	} as unknown as AuthStorage,
});

/**
 * The fields that accompany an answer without being one, and a response carrying only that field.
 * Every entry must fall through. Adding a field to `SearchResponse` and leaving it out of both this
 * list and {@link CONTENT_FIELDS} fails the closure test below.
 */
const ACCOMPANIMENT_CASES: ReadonlyArray<{ field: string; response: () => SearchResponse }> = [
	{
		field: "relatedQuestions",
		// What SearXNG returns for a misspelling: no results, one spelling suggestion.
		response: () => ({ provider: "searxng", sources: [], relatedQuestions: ["did you mean widget"] }),
	},
	{
		field: "searchQueries",
		// What a grounded model returns when it ran a search and got nothing back.
		response: () => ({ provider: "anthropic", sources: [], searchQueries: ["widget release date"] }),
	},
	{
		field: "relatedQuestions+searchQueries",
		response: () => ({
			provider: "searxng",
			sources: [],
			relatedQuestions: ["did you mean widget"],
			searchQueries: ["widgit"],
		}),
	},
];

/** The fields that ARE an answer. Each must be accepted on its own and must stop the chain. */
const CONTENT_FIELDS = ["answer", "sources", "citations"] as const;

function fakeProvider(
	id: SearchProviderId,
	behaviour: (params: SearchParams) => Promise<SearchResponse>,
): provider.SearchProvider {
	return { id, label: id, isAvailable: () => true, isExplicitlyAvailable: () => true, search: behaviour };
}

function mockProviderChain(providers: provider.SearchProvider[]) {
	vi.spyOn(provider, "resolveProviderCandidates").mockReturnValue(
		providers.map(({ id }) => ({ id, explicit: false })),
	);
	vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => {
		const match = providers.find(candidate => candidate.id === id);
		if (!match) throw new Error(`Unexpected provider: ${id}`);
		return match;
	});
}

function textOf(result: { content: Array<{ type: string } & Record<string, unknown>> }): string {
	const block = result.content[0];
	return block && "text" in block ? String(block.text) : "";
}

const REAL_RESULT = {
	title: "Widget release notes",
	url: "https://example.com/widget",
	snippet: "the actual answer",
};

describe("a search that returned only metadata is not an answer", () => {
	afterEach(() => vi.restoreAllMocks());

	for (const { field, response } of ACCOMPANIMENT_CASES) {
		it(`keeps searching when a provider returns only ${field}`, async () => {
			const metadataOnly = vi.fn(async () => response());
			const withResults = vi.fn(
				async (): Promise<SearchResponse> => ({ provider: "brave", sources: [REAL_RESULT] }),
			);
			mockProviderChain([fakeProvider("searxng", metadataOnly), fakeProvider("brave", withResults)]);

			const result = await new WebSearchTool(FAKE_SESSION).execute("id", { query: "widgit" });

			// The chain continued rather than stopping on the suggestion.
			expect(withResults).toHaveBeenCalledTimes(1);
			expect(result.details?.response.provider).toBe("brave");
			expect(textOf(result)).toContain("Widget release notes");
			// And the suggestion is not what the model was handed.
			expect(textOf(result)).not.toContain("did you mean widget");
		});
	}

	it("reports a failure rather than a list of questions when metadata is all any provider has", async () => {
		// The honest end state: nothing answered the query. A block of suggestions presented as the
		// result is worse than an error, because the model cannot tell it apart from a real answer.
		mockProviderChain([
			fakeProvider("searxng", async () => ({
				provider: "searxng",
				sources: [],
				relatedQuestions: ["did you mean widget"],
			})),
		]);

		const result = await new WebSearchTool(FAKE_SESSION).execute("id", { query: "widgit" });

		expect(textOf(result)).toContain("Error:");
		expect(result.details?.error).toBeTruthy();
		expect(textOf(result)).not.toContain("did you mean widget");
	});

	for (const field of CONTENT_FIELDS) {
		it(`accepts a response whose only content is ${field}, and stops there`, async () => {
			const base: SearchResponse = { provider: "searxng", sources: [] };
			const response: SearchResponse =
				field === "answer"
					? { ...base, answer: "Widgets shipped on Tuesday." }
					: field === "sources"
						? { ...base, sources: [REAL_RESULT] }
						: { ...base, citations: [{ url: "https://example.com/widget", title: "Widget release notes" }] };

			const first = vi.fn(async () => response);
			const second = vi.fn(async (): Promise<SearchResponse> => ({ provider: "brave", sources: [REAL_RESULT] }));
			mockProviderChain([fakeProvider("searxng", first), fakeProvider("brave", second)]);

			const result = await new WebSearchTool(FAKE_SESSION).execute("id", { query: "widget" });

			expect(first).toHaveBeenCalledTimes(1);
			// Real content ends the chain: a second provider is a second network call for nothing.
			expect(second).not.toHaveBeenCalled();
			expect(result.details?.response.provider).toBe("searxng");
			expect(result.details?.error).toBeFalsy();
		});
	}

	it("classifies every optional field of the response, so a new one cannot be added unnoticed", async () => {
		// Derived from the shape a provider actually produces rather than from a list written here:
		// a field added to SearchResponse and populated by a provider shows up in this union and
		// must be recorded as either content or accompaniment before the suite goes green again.
		const populated: SearchResponse = {
			provider: "searxng",
			sources: [REAL_RESULT],
			answer: "Widgets shipped on Tuesday.",
			citations: [{ url: "https://example.com/widget", title: "Widget release notes" }],
			relatedQuestions: ["did you mean widget"],
			searchQueries: ["widgit"],
			usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
			model: "test-model",
			requestId: "req-1",
		};

		// Fields that carry no bearing on whether the query was answered.
		const NEITHER = new Set(["provider", "usage", "model", "requestId"]);
		const classified = new Set<string>([...CONTENT_FIELDS, "relatedQuestions", "searchQueries", ...NEITHER]);

		const unclassified = Object.keys(populated).filter(key => !classified.has(key));
		expect(unclassified).toEqual([]);
	});
});
