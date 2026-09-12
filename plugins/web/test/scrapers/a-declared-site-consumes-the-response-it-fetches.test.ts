/**
 * WHY: consolidating 65 hand-written scrapers into declaration tables let a site
 * declaration keep its shape while losing its fetch. The vscode-marketplace
 * declaration serialized a POST body, called the page loader without it, never read
 * the response, and returned a successful RenderResult assembled from the URL alone.
 * Every sweep passed, because the existing ones check registry shape, canonical-URL
 * matching and foreign-URL rejection — never whether the response reaches the output.
 *
 * The invariant closed here: a site handler's success is CONDITIONAL on its fetch.
 * With every page load failing, no declaration may report success, and each must have
 * asked the loader for something. A declaration that fabricates output from the URL
 * fails both halves, whichever site it belongs to.
 *
 * Members are enumerated from SITE_DECLARATION_ENTRIES at run time, so a site added
 * later is covered on arrival, and one that fabricates turns this red instead of
 * joining the table in silence.
 *
 * What this does NOT catch: a declaration that reads the response and maps the wrong
 * field, or renders fewer fields than the scraper it replaced. That is field-level
 * fidelity, which the mapping assertions in declarative-site-sweep own.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { SITE_DECLARATION_ENTRIES } from "@veyyon/web/scrapers";
import * as scraperTypes from "../../src/scrapers/types";

const FAILED_LOAD: scraperTypes.LoadPageResult = {
	content: "",
	contentType: "text/plain",
	finalUrl: "https://stub.invalid/",
	ok: false,
	status: 503,
	error: "stubbed transport failure",
};

/**
 * Sites that reach no loader when every load fails. Pinned by exact equality: a new
 * entry here is a declaration that can answer without the network, which needs a
 * reason, not a bigger number.
 */
const NO_LOADER_CALL_EXPECTED: string[] = [];

function isDegrade(value: unknown): boolean {
	return typeof value === "object" && value !== null && "scraperDegrade" in value;
}

describe("a declared site consumes the response it fetches", () => {
	it("no site reports success when every page load fails", async () => {
		const loadPage = spyOn(scraperTypes, "loadPage").mockImplementation(async () => FAILED_LOAD);
		const fabricated: string[] = [];
		const withoutLoaderCall: string[] = [];

		try {
			for (const entry of SITE_DECLARATION_ENTRIES) {
				const handler = entry.createHandler();
				for (const url of entry.declaration.canonicalUrls) {
					loadPage.mockClear();
					const result = await handler(url, 5);
					const callsMade = loadPage.mock.calls.length;

					if (result !== null && !isDegrade(result)) {
						fabricated.push(`${entry.site} <- ${url}`);
						continue;
					}
					if (callsMade === 0 && !withoutLoaderCall.includes(entry.site)) {
						withoutLoaderCall.push(entry.site);
					}
				}
			}
		} finally {
			loadPage.mockRestore();
		}

		// A successful RenderResult here was assembled without a usable response.
		expect(fabricated).toEqual([]);
		expect(withoutLoaderCall.sort()).toEqual([...NO_LOADER_CALL_EXPECTED].sort());
	});

	it("the registry it sweeps is populated, so an empty table cannot pass", () => {
		expect(SITE_DECLARATION_ENTRIES.length).toBeGreaterThanOrEqual(60);
	});
});
