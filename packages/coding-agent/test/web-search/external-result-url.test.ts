/**
 * One rule for turning a scraped result anchor into a target URL.
 *
 * WHY THIS SUITE EXISTS. Ecosia, Mojeek and Startpage each carried their own copy of the same
 * resolve-and-filter helper, and the three had already drifted in the part that matters: one rejected the
 * engine's host and its `www.` spelling, one rejected the host and every subdomain, one did both for a
 * single domain. A copy is not just duplication here, it is a silent behaviour difference -- Ecosia's
 * copy would have accepted `images.ecosia.org` as an outbound result, so an internal navigation row could
 * be handed back as a search result and then fetched.
 *
 * There is one owner now, `resolveExternalResultUrl`, and subdomain matching is the rule everywhere. This
 * suite pins that rule against the exact cases the three copies disagreed on, so a fourth provider
 * cannot quietly reintroduce a laxer version.
 *
 * `undefined` here never means a failure was swallowed, which is the second thing this suite pins: a
 * results page mixes navigation, verticals and paging rows into the same markup, so most anchors offered
 * to this function are legitimately not results, and an href that will not parse is one of those.
 * Rejecting is also the safe direction, because whatever survives is fetched.
 */

import { describe, expect, it } from "bun:test";
import {
	isExternalHttpUrl,
	parseResultUrl,
	resolveExternalResultUrl,
} from "@veyyon/coding-agent/web/search/providers/utils";

const HOME = "https://www.example-engine.com/search?q=x";
const OWN = ["example-engine.com"] as const;

describe("an anchor pointing at another site", () => {
	/** The ordinary case: an absolute https link comes back normalized, with no host rule tripping. */
	it("returns the absolute URL", () => {
		expect(resolveExternalResultUrl("https://docs.rust-lang.org/book/", HOME, OWN)).toBe(
			"https://docs.rust-lang.org/book/",
		);
	});

	/** Protocol-relative hrefs are common in scraped markup and must resolve against the base's scheme. */
	it("resolves a protocol-relative href against the base", () => {
		expect(resolveExternalResultUrl("//docs.rust-lang.org/book/", HOME, OWN)).toBe("https://docs.rust-lang.org/book/");
	});

	/** Plain http is a real result, not something to filter: the rule is http(s), not https-only. */
	it("accepts http as well as https", () => {
		expect(resolveExternalResultUrl("http://example.org/page", HOME, OWN)).toBe("http://example.org/page");
	});

	/** The query and fragment are part of the target and must survive, since the URL is fetched as given. */
	it("keeps the query string and fragment", () => {
		expect(resolveExternalResultUrl("https://example.org/a?b=c#d", HOME, OWN)).toBe("https://example.org/a?b=c#d");
	});
});

describe("an anchor pointing back at the engine", () => {
	/** The bare host: an internal link, never a result. */
	it("rejects the engine's own host", () => {
		expect(resolveExternalResultUrl("https://example-engine.com/settings", HOME, OWN)).toBeUndefined();
	});

	/**
	 * The `www.` spelling, which one of the three copies handled by naming it explicitly. Subdomain
	 * matching covers it without a second host entry, which is why the unified rule needs no per-engine
	 * spelling list.
	 */
	it("rejects the www. spelling", () => {
		expect(resolveExternalResultUrl("https://www.example-engine.com/settings", HOME, OWN)).toBeUndefined();
	});

	/**
	 * The case the copies actually disagreed on. A vertical such as `images.<engine>` is internal
	 * navigation, and the copy that only compared the bare host and `www.` would have returned it as an
	 * outbound result.
	 */
	it("rejects any subdomain, which is where the copies disagreed", () => {
		expect(resolveExternalResultUrl("https://images.example-engine.com/x", HOME, OWN)).toBeUndefined();
		expect(resolveExternalResultUrl("https://deep.nested.example-engine.com/x", HOME, OWN)).toBeUndefined();
	});

	/** A relative href resolves onto the engine's own host, so paging and vertical rows are filtered too. */
	it("rejects a relative href, which resolves onto the engine", () => {
		expect(resolveExternalResultUrl("/search?q=x&page=2", HOME, OWN)).toBeUndefined();
	});

	/**
	 * A host that merely ENDS WITH the engine's name is a different site and must be accepted, or an
	 * attacker-registered `notexample-engine.com` would be silently dropped while a real result is lost.
	 * This is the boundary the `.` in the subdomain check exists for.
	 */
	it("accepts a different host that merely ends with the engine's name", () => {
		expect(resolveExternalResultUrl("https://notexample-engine.com/x", HOME, OWN)).toBe(
			"https://notexample-engine.com/x",
		);
	});

	/** Several own-hosts are supported, because Mojeek serves the same engine from four domains. */
	it("rejects every host in a multi-domain own-host list", () => {
		const hosts = ["mojeek.com", "mojeek.co.uk", "mojeek.fr", "mojeek.de"];
		for (const host of hosts) {
			expect(resolveExternalResultUrl(`https://${host}/x`, "https://www.mojeek.com/", hosts)).toBeUndefined();
			expect(resolveExternalResultUrl(`https://www.${host}/x`, "https://www.mojeek.com/", hosts)).toBeUndefined();
		}
		expect(resolveExternalResultUrl("https://mojeek.example.org/x", "https://www.mojeek.com/", hosts)).toBe(
			"https://mojeek.example.org/x",
		);
	});
});

describe("an anchor that is not a web link at all", () => {
	/**
	 * These are the rejections that used to be spelled out three times, and each one matters on its own:
	 * `javascript:` and `data:` are what a scraped page's controls carry, and handing either to a fetch is
	 * how a scraper starts executing the page's intentions instead of reading it.
	 */
	it.each([
		["javascript:void(0)", "a control, not a link"],
		["data:text/html,<b>x</b>", "an inline document"],
		["mailto:someone@example.org", "a mail link"],
		["ftp://example.org/file", "a non-web scheme"],
		["about:blank", "a browser page"],
	])("rejects %p (%s)", (href, _why) => {
		expect(resolveExternalResultUrl(href, HOME, OWN)).toBeUndefined();
	});

	/** An empty or missing href is a row with no link, which is not a failure and not a result. */
	it("rejects an absent or empty href", () => {
		expect(resolveExternalResultUrl("", HOME, OWN)).toBeUndefined();
		expect(resolveExternalResultUrl(null, HOME, OWN)).toBeUndefined();
		expect(resolveExternalResultUrl(undefined, HOME, OWN)).toBeUndefined();
	});
});

describe("parseResultUrl on its own", () => {
	/**
	 * Exported separately for Google, which routes clicks through `/url?q=<target>` and therefore has to
	 * look at the wrapper before the host rule can decide anything. Without this split its unwrapping
	 * would either need its own copy of the parse or would reject every result as a link back to Google.
	 */
	it("parses relative and absolute hrefs against the base", () => {
		expect(parseResultUrl("/url?q=https%3A%2F%2Fexample.org%2F", HOME)?.pathname).toBe("/url");
		expect(parseResultUrl("https://example.org/", HOME)?.hostname).toBe("example.org");
	});

	/** A string that is not a URL is answered with undefined rather than a throw reaching the scraper. */
	it("answers undefined for text that is not a URL", () => {
		expect(parseResultUrl("not a url", "not a base either")).toBeUndefined();
		expect(parseResultUrl("http://", HOME)).toBeUndefined();
	});
});

describe("isExternalHttpUrl on its own", () => {
	/** The host and protocol rule, without the parse, which is the half Google reuses after unwrapping. */
	it("separates the protocol rule from the host rule", () => {
		expect(isExternalHttpUrl(new URL("https://example.org/"), OWN)).toBe(true);
		expect(isExternalHttpUrl(new URL("ftp://example.org/"), OWN)).toBe(false);
		expect(isExternalHttpUrl(new URL("https://example-engine.com/"), OWN)).toBe(false);
	});

	/** An empty own-host list means "filter nothing", which is what a provider with no self-links needs. */
	it("accepts any http(s) host when the own-host list is empty", () => {
		expect(isExternalHttpUrl(new URL("https://anything.example/"), [])).toBe(true);
	});
});
