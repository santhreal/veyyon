/**
 * WHY: Kimi web search posted every Kimi Code token to api.kimi.com, and a token issued by the kimi.ai
 * deployment is rejected there, so search failed for every account outside mainland China.
 *
 * Class closed: for every deployment in `KIMI_CODE_REGIONS`, a stored `kimi-code` OAuth credential's
 * search goes to that deployment's `/search` and carries the bare token, never the key envelope that
 * names the deployment. The deployments are read from the table at run time, so a new one is covered
 * without an edit here.
 *
 * NOT CAUGHT: the `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` overrides, which replace the URL
 * for every deployment, and whether either deployment accepts the request.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import * as aiStream from "@veyyon/ai/stream";
import { KIMI_CODE_REGIONS, type KimiCodeRegion, kimiCodeApiEndpointOf } from "@veyyon/catalog/wire/kimi-code";
import { searchKimi } from "../../../../src/tools/web/search/providers/kimi";

interface Sent {
	url: string;
	authorization: string | null;
}

function searchServer(sent: Sent[]): typeof fetch {
	const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		sent.push({ url: request.url, authorization: request.headers.get("authorization") });
		return Response.json({ search_results: [] });
	};
	return Object.assign(handler, { preconnect: fetch.preconnect }) as typeof fetch;
}

describe("a Kimi search goes to the deployment that issued the token", () => {
	let authStorage: AuthStorage;

	beforeEach(() => {
		// An ambient MOONSHOT_API_KEY or KIMI_API_KEY must not stand in for the stored credential.
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
	});

	for (const region of Object.keys(KIMI_CODE_REGIONS) as KimiCodeRegion[]) {
		it(`posts a ${region} token to the ${region} search endpoint`, async () => {
			await authStorage.set("kimi-code", [
				{
					type: "oauth",
					access: `token-${region}`,
					refresh: `refresh-${region}`,
					expires: Date.now() + 60 * 60 * 1000,
					apiEndpoint: kimiCodeApiEndpointOf(region),
				},
			]);
			const sent: Sent[] = [];

			await searchKimi({ query: "query", authStorage, sessionId: "s", fetch: searchServer(sent) });

			expect(sent).toEqual([
				{ url: `${KIMI_CODE_REGIONS[region].baseUrl}/search`, authorization: `Bearer token-${region}` },
			]);
		});
	}
});
