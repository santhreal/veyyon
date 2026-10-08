/**
 * An ArkType `string.*` keyword is built when it is first read.
 *
 * WHY THIS SUITE EXISTS. arktype 2.2.3 built every keyword path under `string` (`string.email`,
 * `string.date.iso.parse`, `string.normalize.NFKD.preformatted` and 50 more) when `arktype`
 * evaluated: 171 registered nodes, their regexes and predicates, and in a compiling process their
 * validators. A launch names none of them. `patches/arktype@2.2.3.patch` builds each keyword under
 * `string` on first read, and `defineLazyMember` in `patches/@ark%2Fschema@0.56.2.patch` keeps it
 * unbuilt when the `ark` scope binds the module, then binds it, and finalizes it in a resolved scope,
 * when it is read.
 *
 * The class it closes: a `string.*` keyword built before anything names it, a keyword built again on
 * a later read, and a keyword whose lazy build resolves differently from the eager one. Every path is
 * enumerated from the module at run time. Once `arktype` evaluates, no node any keyword references
 * exists except the `string` domain every keyword intersects. A second read of a keyword returns the
 * value of its first. Every path, read through the exported module, a `type` definition, a user scope
 * and the `string` module `arktype/internal/keywords/string.js` exports, returns for a fixed corpus
 * what arktype 2.2.3 without the patch returned, and the `string` module binds it to the scope that
 * package bound it to, in a jitless process and in a compiling one, where every path's node holds a
 * compiled traversal. The reference is `fixtures/arktype-string-keywords.upstream.json`, written by
 * running `fixtures/arktype-string-keywords.ts` against the unpatched package; a path the reference
 * lacks fails until it is recorded there. Configured keyword metadata reaches a top-level keyword, a
 * top-level module's root, a nested module's root and a nested keyword.
 *
 * WHAT IT DOES NOT CATCH: an input outside the corpus that the lazy build treats differently, and the
 * cost of reading one keyword alone, since keywords sharing a node (`integer` and `date`) build it on
 * whichever is read first.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { CONFIGURED_KEYWORDS } from "./fixtures/arktype-configured-keywords";
import type { KeywordPath, StringKeywordReport } from "./fixtures/arktype-string-keywords";
import upstream from "./fixtures/arktype-string-keywords.upstream.json" with { type: "json" };

const FIXTURE = path.join(import.meta.dirname, "fixtures", "arktype-string-keywords.ts");

const UPSTREAM_PATHS: Record<string, KeywordPath> = upstream.paths;
const UPSTREAM_CONFIGURED: Record<string, KeywordPath> = upstream.configured;

const reports = new Map<string, StringKeywordReport>();

/** The fixture's report for `args`, spawned once per argument list. */
function keywordReport(...args: string[]): StringKeywordReport {
	const key = args.join(" ");
	const cached = reports.get(key);
	if (cached) return cached;
	const run = spawnSync(process.execPath, [FIXTURE, ...args], {
		encoding: "utf8",
		env: { ...process.env, TZ: "UTC" },
	});
	if (run.status !== 0) throw new Error(`string keyword fixture exited ${run.status}: ${run.stderr}`);
	const report = JSON.parse(run.stdout) as StringKeywordReport;
	reports.set(key, report);
	return report;
}

const MODES = [
	{ name: "a jitless process", args: ["--jitless"], compiles: false },
	{ name: "a process that compiles validators", args: [], compiles: true },
] as const;

describe("an ArkType string keyword is built on first read", () => {
	for (const mode of MODES) {
		describe(`in ${mode.name}`, () => {
			it("has built no node a keyword references once arktype evaluates", () => {
				expect(keywordReport(...mode.args).builtAtImport).toEqual(["string"]);
			});

			it("builds a keyword on its first read and returns that keyword on every later read", () => {
				const report = keywordReport(...mode.args);
				// `date` builds the integer string node `integer` resolves to, so reading `integer`
				// after it builds nothing.
				expect(report.aliases.filter(alias => report.firstReadNodes[alias] === 0)).toEqual(["integer"]);
				expect(report.rereadDiffers).toEqual([]);
			});

			it("resolves every keyword path as arktype 2.2.3 does, through every route", () => {
				const report = keywordReport(...mode.args);
				expect(report.routesDisagree).toEqual([]);
				expect(report.paths).toEqual(UPSTREAM_PATHS);
			});

			it(mode.compiles ? "compiles every keyword path" : "compiles no keyword path", () => {
				const report = keywordReport(...mode.args);
				expect(report.uncompiled).toEqual(mode.compiles ? [] : Object.keys(report.paths));
			});
		});
	}

	it("applies configured keyword metadata to a keyword at every depth", () => {
		const report = keywordReport("--jitless", "--configured");
		const configured = Object.fromEntries(
			Object.keys(CONFIGURED_KEYWORDS).map(keyword => {
				const keywordPath = keyword.slice("string.".length);
				return [keywordPath, report.paths[keywordPath]];
			}),
		);
		expect(Object.values(configured).map(entry => entry?.description)).toEqual(Object.values(CONFIGURED_KEYWORDS));
		expect(configured).toEqual(UPSTREAM_CONFIGURED);
		expect(report.routesDisagree).toEqual([]);
	});
});
