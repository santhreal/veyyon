/**
 * parseInternalUrl: native URL vs colon-host fallback.
 *
 * parse.test.ts already pins colon-host `?` then `#`. This file is the
 * operator paste where `#` comes first, undecodeable `%` in the host, and
 * `SKILL://` case folding.
 */
import { describe, expect, it } from "bun:test";
import { parseInternalUrl } from "@veyyon/coding-agent/internal-urls/parse";

describe("hash appearing before the query string", () => {
	it("on the native path, a ? after # is fragment content, not a search param", () => {
		const url = parseInternalUrl("veyyon://host/a#frag?q=1");
		expect(url.hash).toBe("#frag?q=1");
		expect(url.searchParams.get("q")).toBeNull();
	});

	it("on the colon-host fallback, # is sliced first so ? after # is also not a search param", () => {
		const url = parseInternalUrl("skill://plugin:name#frag?q=1");
		expect(url.hash).toBe("#frag?q=1");
		expect(url.searchParams.get("q")).toBeNull();
	});

	it("an empty fragment is preserved as '#' rather than dropped", () => {
		expect(parseInternalUrl("veyyon://host/a#").hash).toBe("#");
		expect(parseInternalUrl("skill://plugin:name#").hash).toBe("#");
	});
});

describe("host percent-decoding must not throw", () => {
	it("leaves a trailing % in the host as rawHost instead of throwing", () => {
		const url = parseInternalUrl("agent://foo%");
		expect(url.rawHost).toBe("foo%");
	});

	it("does not throw on a colon-host fallback URL whose host also has a dangling %", () => {
		const url = parseInternalUrl("skill://plug:name%");
		expect(url.rawHost).toBe("plug:name%");
	});
});

describe("scheme matching is not a second parser", () => {
	it("accepts an uppercase scheme because the regex is case-insensitive", () => {
		expect(parseInternalUrl("SKILL://plugin:name").protocol).toBe("skill:");
	});
});
