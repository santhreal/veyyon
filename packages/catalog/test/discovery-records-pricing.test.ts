import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * The guard that stops the "paid model shown as free" bug from coming back
 * through a new provider.
 *
 * `cost` is four numbers and cannot say "we were never told". Every discovery
 * module builds one with `{input: 0, output: 0, ...}` because no upstream
 * `/models` endpoint publishes pricing, and for a long time nothing recorded
 * that distinction, so the model browser read those zeros as free and told users
 * roughly 1,500 paid models cost nothing.
 *
 * The fix was to have each module state what it saw, via `pricing: "unknown"`.
 * That only holds while every module keeps doing it: a seventh provider added
 * next year, built by copying an existing module, is exactly how the field gets
 * quietly dropped and the bug returns for that provider alone. So the rule is
 * checked mechanically rather than left to review.
 */
describe("every discovery module records whether its upstream published pricing", () => {
	const DISCOVERY_DIR = path.join(import.meta.dir, "..", "src", "discovery");

	const moduleFiles = readdirSync(DISCOVERY_DIR).filter(
		f => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".test.ts"),
	);

	it("scans every provider module, so the check cannot pass by finding nothing", () => {
		// A rename or a move of this directory would otherwise turn the assertion
		// below into a green no-op.
		expect(moduleFiles.length).toBeGreaterThanOrEqual(6);
	});

	it("pairs every all-zero cost literal with a pricing marker", () => {
		const unmarked: string[] = [];

		for (const file of moduleFiles) {
			const source = readFileSync(path.join(DISCOVERY_DIR, file), "utf8");
			// An all-zero cost object, written either on one line or across several.
			const zeroCost = /cost:\s*\{[^}]*input:\s*0\s*,[^}]*output:\s*0\s*,[^}]*\}/gs;

			for (const match of source.matchAll(zeroCost)) {
				// The marker belongs to the same object literal as the cost, so it is
				// within a short window after it. 200 characters covers the widest
				// formatting in the tree without reaching the next model entry.
				const after = source.slice(match.index + match[0].length, match.index + match[0].length + 200);
				if (!/pricing:\s*"(unknown|published)"/.test(after)) {
					unmarked.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
				}
			}
		}

		expect(unmarked).toEqual([]);
	});

	it("finds the zero-cost literals it is meant to be checking", () => {
		// The regex above is the load-bearing part. If it stops matching, the
		// previous test passes while checking nothing at all. Every provider module
		// builds exactly such a literal today, so a low count means the matcher
		// broke, not that the tree got better.
		const withZeroCost = moduleFiles.filter(file => {
			const source = readFileSync(path.join(DISCOVERY_DIR, file), "utf8");
			return /cost:\s*\{[^}]*input:\s*0\s*,[^}]*output:\s*0\s*,[^}]*\}/s.test(source);
		});

		expect(withZeroCost.length).toBeGreaterThanOrEqual(6);
	});

	it("marks them unknown rather than published, since none of these endpoints prices anything", () => {
		// `published` on a zero cost means the provider stated the model is free.
		// No discovery upstream states that today, so any `published` here would be
		// a claim the endpoint never made.
		for (const file of moduleFiles) {
			const source = readFileSync(path.join(DISCOVERY_DIR, file), "utf8");
			expect({ file, published: /pricing:\s*"published"/.test(source) }).toEqual({ file, published: false });
		}
	});
});
