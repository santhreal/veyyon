import { describe, expect, it } from "bun:test";
import { estimateTokensFromText } from "../src/tokens";
import { collectPackageSources } from "./support/package-sources";

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
// can only shrink. The monorepo walk + skip-set is shared with every other
// source-ownership lock (see ./support/package-sources).

// Message-level estimators with a genuinely different contract (AgentMessage,
// not text) — permanently allowed, never a text-copy. It walks a message's
// blocks and hands the fragments to the owner's tokenizer; it does not estimate
// text itself.
//
// Moved from `agent/src/compaction/compaction.ts` when the estimator was split
// out of the compaction engine, which reaches 395 modules and which three
// callers were importing purely to get this function.
const ESTIMATE_ALLOWED = new Set(["agent/src/compaction/token-estimate.ts"]);

// Every estimateTokens definition now delegates to estimateTokensFromText. The
// last holdout (mnemopi/src/core/local-llm.ts, a char-based floor(len/4) copy)
// was repointed onto the owner; keep this empty so a reintroduced hand-rolled
// estimator fails the lock immediately.
const ESTIMATE_GRANDFATHERED = new Set<string>([]);

const ESTIMATE_DEF = /function\s+estimateTokens\s*\(/;

describe("estimateTokens source lock", () => {
	it("every estimateTokens definition delegates to estimateTokensFromText or is grandfathered", async () => {
		const offenders: string[] = [];
		const seen = new Set<string>();
		for (const { rel, text } of await collectPackageSources({ dirs: ["src"] })) {
			if (rel === "utils/src/tokens.ts" || ESTIMATE_ALLOWED.has(rel)) continue;
			if (!ESTIMATE_DEF.test(text)) continue;
			if (text.includes("estimateTokensFromText")) continue;
			seen.add(rel);
			if (!ESTIMATE_GRANDFATHERED.has(rel)) offenders.push(rel);
		}
		const cleared = [...ESTIMATE_GRANDFATHERED].filter(rel => !seen.has(rel));
		expect(offenders, "new hand-rolled estimateTokens — delegate to @veyyon/utils estimateTokensFromText").toEqual(
			[],
		);
		expect(cleared, "grandfathered entries whose local estimator is gone — remove them from the list").toEqual([]);
	});

	/**
	 * The ALLOWED list rots the same way the grandfathered one does, and it rots more quietly.
	 *
	 * A stale grandfathered entry fails the case above. A stale ALLOWED entry fails nothing: it simply stops
	 * matching any file, and the exemption it was granting silently moves nowhere. That is exactly what
	 * happened when the message-level estimator was split out of `compaction.ts` into its own module. The
	 * lock did its job and flagged the new file, but only because the new file was a NEW path; had the split
	 * gone the other way, an exemption for a file that no longer defines an estimator would have sat here
	 * indefinitely, ready to excuse a hand-rolled copy that landed in that path later.
	 *
	 * So every allowed path must still exist AND must still define an estimator.
	 */
	it("every permanently allowed path still defines the estimator it is excusing", async () => {
		const sources = await collectPackageSources({ dirs: ["src"] });
		const defining = new Set(sources.filter(({ text }) => ESTIMATE_DEF.test(text)).map(({ rel }) => rel));

		// NON-VACUITY, in both directions this can fail silently: the walk really read the monorepo, and it
		// really found definitions in it. An empty scan satisfies "every allowed path is among them" for
		// free, and so does a scan whose pattern stopped matching anything.
		expect(sources.length).toBeGreaterThan(500);
		expect(defining.size).toBeGreaterThan(0);

		const stale = [...ESTIMATE_ALLOWED].filter(rel => !defining.has(rel));
		expect(stale, "allowed entries that no longer define an estimator — remove or repoint them").toEqual([]);
	});

	// A test helper that hand-rolls its own token estimator instead of importing
	// the owner is a second definition that drifts — the src-only scan never saw
	// it. Same delegation escape hatch: a def that references
	// estimateTokensFromText is delegating, not duplicating.
	it("no test file hand-rolls estimateTokens without delegating to estimateTokensFromText", async () => {
		const offenders: string[] = [];
		for (const { rel, text } of await collectPackageSources({ dirs: ["test"], includeTests: true })) {
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
