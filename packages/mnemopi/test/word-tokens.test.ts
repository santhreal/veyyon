import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { unicodeWordTokens, WORD_TOKEN_DOT_HYPHEN_RE, WORD_TOKEN_HYPHEN_RE, WORD_TOKEN_RE } from "../src/util/regex";

// The unicode word-token character set (`\p{L}\p{N}_` plus optional dot/hyphen)
// had six hand-written inline copies across beam/ and core/ — three charset
// variants, each duplicated. They now build from ONE base fragment in
// util/regex.ts, and every caller splits through `unicodeWordTokens`. These
// tests pin the tokenizer's real output per variant and lock the charset to its
// single owner so a seventh inline copy cannot reappear.

describe("unicodeWordTokens", () => {
	it("keeps only letters, numbers, and underscore by default", () => {
		expect(unicodeWordTokens("foo_bar baz-qux v1.2")).toEqual(["foo_bar", "baz", "qux", "v1", "2"]);
	});

	it("keeps hyphens inside a token with WORD_TOKEN_HYPHEN_RE", () => {
		expect(unicodeWordTokens("foo_bar baz-qux v1.2", WORD_TOKEN_HYPHEN_RE)).toEqual([
			"foo_bar",
			"baz-qux",
			"v1",
			"2",
		]);
	});

	it("keeps dots and hyphens with WORD_TOKEN_DOT_HYPHEN_RE", () => {
		expect(unicodeWordTokens("foo_bar baz-qux v1.2", WORD_TOKEN_DOT_HYPHEN_RE)).toEqual([
			"foo_bar",
			"baz-qux",
			"v1.2",
		]);
	});

	it("matches non-ASCII letters and numbers", () => {
		expect(unicodeWordTokens("café_日本 τest ①")).toEqual(["café_日本", "τest", "①"]);
	});

	it("does not case-fold — casing stays at the call site", () => {
		expect(unicodeWordTokens("ABC Def")).toEqual(["ABC", "Def"]);
	});

	it("returns an empty list for punctuation-only input", () => {
		expect(unicodeWordTokens("...  --- :: ")).toEqual([]);
	});

	it("shares the global instance safely — matchAll spec-clones, so repeated calls agree", () => {
		expect(unicodeWordTokens("a1 b2 c3")).toEqual(["a1", "b2", "c3"]);
		expect(unicodeWordTokens("a1 b2 c3")).toEqual(["a1", "b2", "c3"]);
		expect(WORD_TOKEN_RE.global).toBe(true);
		expect(WORD_TOKEN_RE.unicode).toBe(true);
	});
});

// Source lock: the `\p{L}\p{N}_` word-token class lives only in util/regex.ts.
// A production file that literally carries the class hard-codes a copy of the
// idiom the owner replaces. Convert a file, and it drops out of `seen`; a stale
// grandfathered entry fails the lock, so the list can only shrink.
const WORD_TOKEN_CLASS = "\\p{L}\\p{N}_";
const GRANDFATHERED = new Set<string>([
	// Empty: all six inline copies now import unicodeWordTokens from util/regex.
]);

const SRC_DIR = path.join(import.meta.dir, "../src");

async function walk(dir: string, out: string[]): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
			await walk(full, out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
}

describe("word-token class source lock", () => {
	it("no mnemopi source hard-codes the [\\p{L}\\p{N}_...] class outside util/regex.ts", async () => {
		const files: string[] = [];
		await walk(SRC_DIR, files);
		const offenders: string[] = [];
		const cleared: string[] = [];
		const seen = new Set<string>();
		for (const file of files) {
			const rel = path.relative(SRC_DIR, file).replaceAll(path.sep, "/");
			if (rel === "util/regex.ts") continue;
			const text = await readFile(file, "utf8");
			if (!text.includes(WORD_TOKEN_CLASS)) continue;
			seen.add(rel);
			if (!GRANDFATHERED.has(rel)) offenders.push(rel);
		}
		for (const rel of GRANDFATHERED) {
			if (!seen.has(rel)) cleared.push(rel);
		}
		expect(files.length, "walker must find mnemopi source files").toBeGreaterThan(50);
		expect(
			offenders,
			"inline [\\p{L}\\p{N}_...] class — import unicodeWordTokens/WORD_TOKEN_* from ../util/regex",
		).toEqual([]);
		expect(cleared, "grandfathered entries whose inline copy is gone — remove them from the list").toEqual([]);
	});
});
