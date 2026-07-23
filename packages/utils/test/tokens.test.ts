import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { estimateTokensFromText } from "../src/tokens";

describe("estimateTokensFromText", () => {
	it("returns 0 for empty input", () => {
		expect(estimateTokensFromText("")).toBe(0);
	});

	it("estimates ASCII at ceil(chars / 4)", () => {
		expect(estimateTokensFromText("abcd")).toBe(1);
		expect(estimateTokensFromText("abcde")).toBe(2);
		expect(estimateTokensFromText("a".repeat(400))).toBe(100);
	});

	it("counts CJK by UTF-8 bytes — the char-based copies under-counted it ~3x", () => {
		// 8 CJK chars = 24 UTF-8 bytes -> 6 tokens; floor(8/4) would say 2.
		expect(estimateTokensFromText("日本語のテキスト")).toBe(6);
	});

	it("counts emoji surrogate pairs by bytes", () => {
		// 4 UTF-8 bytes -> 1 token even though .length is 2.
		expect(estimateTokensFromText("😀")).toBe(1);
	});
});

// Repo-wide source lock: text-level token estimation has ONE owner,
// utils/src/tokens.ts. A file may define its own `function estimateTokens`
// only if it delegates (imports estimateTokensFromText) or is grandfathered
// below. Convert a copy, remove its entry; a stale entry fails, so the list
// can only shrink.
const PACKAGES_DIR = path.join(import.meta.dir, "../..");

// Message-level estimators with a genuinely different contract (AgentMessage,
// not text) — permanently allowed, never a text-copy.
const ESTIMATE_ALLOWED = new Set(["agent/src/compaction/compaction.ts"]);

// Every estimateTokens definition now delegates to estimateTokensFromText. The
// last holdout (mnemopi/src/core/local-llm.ts, a char-based floor(len/4) copy)
// was repointed onto the owner; keep this empty so a reintroduced hand-rolled
// estimator fails the lock immediately.
const ESTIMATE_GRANDFATHERED = new Set<string>([]);

const ESTIMATE_DEF = /function\s+estimateTokens\s*\(/;

async function walk(dir: string, out: string[], includeTests = false): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			// `argot` is vendored standalone SDK code (src/argot/constants.ts): kept
			// byte-for-byte in sync with santhreal/argot, it cannot import
			// @veyyon/utils, so it carries its own util copies by design — skip like vendor.
			if (
				entry.name === "node_modules" ||
				entry.name === "dist" ||
				entry.name === "vendor" ||
				entry.name === "argot"
			)
				continue;
			await walk(full, out, includeTests);
		} else if (entry.name.endsWith(".ts") && (includeTests || !entry.name.endsWith(".test.ts"))) {
			out.push(full);
		}
	}
}

// Collect every .ts under each package's test/ dir. A test helper that
// hand-rolls its own token estimator instead of importing the owner is a second
// definition that drifts — the src-only scan never saw it. Same delegation
// escape hatch: a def that references estimateTokensFromText is delegating, not
// duplicating.
async function testFiles(): Promise<string[]> {
	const files: string[] = [];
	for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		// argot is a standalone published package (only depends on smol-toml); it
		// cannot import @veyyon/utils and carries its own token estimator by design,
		// so exclude the whole package root from both the test and src scans.
		if (pkg.name === "argot") continue;
		try {
			await walk(path.join(PACKAGES_DIR, pkg.name, "test"), files, true);
		} catch {
			// Package without a test/ directory — nothing to scan.
		}
	}
	return files;
}

describe("estimateTokens source lock", () => {
	it("every estimateTokens definition delegates to estimateTokensFromText or is grandfathered", async () => {
		const offenders: string[] = [];
		const seen = new Set<string>();
		for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
			if (!pkg.isDirectory()) continue;
			// argot is a standalone published package (only depends on smol-toml); its
			// own token estimator cannot import estimateTokensFromText by design, so
			// exclude the whole package root from the src scan.
			if (pkg.name === "argot") continue;
			const files: string[] = [];
			try {
				await walk(path.join(PACKAGES_DIR, pkg.name, "src"), files);
			} catch {
				// Package without a src/ directory (assets-only) — nothing to scan.
			}
			for (const file of files) {
				const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
				if (rel === "utils/src/tokens.ts" || ESTIMATE_ALLOWED.has(rel)) continue;
				const text = await readFile(file, "utf8");
				if (!ESTIMATE_DEF.test(text)) continue;
				if (text.includes("estimateTokensFromText")) continue;
				seen.add(rel);
				if (!ESTIMATE_GRANDFATHERED.has(rel)) offenders.push(rel);
			}
		}
		const cleared = [...ESTIMATE_GRANDFATHERED].filter(rel => !seen.has(rel));
		expect(offenders, "new hand-rolled estimateTokens — delegate to @veyyon/utils estimateTokensFromText").toEqual(
			[],
		);
		expect(cleared, "grandfathered entries whose local estimator is gone — remove them from the list").toEqual([]);
	});

	it("no test file hand-rolls estimateTokens without delegating to estimateTokensFromText", async () => {
		const offenders: string[] = [];
		for (const file of await testFiles()) {
			const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
			const text = await readFile(file, "utf8");
			if (!ESTIMATE_DEF.test(text)) continue;
			if (text.includes("estimateTokensFromText")) continue;
			offenders.push(rel);
		}
		expect(
			offenders,
			"test-local hand-rolled estimateTokens — import estimateTokensFromText from @veyyon/utils instead",
		).toEqual([]);
	});
});
