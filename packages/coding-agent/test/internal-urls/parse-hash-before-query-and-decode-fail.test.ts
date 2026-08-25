/**
 * `parseInternalUrl` has two parsers glued together: native `new URL()` when
 * it accepts the string, and a regex fallback when a colon in the host makes
 * native throw (`skill://plugin:name`).
 *
 * Existing `parse.test.ts` pins the colon-host happy path with `?` then `#`.
 * Native URL and the fallback do not agree on three operator shapes:
 *
 *   1. HASH BEFORE QUERY. `scheme://host#frag?q=1` is legal in a paste. Native
 *      URL treats `?q=1` as part of the fragment. The fallback scans `#` first
 *      then `?` on the remainder, so a colon-host URL and a native URL with
 *      the same suffix can disagree on `searchParams`.
 *   2. UNDECODABLE HOST. `decodeURIComponent` on `%` or `%ZZ` throws; the
 *      comment says leave `rawHost` as-is. A throw leaking out is a router
 *      crash on a completion candidate.
 *   3. EMPTY PATH. Native `new URL("veyyon://host")` yields pathname `""`.
 *      Callers that assume `pathname || "/"` vs `pathname === "/"` fork.
 *
 * Do not clone the colon-in-host examples already in parse.test.ts /
 * marketplace/parse-internal-url.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { parseInternalUrl } from "@veyyon/coding-agent/internal-urls/parse";

describe("hash appearing before the query string", () => {
	it("on the native path, a ? after # is fragment content, not a search param", () => {
		const url = parseInternalUrl("veyyon://host/a#frag?q=1");
		expect(url.hash).toBe("#frag?q=1");
		expect(url.search).toBe("");
		expect(url.searchParams.get("q")).toBeNull();
	});

	it("on the colon-host fallback, # is sliced first so ? after # is also not a search param", () => {
		const url = parseInternalUrl("skill://plugin:name#frag?q=1");
		expect(url.hash).toBe("#frag?q=1");
		expect(url.search).toBe("");
		expect(url.searchParams.get("q")).toBeNull();
	});

	it("query before hash still populates searchParams on both paths", () => {
		const native = parseInternalUrl("veyyon://host/a?q=1#frag");
		expect(native.searchParams.get("q")).toBe("1");
		expect(native.hash).toBe("#frag");

		const fallback = parseInternalUrl("skill://plugin:name?q=1#frag");
		expect(fallback.searchParams.get("q")).toBe("1");
		expect(fallback.hash).toBe("#frag");
	});

	it("an empty fragment is preserved as '#' rather than dropped", () => {
		const native = parseInternalUrl("veyyon://host/a#");
		expect(native.hash).toBe("#");

		const fallback = parseInternalUrl("skill://plugin:name#");
		expect(fallback.hash).toBe("#");
	});

	it("a lone '?' is an empty search, not a missing searchParams object", () => {
		const native = parseInternalUrl("veyyon://host/a?");
		expect(native.search).toBe("?");
		expect([...native.searchParams.entries()]).toEqual([]);

		const fallback = parseInternalUrl("skill://plugin:name?");
		expect(fallback.search).toBe("?");
		expect([...fallback.searchParams.entries()]).toEqual([]);
	});
});

describe("host percent-decoding must not throw", () => {
	it("leaves a trailing % in the host as rawHost instead of throwing", () => {
		expect(() => parseInternalUrl("agent://foo%")).not.toThrow();
		const url = parseInternalUrl("agent://foo%");
		expect(url.rawHost).toBe("foo%");
	});

	it("leaves an illegal %ZZ sequence as rawHost instead of throwing", () => {
		expect(() => parseInternalUrl("agent://foo%ZZ")).not.toThrow();
		const url = parseInternalUrl("agent://foo%ZZ");
		expect(url.rawHost).toBe("foo%ZZ");
	});

	it("still decodes a well-formed %3A in the host", () => {
		const url = parseInternalUrl("agent://foo%3Abar");
		expect(url.rawHost).toBe("foo:bar");
		expect(url.hostname).toBe("foo%3Abar");
	});

	it("leaves a truncated %2 sequence as rawHost", () => {
		expect(() => parseInternalUrl("agent://id%2")).not.toThrow();
		expect(parseInternalUrl("agent://id%2").rawHost).toBe("id%2");
	});

	it("does not throw on a colon-host fallback URL whose host also has a dangling %", () => {
		expect(() => parseInternalUrl("skill://plug:name%")).not.toThrow();
		const url = parseInternalUrl("skill://plug:name%");
		expect(url.rawHost).toBe("plug:name%");
	});
});

describe("empty pathname is the empty string, not '/'", () => {
	it("native host-only URL has pathname ''", () => {
		const url = parseInternalUrl("veyyon://host");
		expect(url.pathname).toBe("");
		expect(url.pathname).not.toBe("/");
	});

	it("colon-host fallback with no path has pathname ''", () => {
		const url = parseInternalUrl("skill://plugin:name");
		expect(url.pathname).toBe("");
		expect(url.rawPathname).toBe("");
	});

	it("a single slash path is '/', distinct from the host-only form", () => {
		const native = parseInternalUrl("veyyon://host/");
		expect(native.pathname).toBe("/");

		const fallback = parseInternalUrl("skill://plugin:name/");
		expect(fallback.pathname).toBe("/");
		expect(fallback.rawPathname).toBe("/");
	});
});

describe("scheme matching is not a second parser", () => {
	it("rejects a missing :// even when the rest looks like a host", () => {
		expect(() => parseInternalUrl("skill:plugin:name")).toThrow(/Invalid URL/);
	});

	it("rejects a leading space (operators paste indented URLs from logs)", () => {
		expect(() => parseInternalUrl(" skill://plugin:name")).toThrow(/Invalid URL/);
	});

	it("accepts an uppercase scheme because the regex is case-insensitive", () => {
		const url = parseInternalUrl("SKILL://plugin:name");
		expect(url.protocol).toBe("skill:");
	});
});
