/**
 * Behavior tests for shared agent stats formatting and output sanitization.
 *
 * Proves that appendAgentStats and sanitizeRecentOutput provide host-independent
 * presentation data and that terminal rendering through drawSpans preserves:
 * - Tool count formatting with extension tool icon
 * - Request counts
 * - Context usage gauge (formatContextUsage from @veyyon/utils)
 * - Cost formatting and cost tone
 * - Model badge with thinking level symbols
 * - Notice stripping (wall time, exit code, artifact references)
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { drawSpans } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import {
	appendAgentStats,
	modelBadgeSpans,
	STATS_DOT,
	sanitizeRecentOutput,
} from "@veyyon/coding-agent/task/agent-stats";
import { getThemeByName, type Theme } from "@veyyon/coding-agent/theme/theme";
import type { ViewSpan } from "@veyyon/view";

describe("agent-stats", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("dark theme unavailable");
		uiTheme = loaded;
	});

	describe("appendAgentStats", () => {
		it("appends tool count, requests, context gauge, cost, and model badge spans", () => {
			const line: ViewSpan[] = [{ text: "12m 3s", tone: "dim" }];
			appendAgentStats(line, {
				toolCount: 14,
				requests: 4,
				tokens: 50000,
				contextTokens: 47000,
				contextWindow: 200000,
				cost: 0.12,
				resolvedModel: "anthropic/claude-3-7-sonnet:high",
				showResolvedModelBadge: true,
			});

			// Assert span structure
			expect(line[0]).toEqual({ text: "12m 3s", tone: "dim" });
			expect(line[1]).toEqual(STATS_DOT);
			expect(line[2]).toEqual({ text: "14 ", tone: "dim" });
			expect(line[3]).toEqual({ text: "", symbol: "icon.extensionTool", tone: "dim" });
			expect(line[4]).toEqual(STATS_DOT);
			expect(line[5]).toEqual({ text: "4 req", tone: "dim" });
			expect(line[6]).toEqual(STATS_DOT);
			expect(line[7]).toEqual({ text: "47K/200K", tone: "dim" });
			expect(line[8]).toEqual(STATS_DOT);
			expect(line[9]).toEqual({ text: "$0.12", tone: "cost" });
			expect(line[10]).toEqual(STATS_DOT);

			// Render through host drawSpans and assert styled output
			const drawn = drawSpans(line, uiTheme);
			const stripped = stripVTControlCharacters(drawn);
			expect(stripped).toContain("12m 3s");
			expect(stripped).toContain("14");
			expect(stripped).toContain("4 req");
			expect(stripped).toContain("47K/200K");
			expect(stripped).toContain("$0.12");
			expect(stripped).toContain("claude-3-7-sonnet");
		});

		it("omits optional stats when 0 or undefined", () => {
			const line: ViewSpan[] = [{ text: "5s", tone: "dim" }];
			appendAgentStats(line, {
				tokens: 0,
				cost: 0,
			});

			expect(line).toEqual([{ text: "5s", tone: "dim" }]);
			const drawn = drawSpans(line, uiTheme);
			expect(stripVTControlCharacters(drawn)).toBe("5s");
		});

		it("formats model badge with thinking level symbol", () => {
			const spans = modelBadgeSpans("openai/o3-mini:medium");
			expect(spans).toEqual([
				{ text: "o3-mini", tone: "muted" },
				{ text: " " },
				{ text: "medium", symbol: "thinking.medium" },
			]);

			const drawn = drawSpans(spans, uiTheme);
			const stripped = stripVTControlCharacters(drawn);
			expect(stripped).toContain("o3-mini");
		});

		it("formats model badge without level when off or inherit", () => {
			const offSpans = modelBadgeSpans("anthropic/claude-3-5-haiku:off");
			expect(offSpans).toEqual([{ text: "claude-3-5-haiku", tone: "muted" }]);

			const inheritSpans = modelBadgeSpans("anthropic/claude-3-5-sonnet:inherit");
			expect(inheritSpans).toEqual([{ text: "claude-3-5-sonnet", tone: "muted" }]);
		});
	});

	describe("sanitizeRecentOutput", () => {
		it("strips bash wall time notice", () => {
			const output = "Compiling project...\nBuild succeeded\n\nWall time: 1.23 seconds";
			const sanitized = sanitizeRecentOutput(output);
			expect(sanitized).toBe("Compiling project...\nBuild succeeded");
		});

		it("strips exit code notices", () => {
			const normalExit = "Running tests...\nCommand exited with code 1";
			expect(sanitizeRecentOutput(normalExit)).toBe("Running tests...");

			const signalExit =
				"Processing data...\nCommand was killed by SIGKILL (9); the shell reports this as exit code 137";
			expect(sanitizeRecentOutput(signalExit)).toBe("Processing data...");
		});

		it("strips raw output artifact notices", () => {
			const artifactNotice = "Output line 1\nOutput line 2\n[raw output: artifact://123]";
			expect(sanitizeRecentOutput(artifactNotice)).toBe("Output line 1\nOutput line 2");
		});

		it("strips multiple trailing runtime notices in sequence", () => {
			const multiNotice = "Finished task\n[raw output: artifact://456]\n\nWall time: 0.45 seconds";
			expect(sanitizeRecentOutput(multiNotice)).toBe("Finished task");
		});

		it("preserves genuine output without notices", () => {
			const clean = "line one\nline two\nline three";
			expect(sanitizeRecentOutput(clean)).toBe("line one\nline two\nline three");
		});

		it("handles empty or whitespace-only strings", () => {
			expect(sanitizeRecentOutput("")).toBe("");
			expect(sanitizeRecentOutput("   \n\n  ")).toBe("");
		});
	});
});
