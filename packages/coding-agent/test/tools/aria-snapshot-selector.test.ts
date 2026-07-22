import { describe, expect, it } from "bun:test";
import { buildAriaSnapshotScript, parseAriaRefSelector } from "@veyyon/coding-agent/tools/browser/aria/aria-snapshot";

/**
 * parseAriaRefSelector decides whether an action selector (`tab.click(...)`) is an
 * explicit ARIA ref versus an ordinary CSS selector; misrouting it would click the
 * wrong thing or nothing. buildAriaSnapshotScript embeds the selector and options
 * into the in-page snapshot script for the cmux backend. Neither had a test. These
 * pin the accepted ref forms, the deliberate rejection of a bare `eN`, and the
 * script's embedded selector/options.
 */

describe("parseAriaRefSelector", () => {
	it("accepts the three explicit ref prefixes", () => {
		expect(parseAriaRefSelector("aria-ref=e5")).toBe("e5");
		expect(parseAriaRefSelector("aria-ref/e7")).toBe("e7");
		expect(parseAriaRefSelector("ariaref/e10")).toBe("e10");
	});

	it("trims outer and inner whitespace around the id", () => {
		expect(parseAriaRefSelector("  aria-ref=e5  ")).toBe("e5");
		expect(parseAriaRefSelector("aria-ref= e5")).toBe("e5");
	});

	it("rejects a bare eN with no prefix (intentional, backend id collision)", () => {
		expect(parseAriaRefSelector("e5")).toBeNull();
	});

	it("rejects a malformed or non-ref id", () => {
		expect(parseAriaRefSelector("aria-ref=e5x")).toBeNull();
		expect(parseAriaRefSelector("aria-ref=E5")).toBeNull();
		expect(parseAriaRefSelector("aria-ref=")).toBeNull();
		expect(parseAriaRefSelector("#main .btn")).toBeNull();
	});

	it("accepts e0 as a well-formed ref", () => {
		expect(parseAriaRefSelector("aria-ref=e0")).toBe("e0");
	});
});

describe("buildAriaSnapshotScript", () => {
	it("embeds a CSS selector and queries it in-page", () => {
		const script = buildAriaSnapshotScript("#main");
		expect(script).toContain('var __sel="#main"');
		expect(script).toContain("document.querySelector(__sel)");
	});

	it("uses a null root when no selector is given", () => {
		expect(buildAriaSnapshotScript(undefined)).toContain("var __sel=null");
	});

	it("embeds the depth and boxes options as the request object", () => {
		expect(buildAriaSnapshotScript("#x", { depth: 2, boxes: true })).toContain('{"depth":2,"boxes":true}');
	});
});
