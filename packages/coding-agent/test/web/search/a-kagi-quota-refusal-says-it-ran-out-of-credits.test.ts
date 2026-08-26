/**
 * WHY: every search provider classifies an upstream refusal through `classifyProviderHttpError`,
 * which reads the response body so a quota or credit message is reported as "credits exhausted"
 * rather than as a generic failure. Kagi threw that body away twice — the error carried only a
 * status code, and the provider handed the classifier an empty string — so a Kagi account out of
 * credits reported "Kagi search request failed." on any status other than 401/402/403, and the
 * operator had no way to tell an exhausted account from a broken one.
 *
 * The class is "a provider drops the evidence the shared classifier needs". The classifier itself
 * is fine; the body never reached it.
 *
 * The contract these tests defend:
 *   - a credit message in the body is classified as exhausted whatever the status code;
 *   - the status-only classifications still hold when the body says nothing;
 *   - a genuinely unrelated failure is still reported as a plain failure, so the fix did not turn
 *     the classifier into a catch-all.
 *
 * What it does not catch: a quota message Kagi words in a way `CREDIT_BODY_PATTERN` does not match,
 * and bodies larger than the cap the error keeps.
 */

import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@veyyon/ai";
import { searchKagi } from "@veyyon/coding-agent/web/search/providers/kagi";

/** A store that answers with a key, so the request reaches the fetch below rather than failing earlier. */
const AUTH_STORAGE = {
	hasAuth: () => true,
	hasOAuth: () => false,
	getCredentialOrigin: () => undefined,
	getOAuthAccountId: () => undefined,
	async getOAuthAccess() {
		return undefined;
	},
	async getApiKey() {
		return "kagi-test-key";
	},
	resolver: () => async () => "kagi-test-key",
	listAuthCredentials: () => [],
} as unknown as AuthStorage;

function respondWith(status: number, body: string): FetchImpl {
	return (async () => new Response(body, { status })) as unknown as FetchImpl;
}

function search(status: number, body: string): Promise<unknown> {
	return searchKagi({ query: "anything", authStorage: AUTH_STORAGE, fetch: respondWith(status, body) });
}

describe("a Kagi refusal", () => {
	it("is reported as exhausted credits when the body says so, whatever the status", async () => {
		const statuses = [400, 429, 500, 503];
		const unclassified: number[] = [];

		for (const status of statuses) {
			const failure = await search(status, '{"error":"Your account has insufficient credits"}').catch(
				(error: unknown) => error,
			);
			if (!(failure instanceof Error) || !/credits exhausted/.test(failure.message)) {
				unclassified.push(status);
			}
		}

		expect(unclassified).toEqual([]);
	});

	it("still classifies by status when the body explains nothing", async () => {
		const unauthorized = await search(401, "nope").catch((error: unknown) => error);
		const forbidden = await search(403, "nope").catch((error: unknown) => error);
		const payment = await search(402, "nope").catch((error: unknown) => error);

		expect(unauthorized).toBeInstanceOf(Error);
		expect((unauthorized as Error).message).toContain("401 unauthorized");
		expect((forbidden as Error).message).toContain("403 forbidden");
		expect((payment as Error).message).toContain("credits exhausted");
	});

	it("still reports an unrelated failure as a plain failure", async () => {
		const failure = await search(500, '{"error":"internal server error"}').catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("Kagi search request failed");
		expect((failure as Error).message).not.toContain("credits exhausted");
	});
});
