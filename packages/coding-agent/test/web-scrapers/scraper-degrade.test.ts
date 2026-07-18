import { afterEach, describe, expect, it } from "bun:test";
import { handleSpecialUrls } from "@veyyon/coding-agent/tools/fetch";
import { handleCratesIo } from "@veyyon/coding-agent/web/scrapers/crates-io";
import { handleMastodon } from "@veyyon/coding-agent/web/scrapers/mastodon";
import { isScraperDegrade, scraperDegrade, tryParseUrl } from "@veyyon/coding-agent/web/scrapers/types";

/**
 * A site handler that matches a URL but fails to scrape it must return a loud
 * ScraperDegrade instead of a bare null — null is indistinguishable from a URL
 * non-match, which made every scraper failure a silent fallback to the generic
 * fetch. The dispatcher surfaces the degrade note on the final result.
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

describe("scraperDegrade contract", () => {
	it("formats the note with the site and reason, and round-trips the guard", () => {
		const fromError = scraperDegrade("crates-io", new Error("HTTP 500"));
		expect(fromError.note).toBe("crates-io scraper failed (HTTP 500); fell back to a generic fetch");
		expect(isScraperDegrade(fromError)).toBe(true);

		const fromString = scraperDegrade("mdn", "unexpected response shape");
		expect(fromString.note).toBe("mdn scraper failed (unexpected response shape); fell back to a generic fetch");
	});

	it("rejects non-degrade values in the guard", () => {
		expect(isScraperDegrade(null)).toBe(false);
		expect(isScraperDegrade(undefined)).toBe(false);
		expect(isScraperDegrade({ notes: [] })).toBe(false);
		expect(isScraperDegrade("degraded")).toBe(false);
	});

	it("tryParseUrl returns a URL for valid input and null for garbage", () => {
		expect(tryParseUrl("https://crates.io/crates/serde")?.hostname).toBe("crates.io");
		expect(tryParseUrl("http://[")).toBeNull();
		expect(tryParseUrl("not a url")).toBeNull();
	});
});

describe("handler degrade behavior (crates-io)", () => {
	it("returns null for a non-matching URL without any network call", async () => {
		let called = false;
		patchFetch(() => {
			called = true;
			return new Response("", { status: 200 });
		});
		const result = await handleCratesIo("https://example.com/crates/serde", 5);
		expect(result).toBeNull();
		expect(called).toBe(false);
	});

	it("degrades loudly when the API returns an HTTP error", async () => {
		patchFetch(() => new Response("upstream broke", { status: 500 }));
		const result = await handleCratesIo("https://crates.io/crates/serde", 5);
		expect(isScraperDegrade(result)).toBe(true);
		if (!isScraperDegrade(result)) throw new Error("unreachable");
		expect(result.note).toBe("crates-io scraper failed (HTTP 500); fell back to a generic fetch");
	});

	it("degrades loudly when the API body is not the expected JSON shape", async () => {
		patchFetch(() => new Response("<html>not json</html>", { status: 200 }));
		const result = await handleCratesIo("https://crates.io/crates/serde", 5);
		expect(isScraperDegrade(result)).toBe(true);
		if (!isScraperDegrade(result)) throw new Error("unreachable");
		expect(result.note).toBe("crates-io scraper failed (unexpected response shape); fell back to a generic fetch");
	});
});

describe("probe-style handlers stay quiet on probe failure", () => {
	it("mastodon returns null (not a degrade) when the instance probe fails", async () => {
		// A random host with an @user path is NOT a Mastodon instance; the probe
		// failing means "no match", never a degrade note.
		patchFetch(() => new Response("nope", { status: 404 }));
		const result = await handleMastodon("https://someblog.example/@author", 5);
		expect(result).toBeNull();
	});
});

describe("dispatcher surfaces degrades on the notes channel", () => {
	it("pushes the degrade note and returns null so the generic fetch still runs", async () => {
		patchFetch(() => new Response("upstream broke", { status: 500 }));
		const notes: string[] = [];
		const result = await handleSpecialUrls("https://crates.io/crates/serde", 5, undefined, null, notes);
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
		const result = await handleSpecialUrls("https://crates.io/crates/serde", 5, undefined, null, notes);
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
		const result = await handleSpecialUrls("https://example.com/x", 5, undefined, null, notes, [thrower, next]);
		expect(result).toBeNull();
		expect(notes).toEqual(["handleThrower scraper threw (handler blew up); fell back to a generic fetch"]);
		expect(nextRan).toBe(true);
	});
});
