/**
 * WHY THIS SUITE EXISTS:
 *
 * This differential suite closes the defect class where tree-wide structural or formatting refactors
 * (such as import re-sorting, rewrapping, comment path updates) accidentally mutate code tokens,
 * introducing unintended semantic deviations or regressions.
 *
 * It pins that every file classified as `formattingOnly` (or `importReorder`) preserves every single
 * executable ECMAScript / TypeScript / JSX token identical to `origin/main`. If a future edit or refactor
 * mutates a token inside any of these files, this suite fails immediately.
 *
 * NOTE ON SOURCE INSPECTION:
 * Reading file bytes to compare token streams against a recorded baseline is the entire point of differential
 * token equivalence testing and is NOT the banned "source grep" pattern. It parses syntax into tokens via
 * `@babel/parser` and asserts on concrete token stream hashes rather than comments, prose, or regex patterns.
 *
 * WHAT IT DOES NOT CATCH:
 * - Files in the `changed` bucket, which contain genuine semantic token modifications as part of PR #927.
 * - Non-TypeScript assets (Rust code, Markdown docs, JSON configurations, shell scripts).
 * - Semantic changes within third-party runtime dependencies or native addons.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	hashNormalizedImportTokens,
	hashTokenStream,
	REPO_ROOT,
	type TokenEquivalenceLedger,
	type TokenRepresentation,
	tokenize,
} from "./measure-token-equivalence";

const LEDGER_PATH = resolve(REPO_ROOT, "scripts/fixtures/token-equivalence.json");

/**
 * The commit every ledger in this proof set was measured against: the MERGE BASE of this branch and
 * `main`, not the tip of `main`. A tip moves under the measurement, and a ledger measured half
 * against one tree and half against another charges main's own edits to this branch.
 */
const BASELINE_COMMIT = "8a981c275ca931af5eb5f27020b9ecbcabd53d0f";

function loadLedger(): TokenEquivalenceLedger {
	const raw = readFileSync(LEDGER_PATH, "utf-8");
	return JSON.parse(raw) as TokenEquivalenceLedger;
}

describe("token equivalence differential suite", () => {
	const ledger = loadLedger();
	const formattingEntries = Object.entries(ledger.formattingOnly);
	const importReorderEntries = Object.entries(ledger.importReorder);

	it("verifies every formattingOnly file matches its recorded token stream hash (cell a)", () => {
		for (const [relPath, expectedHash] of formattingEntries) {
			const fullPath = resolve(REPO_ROOT, relPath);
			const code = readFileSync(fullPath, "utf-8");
			const { tokens } = tokenize(code);
			const actualHash = hashTokenStream(tokens);
			expect(actualHash).toBe(expectedHash);
		}
	});

	it("verifies every importReorder file matches its recorded normalized hash (cell b)", () => {
		for (const [relPath, expectedHash] of importReorderEntries) {
			const fullPath = resolve(REPO_ROOT, relPath);
			const code = readFileSync(fullPath, "utf-8");
			const { ast, tokens } = tokenize(code);
			const actualHash = hashNormalizedImportTokens(ast, tokens);
			expect(actualHash).toBe(expectedHash);
		}
	});

	it("verifies every recorded ledger path exists on disk in the working tree (cell c)", () => {
		for (const relPath of Object.keys(ledger.formattingOnly)) {
			const fullPath = resolve(REPO_ROOT, relPath);
			expect(existsSync(fullPath)).toBe(true);
		}
		for (const relPath of Object.keys(ledger.importReorder)) {
			const fullPath = resolve(REPO_ROOT, relPath);
			expect(existsSync(fullPath)).toBe(true);
		}
	});

	it("verifies no path appears in multiple buckets (cell d)", () => {
		const formattingKeys = new Set(Object.keys(ledger.formattingOnly));
		const importReorderKeys = new Set(Object.keys(ledger.importReorder));
		const changedKeys = new Set(ledger.changed);

		for (const key of formattingKeys) {
			expect(importReorderKeys.has(key)).toBe(false);
			expect(changedKeys.has(key)).toBe(false);
		}

		for (const key of importReorderKeys) {
			expect(formattingKeys.has(key)).toBe(false);
			expect(changedKeys.has(key)).toBe(false);
		}

		expect(ledger.changedCount).toBe(ledger.changed.length);
	});

	it("states which commit it was measured against, and how many rows it carries (cell e)", () => {
		// A ledger stamped with a ref name cannot say which tree its hashes came from, and a row count
		// asserted as a floor cannot see a new formatting-only file arrive. Both are pinned exactly, so
		// regenerating the ledger against another commit, or reclassifying a file, needs a decision here.
		expect(ledger.generatedFrom).toBe(BASELINE_COMMIT);
		expect(formattingEntries).toHaveLength(67);
		expect(importReorderEntries).toHaveLength(0);
		expect(ledger.changedCount).toBe(4558);
	});

	it("passes anti-vacuity: a token mutation in a verified file changes its hash (cell f)", () => {
		const samplePath = formattingEntries[0]?.[0];
		if (samplePath === undefined) throw new Error("the ledger carries no formatting-only row to control against");
		const fullPath = resolve(REPO_ROOT, samplePath);
		const code = readFileSync(fullPath, "utf-8");
		const { tokens } = tokenize(code);
		const baselineHash = hashTokenStream(tokens);

		// Mutate token value
		const mutatedTokens: TokenRepresentation[] = tokens.map((t, idx) =>
			idx === 0 ? { type: t.type, value: `__MUTATED_${String(t.value)}` } : { type: t.type, value: t.value },
		);
		const mutatedHash = hashTokenStream(mutatedTokens);
		expect(mutatedHash).not.toBe(baselineHash);

		// Mutate token type
		const mutatedTypeTokens: TokenRepresentation[] = tokens.map((t, idx) =>
			idx === 0 ? { type: "__MUTATED_TYPE__", value: t.value } : { type: t.type, value: t.value },
		);
		const mutatedTypeHash = hashTokenStream(mutatedTypeTokens);
		expect(mutatedTypeHash).not.toBe(baselineHash);
	});

	it("passes anti-vacuity: reordering imports keeps the normalized hash, changing one does not (cell g)", () => {
		const fixtureOrder1 = `
			import { b } from "./b";
			import { a } from "./a";
			export const answer = 42;
		`;
		const fixtureOrder2 = `
			import { a } from "./a";
			import { b } from "./b";
			export const answer = 42;
		`;
		const fixtureModified = `
			import { a } from "./a";
			import { c } from "./c";
			export const answer = 42;
		`;

		const res1 = tokenize(fixtureOrder1);
		const res2 = tokenize(fixtureOrder2);
		const resMod = tokenize(fixtureModified);

		const hash1 = hashNormalizedImportTokens(res1.ast, res1.tokens);
		const hash2 = hashNormalizedImportTokens(res2.ast, res2.tokens);
		const hashMod = hashNormalizedImportTokens(resMod.ast, resMod.tokens);

		expect(hash1).toBe(hash2);
		expect(hash1).not.toBe(hashMod);
	});
});
