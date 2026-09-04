import { describe, expect, test } from "bun:test";
import type { ModelManagerOptions } from "@veyyon/catalog/model-manager";
import * as openaiCompat from "@veyyon/catalog/provider-models/openai-compat";
import type { Api, FetchImpl } from "@veyyon/catalog/types";
import { getOpenCodeUserAgent } from "@veyyon/catalog/wire/opencode-headers";

/**
 * WHY: OpenCode requires a client user agent on gateway traffic and flags
 * traffic that sends none. The streaming transports were wired for it while
 * model discovery was not, so `GET https://opencode.ai/zen/v1/models` and its
 * `/zen/go/v1` sibling read the gateway with the user's API key sending only
 * `Accept` and `Authorization`. Discovery failing closed empties the model
 * picker, which surfaces as paid models missing rather than as a header fault.
 *
 * THE CLASS: any request veyyon sends to an OpenCode gateway. Both discovery
 * factories are members, and the sweep below enumerates them from the module's
 * exports so a third one fails here until it is either wired or recorded as an
 * exception.
 *
 * WHAT THIS DOES NOT CATCH: whether the gateway accepts these exact bytes. That
 * needs a credential this suite does not have, so the assertion is that the
 * header is present and carries the shared value, not that it satisfies
 * OpenCode's filter.
 */

/** Every OpenCode discovery factory the module exports, resolved at run time. */
function openCodeModelManagerFactories(): [
	string,
	(config: { apiKey: string; fetch: FetchImpl }) => ModelManagerOptions<Api>,
][] {
	const factories: [string, (config: { apiKey: string; fetch: FetchImpl }) => ModelManagerOptions<Api>][] = [];
	for (const [name, value] of Object.entries(openaiCompat)) {
		if (!/^opencode.*ModelManagerOptions$/.test(name)) continue;
		if (typeof value !== "function") continue;
		const factory = value as (config: { apiKey: string; fetch: FetchImpl }) => ModelManagerOptions<Api>;
		factories.push([name, factory]);
	}
	return factories;
}

function recordingFetch(seen: { url: string; headers: Headers }[]): FetchImpl {
	return Object.assign(
		async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			seen.push({ url, headers: new Headers(init?.headers) });
			return new Response(JSON.stringify({ data: [{ id: "claude-fable-5-1" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
		{ preconnect: () => {} },
	);
}

describe("OpenCode discovery identifies the client", () => {
	test("both gateway discovery factories are swept", () => {
		// Pinned by exact equality: a new OpenCode factory turns this red rather
		// than silently skipping the header assertion below.
		expect(
			openCodeModelManagerFactories()
				.map(([name]) => name)
				.sort(),
		).toEqual(["opencodeGoModelManagerOptions", "opencodeZenModelManagerOptions"]);
	});

	test.each(openCodeModelManagerFactories())(
		"%s sends the client user agent to the gateway",
		async (_name, factory) => {
			const seen: { url: string; headers: Headers }[] = [];
			const options = factory({ apiKey: "opencode-test-key", fetch: recordingFetch(seen) });

			expect(options.fetchDynamicModels).toBeDefined();
			await options.fetchDynamicModels?.({});

			const gatewayRequests = seen.filter(request => request.url.includes("opencode.ai"));
			expect(gatewayRequests.length).toBeGreaterThan(0);
			for (const request of gatewayRequests) {
				expect(request.headers.get("User-Agent")).toBe(getOpenCodeUserAgent());
				// The key still travels, so the header is additive rather than a swap.
				expect(request.headers.get("Authorization")).toBe("Bearer opencode-test-key");
			}
		},
	);

	test("the user agent names the product and a version", () => {
		// The gateway matches on a narrow client agent, so an empty or
		// version-less value is the same failure as sending none.
		expect(getOpenCodeUserAgent()).toMatch(/^Veyyon\/\d+\.\d+\.\d+/);
	});
});
