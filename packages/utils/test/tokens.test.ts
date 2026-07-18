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

const ESTIMATE_GRANDFATHERED = new Set([
	// Char-based floor(len/4) copy (the CJK under-counter); lane-hot at lock time.
	"mnemopi/src/core/local-llm.ts",
]);

const ESTIMATE_DEF = /function\s+estimateTokens\s*\(/;

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

describe("estimateTokens source lock", () => {
	it("every estimateTokens definition delegates to estimateTokensFromText or is grandfathered", async () => {
		const offenders: string[] = [];
		const seen = new Set<string>();
		for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
			if (!pkg.isDirectory()) continue;
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
});
