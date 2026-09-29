import { describe, expect, it } from "bun:test";
import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { collectPackageSources } from "./support/package-sources";

describe("collapseWhitespace", () => {
	it("collapses runs of mixed whitespace to single spaces and trims the ends", () => {
		expect(collapseWhitespace("  hello   world  ")).toBe("hello world");
		expect(collapseWhitespace("a\t\tb\n\nc")).toBe("a b c");
		expect(collapseWhitespace("line one\r\n  line two")).toBe("line one line two");
	});

	it("returns an empty string for null, undefined, empty, and all-whitespace input", () => {
		expect(collapseWhitespace(null)).toBe("");
		expect(collapseWhitespace(undefined)).toBe("");
		expect(collapseWhitespace("")).toBe("");
		expect(collapseWhitespace("   \t\n  ")).toBe("");
	});

	it("leaves already-normalized text unchanged", () => {
		expect(collapseWhitespace("clean single spaced text")).toBe("clean single spaced text");
	});

	it("is exported from the package barrel as well as the subpath", async () => {
		const barrel = await import("@veyyon/utils");
		expect(barrel.collapseWhitespace).toBe(collapseWhitespace);
	});
});

/**
 * ONE-PLACE source lock (H1-8d): the collapse idiom
 * `replace(/\s+/g, " ").trim()` has exactly one production owner,
 * collapse-whitespace.ts. Inline copies drifted across five modes/ files
 * before the extraction; this scan fails if any production source outside the
 * owner re-inlines it, so the copy-drift class of bug cannot return.
 */
describe("collapse-whitespace source lock", () => {
	const IDIOM = 'replace(/\\s+/g, " ").trim()';
	/**
	 * Sources whose copy of the idiom runs in a browser page, where no module can be imported:
	 * `probePress` in the browser tool's tab worker is serialized into the page it probes, and so is the
	 * `:has-text()` query handler puppeteer injects. Permanent, since the reason is where the code runs;
	 * a key that stops naming a file with the idiom fails below, because a key that matches nothing
	 * exempts nothing.
	 */
	const RUNS_IN_THE_PAGE = new Set([
		"coding-agent/src/tools/web/browser/tab-worker.ts",
		"coding-agent/src/tools/web/browser/has-text.ts",
	]);

	// The monorepo walk + skip-set is shared with every other source-ownership
	// lock (see ./support/package-sources).
	it("no production source re-inlines the collapse idiom outside the owner", async () => {
		const offenders: string[] = [];
		const exemptSeen = new Set<string>();
		for (const { rel, text } of await collectPackageSources({ dirs: ["src"] })) {
			if (rel === "utils/src/collapse-whitespace.ts") continue;
			if (!text.includes(IDIOM)) continue;
			if (RUNS_IN_THE_PAGE.has(rel)) exemptSeen.add(rel);
			else offenders.push(rel);
		}
		expect(offenders, "inline collapse idiom — import collapseWhitespace from @veyyon/utils").toEqual([]);
		expect(
			[...RUNS_IN_THE_PAGE].filter(rel => !exemptSeen.has(rel)),
			"RUNS_IN_THE_PAGE entries that no longer name a file with the idiom — repoint or drop the key",
		).toEqual([]);
	});
});
