/**
 * estimateTokens counts developer-role messages (silent-fallback fix, Law 10).
 *
 * The bug this suite locks out (HUNT2-silentfallback-developer-role-zero-tokens,
 * found 2026-07-22): estimateTokensUncached switched on message.role with cases
 * for user/assistant/custom/hookMessage/toolResult/branchSummary/compactionSummary
 * but NO "developer" case, so every developer message hit `default: return 0` and
 * was counted as ZERO tokens. Developer messages carry real content — synthetic
 * auto-continue prompts are stored as full developer messages (agent-session.ts
 * `{ role: "developer", content: userContent }`), some with normalized images.
 * All that content was invisible to the compaction trigger, pruning budgets, and
 * the operator context meter, so a developer/synthetic-continue-heavy session
 * could silently approach or exceed the provider context window.
 *
 * These tests assert the estimate tracks real content size (never 0 for
 * non-empty developer content) and that images add their fixed weight, matching
 * the other content-bearing roles.
 */
import { describe, expect, it } from "bun:test";
import { estimateTokens } from "@veyyon/agent-core/compaction";
import type { DeveloperMessage } from "@veyyon/ai";

function developerMessage(content: DeveloperMessage["content"]): DeveloperMessage {
	return { role: "developer", content, timestamp: 0 };
}

const LONG = "continue the migration across every remaining module. ".repeat(200);

describe("estimateTokens — developer role", () => {
	it("counts a string-content developer message instead of returning 0", () => {
		const tokens = estimateTokens(developerMessage(LONG));
		// A ~10KB prompt is worth well over a hundred tokens; the pre-fix bug
		// returned exactly 0 here.
		expect(tokens).toBeGreaterThan(100);
	});

	it("scales with content: a bigger developer prompt estimates larger", () => {
		const small = estimateTokens(developerMessage("short continuation nudge"));
		const big = estimateTokens(developerMessage(LONG));
		expect(big).toBeGreaterThan(small);
		expect(small).toBeGreaterThan(0);
	});

	it("counts text blocks in an array-content developer message", () => {
		const tokens = estimateTokens(
			developerMessage([
				{ type: "text", text: LONG },
				{ type: "text", text: "and then run the gate" },
			]),
		);
		expect(tokens).toBeGreaterThan(100);
	});

	it("adds image weight for developer messages carrying normalized images", () => {
		const textOnly = estimateTokens(
			developerMessage([{ type: "text", text: "resume with the attached screenshot" }]),
		);
		const withImage = estimateTokens(
			developerMessage([
				{ type: "text", text: "resume with the attached screenshot" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			]),
		);
		// The image contributes the same fixed IMAGE_TOKEN_ESTIMATE the toolResult
		// and custom roles use, so the image-bearing message estimates strictly larger.
		expect(withImage).toBeGreaterThan(textOnly);
	});

	it("returns 0 only for genuinely empty developer content", () => {
		expect(estimateTokens(developerMessage(""))).toBe(0);
		expect(estimateTokens(developerMessage([]))).toBe(0);
	});
});
