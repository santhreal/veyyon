/**
 * Every credential-free engine refuses its own bot wall instead of parsing it
 * to zero results and reporting success.
 *
 * WHY: Startpage began serving an Anubis proof-of-work interstitial at the
 * search URL with HTTP 200 and no redirect. `isChallengeResponse` knew only the
 * older `/sp/captcha` Gatsby shell, so the wall parsed to zero results and
 * returned a successful empty response. Downstream that is indistinguishable
 * from "this engine searched and the web is empty": the Public Web aggregate
 * counted it as an answer, stopped waiting, and the tool reported "Public Web
 * returned no renderable search content" while Mojeek was about to return ten
 * sources.
 *
 * WHAT CLASS THIS CLOSES: a bot wall served at a success status being read as
 * an empty result set, for every engine in the fan-out rather than the one that
 * broke. The membership sweep is read off `PUBLIC_ENGINE_IDS` at run time, so
 * adding an engine fails here until someone records its wall.
 *
 * WHAT IT DOES NOT CATCH: a wall whose body carries none of the markers below
 * (a redesign is invisible until someone looks), and a wall served at a
 * non-2xx status, which the shared HTTP classifier already refuses.
 */
import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@veyyon/ai";
import { getSearchProvider } from "@veyyon/coding-agent/web/search/provider";
import { PUBLIC_ENGINE_IDS } from "@veyyon/coding-agent/web/search/providers/public";
import { SearchProviderError, type SearchProviderId } from "@veyyon/coding-agent/web/search/types";

const fakeAuthStorage = {
	async getApiKey() {
		throw new Error("A credential-free engine must not request API keys");
	},
	resolver() {
		throw new Error("A credential-free engine must not request credential resolvers");
	},
	hasAuth() {
		throw new Error("A credential-free engine must not check auth");
	},
} as unknown as AuthStorage;

/**
 * One real wall per engine, keyed by the marker its provider actually tests
 * for. Each body is a success status: that is the whole point, since a non-2xx
 * wall is already refused by status alone.
 */
const BOT_WALLS: Record<(typeof PUBLIC_ENGINE_IDS)[number], string> = {
	// Anubis interstitial, captured live 2026-08-25.
	startpage: `<!DOCTYPE html><html><head><script id="anubis_version" type="application/json">"v1.26.4"</script><script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"fast"}}</script></head><body>Making sure you are not a bot</body></html>`,
	google: `<html><body>Our systems have detected unusual traffic from your computer network.</body></html>`,
	duckduckgo: `<html><body><div class="anomaly-modal"></div></body></html>`,
	mojeek: `<html><head><title>Captcha</title></head><body><altcha-widget></altcha-widget></body></html>`,
};

function respondWith(html: string): FetchImpl {
	return () => Promise.resolve(new Response(html, { status: 200 }));
}

async function searchAgainst(id: SearchProviderId, html: string): Promise<string> {
	const provider = await getSearchProvider(id);
	try {
		const response = await provider.search({
			query: "a query whose results never arrive",
			authStorage: fakeAuthStorage,
			systemPrompt: "bot wall test prompt",
			fetch: respondWith(html),
		} as never);
		return `returned sources=${response.sources.length}`;
	} catch (error) {
		// Not a bare "something threw": a TypeError from a broken fixture would
		// otherwise read as a refusal and keep this suite green while the wall
		// check did nothing. The refusal must be this provider's own error.
		if (!(error instanceof SearchProviderError)) return `threw ${(error as Error).constructor.name}`;
		if (error.provider !== id) return `refused as "${error.provider}"`;
		return "refused";
	}
}

describe("a bot wall is refused, not reported as an empty web", () => {
	it("covers every engine the Public Web aggregate fans out to", () => {
		// Read off the production list rather than restating it: a sixth engine
		// with no wall fixture is a hole, and this is where it shows up.
		expect(Object.keys(BOT_WALLS).sort()).toEqual([...PUBLIC_ENGINE_IDS].sort());
	});

	for (const id of PUBLIC_ENGINE_IDS) {
		it(`${id} refuses its bot wall instead of returning zero results`, async () => {
			// Asserted as one string so a failure names the engine and what it did.
			expect(`${id}: ${await searchAgainst(id, BOT_WALLS[id])}`).toBe(`${id}: refused`);
		});
	}

	it("still returns results when the same engine answers with a real page", async () => {
		// The wall check must key on the wall, not on "few results": Startpage's
		// own result markup has to survive it, or the fix is just an outage with
		// a better error message.
		const provider = await getSearchProvider("startpage");
		const page = `<html><body><section id="main"><div class="result css-1v6ikp8"><a class="result-title result-link" href="https://example.com/a"><h2>Alpha</h2></a><p class="description">alpha snippet</p></div></section></body></html>`;
		const response = await provider.search({
			query: "a query with results",
			authStorage: fakeAuthStorage,
			systemPrompt: "bot wall test prompt",
			fetch: respondWith(page),
		} as never);
		// Assert a source actually parsed, not merely that the call returned: a
		// parser that silently yields nothing is the same outage this fix exists
		// to prevent, and `provider === "startpage"` holds either way.
		expect(response.sources.map(source => source.url)).toEqual(["https://example.com/a"]);
	});
});
