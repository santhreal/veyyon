import { afterEach, describe, expect, it } from "bun:test";
import { handleSpecialUrls } from "@veyyon/coding-agent/tools/web/fetch";

/**
 * WHY: a site handler that matched a URL and could not scrape it returns a ScraperDegrade rather
 * than null, and the dispatcher is what turns that value into something an operator sees. The
 * degrade contract itself is proved in `@veyyon/web` (test/scrapers/scraper-degrade.test.ts); this
 * suite covers the half that lives here — the note channel, the transport-failure label and a
 * handler that throws instead of degrading, which must not fail the whole fetch.
 *
 * It does not cover which handler claims which URL, nor the generic fetch that runs afterwards.
 */

const realFetch = globalThis.fetch;

function patchFetch(fn: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>): void {
	globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => fn(input, init), {
		preconnect: realFetch.preconnect,
	}) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("dispatcher surfaces degrades on the notes channel", () => {
	it("pushes the degrade note and returns null so the generic fetch still runs", async () => {
		patchFetch(() => new Response("upstream broke", { status: 500 }));
		const notes: string[] = [];
		const result = await handleSpecialUrls("https://crates.io/crates/serde", 5, undefined, undefined, notes);
		expect(result).toBeNull();
		expect(notes).toEqual(["crates-io scraper failed (HTTP 500); fell back to a generic fetch"]);
	});

	it("labels transport failures without an HTTP prefix", async () => {
		patchFetch(() => {
			throw new Error("socket exploded");
		});
		const notes: string[] = [];
		// loadPage catches transport errors and reports them via `error`, so the
		// degrade note must carry the raw cause, not a bogus "HTTP" label.
		const result = await handleSpecialUrls("https://crates.io/crates/serde", 5, undefined, undefined, notes);
		expect(result).toBeNull();
		expect(notes).toEqual(["crates-io scraper failed (socket exploded); fell back to a generic fetch"]);
	});

	it("converts a handler throw into a loud note instead of failing the fetch", async () => {
		const thrower = async (): Promise<null> => {
			throw new Error("handler blew up");
		};
		Object.defineProperty(thrower, "name", { value: "handleThrower" });
		let nextRan = false;
		const next = async (): Promise<null> => {
			nextRan = true;
			return null;
		};
		const notes: string[] = [];
		const result = await handleSpecialUrls("https://example.com/x", 5, undefined, undefined, notes, [thrower, next]);
		expect(result).toBeNull();
		expect(notes).toEqual(["handleThrower scraper threw (handler blew up); fell back to a generic fetch"]);
		expect(nextRan).toBe(true);
	});
});
