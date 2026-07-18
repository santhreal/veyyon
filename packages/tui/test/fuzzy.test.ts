import { describe, expect, it } from "bun:test";
import { fuzzyFilter, fuzzyMatch, isSubsequenceMatch, subsequenceScore } from "@veyyon/tui/fuzzy";
import { Glob } from "bun";

describe("fuzzyFilter", () => {
	it("does not satisfy long tokens by scattering letters across unrelated words", () => {
		const items = [
			{
				label: "Image Provider",
				text: "Image Provider providers.image openrouter Preferred provider for image generation",
			},
			{
				label: "Block Images",
				text: "Block Images images.blockImages false Prevent images from being sent to LLM providers",
			},
			{
				label: "Include Model in Prompt",
				text: "Include Model in Prompt includeModelInPrompt true Surface the active model identifier in the system prompt so the agent knows which model it is",
			},
			{
				label: "Service Tier",
				text: "Service Tier serviceTier openai-only Processing priority hint on supported providers",
			},
		];

		const results = fuzzyFilter(items, "image provider", item => item.text).map(item => item.label);

		expect(results[0]).toBe("Image Provider");
		expect(results).toContain("Block Images");
		expect(results).not.toContain("Include Model in Prompt");
		expect(results).not.toContain("Service Tier");
	});

	it("does not let stopwords absorb longer query tokens", () => {
		// "theme" must not match texts whose only hook is the word "the" —
		// nearly every setting description contains it, so the old ≤2-extra-chars
		// word-extension rule matched 121 of ~130 settings for this query.
		const items = [
			{
				label: "Dark Theme",
				text: "Dark Theme theme.dark titanium Theme used when the terminal background is dark",
			},
			{
				label: "Light Theme",
				text: "Light Theme theme.light light Theme used when the terminal background is light",
			},
			{
				label: "Approval Mode",
				text: "Approval Mode tools.approvalMode yolo Controls when the agent asks before running a tool",
			},
			{
				label: "Auto Compact",
				text: "Auto Compact compaction.auto true Compact the conversation when the context window fills up",
			},
		];

		const results = fuzzyFilter(items, "theme", item => item.text).map(item => item.label);

		expect(results).toEqual(["Dark Theme", "Light Theme"]);
		expect(fuzzyMatch("theme", "Controls when the agent asks before running a tool").matches).toBe(false);
	});

	it("still matches a query token that extends a real word by up to two chars", () => {
		expect(fuzzyMatch("themes", "Dark Theme theme.dark").matches).toBe(true);
		expect(fuzzyMatch("keybindings", "Keybinding actions").matches).toBe(true);
	});

	it("still supports short word-initial abbreviations", () => {
		const items = ["Ollama", "Kagi", "OpenCode Go", "Tavily"];

		expect(fuzzyFilter(items, "og", item => item)).toEqual(["OpenCode Go"]);
	});

	it("filters CJK queries instead of treating them as match-all", () => {
		const items = ["文件搜索", "搜索历史", "Settings"];

		expect(fuzzyFilter(items, "搜索", item => item)).toEqual(["搜索历史", "文件搜索"]);
		expect(fuzzyMatch("搜索", "Settings").matches).toBe(false);
	});
});

describe("isSubsequenceMatch", () => {
	it("is true iff query chars appear in target in order (case-sensitive)", () => {
		expect(isSubsequenceMatch("wig", "skill:wig")).toBe(true);
		expect(isSubsequenceMatch("lp", "local-plan")).toBe(true);
		expect(isSubsequenceMatch("", "anything")).toBe(true);
		expect(isSubsequenceMatch("giw", "skill:wig")).toBe(false); // wrong order
		expect(isSubsequenceMatch("WIG", "skill:wig")).toBe(false); // case-sensitive
		expect(isSubsequenceMatch("longer", "short")).toBe(false); // query longer than target
	});

	// ONE-PLACE lock: this subsequence matcher was hand-rolled identically in
	// autocomplete.ts, prompt-action-autocomplete.ts, and internal-url-
	// autocomplete.ts. It now lives only in fuzzy.ts. A re-declared boolean
	// `fuzzyMatch(query, target)` copy or a second isSubsequenceMatch must fail
	// here, not silently drift.
	it("is defined in exactly one source file and has no boolean-fuzzyMatch twins", async () => {
		const root = `${import.meta.dir}/../..`;
		const subsequenceDefs: string[] = [];
		const booleanFuzzyMatchDefs: string[] = [];
		for (const pkg of ["tui/src", "coding-agent/src"]) {
			const glob = new Glob("**/*.ts");
			for await (const rel of glob.scan({ cwd: `${root}/${pkg}` })) {
				const src = await Bun.file(`${root}/${pkg}/${rel}`).text();
				if (/function\s+isSubsequenceMatch\b/.test(src)) subsequenceDefs.push(`${pkg}/${rel}`);
				if (/function\s+fuzzyMatch\s*\(\s*query:\s*string,\s*target:\s*string\s*\):\s*boolean/.test(src)) {
					booleanFuzzyMatchDefs.push(`${pkg}/${rel}`);
				}
			}
		}
		expect(subsequenceDefs).toEqual(["tui/src/fuzzy.ts"]);
		expect(booleanFuzzyMatchDefs).toEqual([]);
	});
});

describe("subsequenceScore", () => {
	it("ranks exact > prefix > substring > gapped subsequence, 0 for non-match", () => {
		expect(subsequenceScore("", "anything")).toBe(1);
		expect(subsequenceScore("plan", "plan")).toBe(100);
		expect(subsequenceScore("pl", "plan")).toBe(80); // prefix
		expect(subsequenceScore("an", "plan")).toBe(60); // substring
		// gapped subsequence: p..a..n hits with gaps -> 40 minus 5 per gap.
		expect(subsequenceScore("pn", "plan")).toBe(35);
		expect(subsequenceScore("zz", "plan")).toBe(0);
	});

	// ONE-PLACE lock: the same score() was hand-rolled in all three autocomplete
	// files. It now lives only in fuzzy.ts.
	it("is defined in exactly one source file", async () => {
		const root = `${import.meta.dir}/../..`;
		const defs: string[] = [];
		for (const pkg of ["tui/src", "coding-agent/src"]) {
			const glob = new Glob("**/*.ts");
			for await (const rel of glob.scan({ cwd: `${root}/${pkg}` })) {
				const src = await Bun.file(`${root}/${pkg}/${rel}`).text();
				if (/function\s+subsequenceScore\b/.test(src)) defs.push(`${pkg}/${rel}`);
				// The old local copies were named `fuzzyScore(query, target): number`.
				if (/function\s+fuzzyScore\s*\(\s*query:\s*string,\s*target:\s*string\s*\):\s*number/.test(src)) {
					defs.push(`STRAY:${pkg}/${rel}`);
				}
			}
		}
		expect(defs).toEqual(["tui/src/fuzzy.ts"]);
	});
});
