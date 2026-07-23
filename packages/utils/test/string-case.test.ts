import { describe, expect, it } from "bun:test";
import { titleCaseSentence, titleCaseWords } from "../src/string-case";
import { collectPackageSources } from "./support/package-sources";

describe("titleCaseWords", () => {
	it("uppercases the first letter of every word", () => {
		expect(titleCaseWords("phase one cleanup")).toBe("Phase One Cleanup");
		expect(titleCaseWords("already Title Cased")).toBe("Already Title Cased");
	});

	it("collapses runs of whitespace to single spaces", () => {
		expect(titleCaseWords("fix   the\tbug")).toBe("Fix The Bug");
		expect(titleCaseWords("  leading and trailing  ")).toBe("Leading And Trailing");
	});

	it("keeps interior casing of each word intact", () => {
		expect(titleCaseWords("use gpuAccel for iOS")).toBe("Use GpuAccel For IOS");
	});

	it("returns empty string for empty or whitespace-only input", () => {
		expect(titleCaseWords("")).toBe("");
		expect(titleCaseWords("   ")).toBe("");
	});
});

describe("titleCaseSentence", () => {
	it("capitalizes only the first letter and preserves the rest", () => {
		expect(titleCaseSentence("fix the API rate limiter")).toBe("Fix the API rate limiter");
		expect(titleCaseSentence("already Capitalized")).toBe("Already Capitalized");
	});

	it("trims surrounding whitespace", () => {
		expect(titleCaseSentence("  add tests  ")).toBe("Add tests");
	});

	it("returns empty string for empty or whitespace-only input", () => {
		expect(titleCaseSentence("")).toBe("");
		expect(titleCaseSentence("   ")).toBe("");
	});
});

// Repo-wide source lock: titleCaseWords/titleCaseSentence have exactly ONE
// owner, packages/utils/src/string-case.ts. Both known local copies (todo.ts,
// todo-command-controller.ts) were converted when this lock landed, so no
// grandfathered set — any new local definition fails outright. The monorepo
// walk + skip-set is shared with every other source-ownership lock (see
// ./support/package-sources).
const LOCAL_DEF = /function\s+titleCase(?:Words|Sentence)?\s*\(/;

describe("titleCase source lock", () => {
	it("no production source defines a local titleCase variant outside utils/src/string-case.ts", async () => {
		const offenders: string[] = [];
		for (const { rel, text } of await collectPackageSources({ dirs: ["src"] })) {
			if (rel === "utils/src/string-case.ts") continue;
			if (LOCAL_DEF.test(text)) offenders.push(rel);
		}
		expect(offenders, "local titleCase copies — import from @veyyon/utils instead").toEqual([]);
	});
});
