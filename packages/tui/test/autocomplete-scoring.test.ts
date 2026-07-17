/**
 * Exact-value coverage for the pure autocomplete scoring/parsing helpers in
 * autocomplete.ts. These run on every keystroke against untrusted prompt text
 * and decide which slash command Enter applies, so their ranking contract must
 * be pinned, not just smoke-tested through the provider.
 */
import { describe, expect, it } from "bun:test";
import {
	findLeadingSlashCommandStart,
	findTrailingSlashCommandStart,
	midPromptSkillTokenMatches,
	scoreCommandTextMatch,
} from "@veyyon/pi-tui/autocomplete";
import { subsequenceScore } from "@veyyon/pi-tui/fuzzy";

describe("scoreCommandTextMatch", () => {
	it("scores an empty prefix as a trivial match", () => {
		expect(scoreCommandTextMatch("", "settings")).toBe(1);
		expect(scoreCommandTextMatch("", "")).toBe(1);
	});

	it("scores an exact match highest", () => {
		expect(scoreCommandTextMatch("settings", "settings")).toBe(1000);
	});

	it("gives every prefix match the same flat 900 so registry order breaks ties", () => {
		// Documented invariant: `/set` must not rank the shorter `setup` above
		// `settings` via a length penalty, or the sync-completion path applies the
		// wrong command on Enter.
		expect(scoreCommandTextMatch("set", "settings")).toBe(900);
		expect(scoreCommandTextMatch("set", "setup")).toBe(900);
		expect(scoreCommandTextMatch("s", "settings")).toBe(900);
	});

	it("falls back to the subsequence score below any prefix match", () => {
		// "stg" is a subsequence of "settings" (s..t..g) but not a prefix.
		const score = scoreCommandTextMatch("stg", "settings");
		expect(score).toBe(subsequenceScore("stg", "settings"));
		expect(score).toBeGreaterThan(0);
		expect(score).toBeLessThan(900);
	});

	it("scores a non-subsequence as zero", () => {
		expect(scoreCommandTextMatch("xyz", "settings")).toBe(0);
		expect(scoreCommandTextMatch("zzz", "abc")).toBe(0);
	});
});

describe("findLeadingSlashCommandStart", () => {
	it("returns 0 for a bare leading slash", () => {
		expect(findLeadingSlashCommandStart("/foo")).toBe(0);
	});

	it("skips leading whitespace to the slash", () => {
		expect(findLeadingSlashCommandStart("   /foo")).toBe(3);
		expect(findLeadingSlashCommandStart("\t/foo")).toBe(1);
	});

	it("returns null when the line does not start with a slash", () => {
		expect(findLeadingSlashCommandStart("foo /bar")).toBeNull();
		expect(findLeadingSlashCommandStart("hello")).toBeNull();
		expect(findLeadingSlashCommandStart("")).toBeNull();
	});
});

describe("findTrailingSlashCommandStart", () => {
	it("returns the slash index for a token at end of line", () => {
		expect(findTrailingSlashCommandStart("/foo")).toBe(0);
		expect(findTrailingSlashCommandStart("hello /foo")).toBe(6);
		expect(findTrailingSlashCommandStart("a /")).toBe(2);
	});

	it("skips a leading-whitespace slash to the slash itself", () => {
		expect(findTrailingSlashCommandStart("  /cmd")).toBe(2);
	});

	it("returns null for a mid-word slash (a path, not a command)", () => {
		expect(findTrailingSlashCommandStart("foo/bar")).toBeNull();
		expect(findTrailingSlashCommandStart("a//x")).toBeNull();
	});

	it("returns null once a space follows the token (no longer trailing)", () => {
		expect(findTrailingSlashCommandStart("/foo bar")).toBeNull();
		expect(findTrailingSlashCommandStart("plain prose")).toBeNull();
	});
});

describe("midPromptSkillTokenMatches", () => {
	it("matches any prefix of the skill: namespace, including the bare slash entry", () => {
		expect(midPromptSkillTokenMatches("", "skill:humanizer")).toBe(true);
		expect(midPromptSkillTokenMatches("s", "skill:humanizer")).toBe(true);
		expect(midPromptSkillTokenMatches("skill", "skill:humanizer")).toBe(true);
		expect(midPromptSkillTokenMatches("skill:", "skill:humanizer")).toBe(true);
	});

	it("fuzzy-matches an explicit skill: query against the name", () => {
		expect(midPromptSkillTokenMatches("skill:hum", "skill:humanizer")).toBe(true);
		expect(midPromptSkillTokenMatches("skill:hmn", "skill:humanizer")).toBe(true);
	});

	it("matches a bare token against the skill's short name", () => {
		expect(midPromptSkillTokenMatches("hum", "skill:humanizer")).toBe(true);
		expect(midPromptSkillTokenMatches("humanizer", "skill:humanizer")).toBe(true);
	});

	it("falls through to the description only for an explicit skill: query", () => {
		// name miss + description subsequence hit -> matches.
		expect(midPromptSkillTokenMatches("skill:mng", "skill:foo", "skill: manage foo")).toBe(true);
		// name miss + description miss -> no match.
		expect(midPromptSkillTokenMatches("skill:zzz", "skill:humanizer", "a description")).toBe(false);
	});

	it("rejects a stray prose slash token that matches nothing", () => {
		expect(midPromptSkillTokenMatches("xyz", "skill:humanizer")).toBe(false);
		expect(midPromptSkillTokenMatches("world", "skill:humanizer", "rewrites text")).toBe(false);
	});
});

describe("built-in command vs skill ranking", () => {
	// Regression: typing "/thinking" once ranked skill:bug-bounty-campaign above
	// the built-in /thinking command, so Enter invoked the wrong entry. An
	// exact or prefix name match must always outrank any skill matched only
	// through its description (descScore is capped at subsequenceScore * 0.5).
	async function suggestionValues(prefixLine: string): Promise<string[]> {
		const { CombinedAutocompleteProvider } = await import("@veyyon/pi-tui/autocomplete");
		const commands = [
			{
				name: "skill:bug-bounty-campaign",
				description: "Run a structured bug bounty campaign, thinking through triage and hunting",
			},
			{ name: "skill:humanizer", description: "Rewrite thinking-heavy output in a human voice" },
			{ name: "thinking", description: "Set the thinking level" },
			{ name: "theme", description: "Switch color theme" },
		];
		const provider = new CombinedAutocompleteProvider(commands, process.cwd());
		const result = await provider.getSuggestions([prefixLine], 0, prefixLine.length);
		return result?.items.map(item => item.value) ?? [];
	}

	it("locks /thinking → the thinking command first", async () => {
		expect((await suggestionValues("/thinking"))[0]).toBe("thinking");
	});

	it("ranks a prefix match on a built-in above description-only skill matches", async () => {
		expect((await suggestionValues("/think"))[0]).toBe("thinking");
	});
});
