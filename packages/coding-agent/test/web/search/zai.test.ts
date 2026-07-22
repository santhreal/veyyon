import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@veyyon/ai";
import { searchZai } from "@veyyon/coding-agent/web/search/providers/zai";

interface CapturedRequest {
	method: string | undefined;
	headers: Headers;
	body: Record<string, unknown>;
}

describe("Z.AI web search provider", () => {
	it("initializes a Streamable HTTP MCP session before calling web_search_prime", async () => {
		const capturedRequests: CapturedRequest[] = [];
		const fetchImpl: FetchImpl = (_input, init) => {
			const request = {
				method: init?.method,
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			};
			capturedRequests.push(request);

			if (request.body.method === "initialize") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: request.body.id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "zai-web-search", version: "test" },
							},
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json", "Mcp-Session-Id": "zai-session-1" },
						},
					),
				);
			}

			if (request.body.method === "notifications/initialized") {
				return Promise.resolve(new Response(null, { status: 202 }));
			}

			expect(request.body.method).toBe("tools/call");
			return Promise.resolve(
				new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: request.body.id,
						result: {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										search_result: [
											{
												title: "Z.AI search result",
												content: "Search result content",
												link: "https://example.com/zai",
												media: "Example",
											},
										],
									}),
								},
							],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		};
		const authStorage = {
			resolver(provider: string, options?: { sessionId?: string }) {
				expect(provider).toBe("zai");
				expect(options?.sessionId).toBe("session-zai-test");
				return async () => "zai-test-key";
			},
			hasAuth(provider: string) {
				return provider === "zai";
			},
		} as unknown as AuthStorage;

		const response = await searchZai({
			query: "veyyon z.ai search",
			authStorage,
			fetch: fetchImpl,
			sessionId: "session-zai-test",
		});

		expect(capturedRequests.map(request => request.body.method)).toEqual([
			"initialize",
			"notifications/initialized",
			"tools/call",
		]);
		expect(capturedRequests[0]?.headers.get("Authorization")).toBe("Bearer zai-test-key");
		expect(capturedRequests[1]?.headers.get("Mcp-Session-Id")).toBe("zai-session-1");
		expect(capturedRequests[2]?.headers.get("Mcp-Session-Id")).toBe("zai-session-1");
		expect(response.sources).toEqual([
			{
				title: "Z.AI search result",
				url: "https://example.com/zai",
				snippet: "Search result content",
				publishedDate: undefined,
				ageSeconds: undefined,
				author: "Example",
			},
		]);
	});

	// Regression lock for the provider-consistency fix: zai was the one list
	// provider that declared DEFAULT_NUM_RESULTS but no MAX and never called the
	// shared clampNumResults, so an oversized `num_results` reached the Z.AI API
	// as `count` and the post-fetch slice unclamped. searchZai now caps to 20 (the
	// house default) at its shared entry, so BOTH the outbound `count` and the
	// returned sources are bounded regardless of caller. If the clamp is removed
	// or bypassed, the count sent or the slice length will exceed 20 and fail.
	it("clamps an oversized num_results to the provider max for both the API count and the slice", async () => {
		const toolCallArgs: Record<string, unknown>[] = [];
		const fetchImpl: FetchImpl = (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

			if (body.method === "initialize") {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "zai-web-search", version: "test" },
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json", "Mcp-Session-Id": "zai-session-2" } },
					),
				);
			}
			if (body.method === "notifications/initialized") {
				return Promise.resolve(new Response(null, { status: 202 }));
			}

			// Capture the arguments the tool call actually sent (carries `count`).
			toolCallArgs.push((body.params as { arguments: Record<string, unknown> }).arguments);
			// Return MORE results than the cap so the client-side slice is exercised.
			const many = Array.from({ length: 25 }, (_, index) => ({
				title: `Z.AI result ${index + 1}`,
				content: `content ${index + 1}`,
				link: `https://example.com/zai-${index + 1}`,
				media: "Example",
			}));
			return Promise.resolve(
				new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: { content: [{ type: "text", text: JSON.stringify({ search_result: many }) }] },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		};
		const authStorage = {
			resolver() {
				return async () => "zai-test-key";
			},
			hasAuth(provider: string) {
				return provider === "zai";
			},
		} as unknown as AuthStorage;

		const response = await searchZai({
			query: "veyyon z.ai oversized request",
			num_results: 99,
			authStorage,
			fetch: fetchImpl,
			sessionId: "session-zai-clamp",
		});

		// The outbound API request asked for exactly the cap, not the requested 99.
		expect(toolCallArgs).toHaveLength(1);
		expect(toolCallArgs[0]?.count).toBe(20);
		// And the returned sources are sliced to the cap even though 25 came back.
		expect(response.sources).toHaveLength(20);
	});
});
