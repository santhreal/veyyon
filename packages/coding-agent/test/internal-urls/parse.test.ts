import { describe, expect, it } from "bun:test";
import { parseInternalUrl } from "@veyyon/coding-agent/internal-urls/parse";

/**
 * parseInternalUrl is the single entry point every internal-URL consumer (router,
 * protocol handlers, tools) must use instead of `new URL()`, because internal URLs
 * put a colon inside the host segment (`skill://plugin:name`) which native `new URL()`
 * rejects as a bad port. It had no direct test of its own contract. These tests pin
 * both paths: the native-parse path for ordinary URLs, and the regex fallback that
 * makes the colon-in-host case work, including query/hash extraction and host decoding.
 */

describe("parseInternalUrl native-parse path", () => {
	it("parses a standard internal URL into its components", () => {
		const url = parseInternalUrl("veyyon://host/a/b?q=1#f");
		expect(url.protocol).toBe("veyyon:");
		expect(url.hostname).toBe("host");
		expect(url.rawHost).toBe("host");
		expect(url.pathname).toBe("/a/b");
		expect(url.rawPathname).toBe("/a/b");
		expect(url.search).toBe("?q=1");
		expect(url.hash).toBe("#f");
		expect(url.searchParams.get("q")).toBe("1");
	});

	it("decodes a percent-encoded host into rawHost while leaving hostname raw", () => {
		const url = parseInternalUrl("agent://foo%3Abar");
		expect(url.hostname).toBe("foo%3Abar");
		expect(url.rawHost).toBe("foo:bar");
		expect(url.pathname).toBe("");
	});
});

describe("parseInternalUrl colon-in-host fallback", () => {
	it("keeps a colon in the host that native new URL() would reject", () => {
		const url = parseInternalUrl("skill://plugin:name");
		expect(url.protocol).toBe("skill:");
		expect(url.hostname).toBe("plugin:name");
		expect(url.host).toBe("plugin:name");
		expect(url.rawHost).toBe("plugin:name");
		expect(url.pathname).toBe("");
		expect(url.rawPathname).toBe("");
		expect(url.search).toBe("");
		expect(url.hash).toBe("");
	});

	it("extracts path, query, and hash around a colon host in the fallback path", () => {
		const url = parseInternalUrl("skill://plugin:name/sub?x=1#h");
		expect(url.hostname).toBe("plugin:name");
		expect(url.rawHost).toBe("plugin:name");
		expect(url.pathname).toBe("/sub");
		expect(url.rawPathname).toBe("/sub");
		expect(url.search).toBe("?x=1");
		expect(url.hash).toBe("#h");
		expect(url.searchParams.get("x")).toBe("1");
	});

	it("preserves the raw href for the fallback object", () => {
		expect(parseInternalUrl("skill://plugin:name/sub").href).toBe("skill://plugin:name/sub");
	});
});

describe("parseInternalUrl invalid input", () => {
	it("throws when the input has no scheme://host at all", () => {
		expect(() => parseInternalUrl("not a url")).toThrow("Invalid URL: not a url");
	});
});
