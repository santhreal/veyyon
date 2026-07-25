import { describe, expect, it } from "bun:test";
import { kebabToCamel, titleCaseSentence, titleCaseWords } from "../src/string-case";
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

/**
 * `kebabToCamel` behavior contract.
 *
 * WHY THIS SUITE EXISTS. This conversion was hand-rolled twice: privately in
 * `frontmatter.ts` (normalizing YAML keys) and again in the coding-agent's
 * system-prompt block registry (deriving camelCase section-override keys from
 * the canonical kebab ids). Byte-identical copies still drift, and the second
 * copy silently made the prompt registry the owner of a conversion it had no
 * business owning. Both now import this one, so its edge cases are pinned here.
 */
describe("kebabToCamel", () => {
	it("lifts the letter after each hyphen and drops the hyphen", () => {
		expect(kebabToCamel("thinking-level")).toBe("thinkingLevel");
		expect(kebabToCamel("tool-policy")).toBe("toolPolicy");
		expect(kebabToCamel("execution-workflow")).toBe("executionWorkflow");
	});

	it("returns a hyphen-free key unchanged, including an already-camel one", () => {
		// The fast path must not disturb a key that is already correct, or a
		// round-trip through normalization would mangle it.
		expect(kebabToCamel("role")).toBe("role");
		expect(kebabToCamel("thinkingLevel")).toBe("thinkingLevel");
		expect(kebabToCamel("")).toBe("");
	});

	it("converts every hyphen in a multi-segment key", () => {
		expect(kebabToCamel("a-b-c")).toBe("aBC");
	});

	it("leaves a segment that does not start with a lowercase letter alone", () => {
		// Only /-([a-z])/ is lifted. A numeric or already-uppercase segment keeps
		// its hyphen, so identifiers like these survive normalization intact
		// rather than being silently mangled into something unresolvable.
		expect(kebabToCamel("utf-8")).toBe("utf-8");
		expect(kebabToCamel("X-Header")).toBe("X-Header");
	});

	it("leaves a trailing hyphen in place", () => {
		expect(kebabToCamel("trailing-")).toBe("trailing-");
	});
});

const LOCAL_KEBAB_DEF = /function\s+(?:kebabToCamel|camelSectionKey)\s*\(|replace\(\s*\/-\(\[a-z\]\)\/g/;

describe("kebabToCamel source lock", () => {
	/**
	 * The regex above catches BOTH a same-named copy and a differently-named one
	 * that hand-rolls the identical `/-([a-z])/g` replace — which is exactly the
	 * form the prompt-registry duplicate took (`camelSectionKey`). A rename is not
	 * a defense against duplication, so the lock matches the operation, not a name.
	 */
	it("no production source hand-rolls a kebab-to-camel conversion outside utils/src/string-case.ts", async () => {
		const offenders: string[] = [];
		for (const { rel, text } of await collectPackageSources({ dirs: ["src"] })) {
			if (rel === "utils/src/string-case.ts") continue;
			if (LOCAL_KEBAB_DEF.test(text)) offenders.push(rel);
		}
		expect(offenders, "local kebab-to-camel copies — import kebabToCamel from @veyyon/utils instead").toEqual([]);
	});
});
