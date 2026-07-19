import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	buildExtractionPrompt,
	countExtractedFactCategories,
	extractFactCategories,
	extractFacts,
	extractFactsSafe,
	flattenExtractedFactCategories,
	heuristicExtractFacts,
	parseExtractedFactCategories,
	parseFacts,
} from "@veyyon/mnemopi/core/extraction";
import { getExtractionStats, resetExtractionStats } from "@veyyon/mnemopi/core/extraction/diagnostics";
import { CallableLlmBackend, resetHostLlmBackendForTests, setHostLlmBackend } from "@veyyon/mnemopi/core/llm-backends";
import { type ResolvedMnemopiRuntimeOptions, withMnemopiRuntimeOptions } from "@veyyon/mnemopi/core/runtime-options";

const OLD_ENV = { ...process.env };
function restoreEnv(): void {
	for (const key in process.env) {
		if (!(key in OLD_ENV)) delete process.env[key];
	}
	for (const key in OLD_ENV) {
		const value = OLD_ENV[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	restoreEnv();
	resetHostLlmBackendForTests();
	resetExtractionStats();
});

describe("structured extraction", () => {
	it("builds prompts and parses JSON and legacy facts", () => {
		const prompt = buildExtractionPrompt("I love coffee");
		expect(prompt).toContain("I love coffee");
		expect(prompt.toLowerCase()).toContain("extract");

		expect(parseFacts('{"facts":["The user likes coffee"],"preferences":["The user prefers tea"]}')).toEqual([
			"The user likes coffee",
			"The user prefers tea",
		]);
		expect(parseFacts("1. The user loves coffee\n- The user hates mornings")).toEqual([
			"The user loves coffee",
			"The user hates mornings",
		]);
		expect(parseFacts("NO_FACTS")).toEqual([]);
	});

	it("unwraps category-specific object facts and drops unrecognized objects", () => {
		const modelJson = JSON.stringify({
			facts: [{ fact: "The user prefers tabs over spaces" }, { nested: {} }, "The user likes concise replies."],
			instructions: [{ instruction: "Always include verification details" }],
			preferences: [{ preference: "Prefers dark mode" }],
			timelines: [
				{ date: "2026-08-01", description: "release" },
				{ subject: "release", predicate: "on", object: "2026-08-01" },
			],
		});

		expect(parseFacts(modelJson)).toEqual([
			"The user prefers tabs over spaces",
			"The user likes concise replies",
			"Always include verification details",
			"Prefers dark mode",
			"release 2026-08-01",
		]);
	});

	it("treats a valid empty structured extraction as no facts", () => {
		expect(parseFacts('{"facts": [], "instructions": [], "preferences": [], "timelines": [], "kg": []}')).toEqual([]);
		expect(
			parseFacts('```json\n{"facts": [], "instructions": [], "preferences": [], "timelines": [], "kg": []}\n```'),
		).toEqual([]);
	});

	it("uses deterministic heuristic extraction when no LLM is configured", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "false";
		const facts = await extractFactsSafe("My name is Ada. I work at Example Corp and I prefer dark mode.");
		expect(facts).toContain("The user's name is Ada");
		expect(facts).toContain("The user works at Example Corp");
		expect(facts).toContain("The user prefers dark mode");

		const stats = getExtractionStats();
		expect(stats.totals.successes).toBe(1);
		expect(stats.by_tier.local.successes).toBe(1);
	});

	it("returns empty without recording for empty input", async () => {
		expect(await extractFacts("   ")).toEqual([]);
		expect(getExtractionStats().totals.calls).toBe(0);
	});

	it("routes enabled host LLM extraction before remote and keeps temperature zero", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_ENABLED = "true";
		process.env.MNEMOPI_LLM_BASE_URL = "http://remote.invalid/v1";
		let capturedTemperature = -1;
		setHostLlmBackend(
			new CallableLlmBackend("fake", (_prompt, opts) => {
				capturedTemperature = opts?.temperature ?? -1;
				return "- Alex uses Neovim.\n- Alex dislikes VSCode.";
			}),
		);

		const facts = await extractFacts("Alex said they prefer Neovim and dislike VSCode.");
		expect(facts).toEqual(["Alex uses Neovim", "Alex dislikes VSCode"]);
		expect(capturedTemperature).toBe(0);
		expect(getExtractionStats().by_tier.host.successes).toBe(1);
	});

	it("prefers a configured completion with the extraction-prompt override at temperature zero", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		let capturedPrompt = "";
		let capturedTemperature = -1;
		const resolved: ResolvedMnemopiRuntimeOptions = {
			llm: {
				enabled: true,
				extractionPrompt: "ONLY-LINES for: {text}\nItems:",
				complete: (prompt, opts) => {
					capturedPrompt = prompt;
					capturedTemperature = opts?.temperature ?? -1;
					return "Sam works at Globex\nSam prefers dark mode";
				},
			},
		};

		const facts = await withMnemopiRuntimeOptions(resolved, () =>
			extractFacts("Sam works at Globex and prefers dark mode."),
		);

		expect(facts).toEqual(["Sam works at Globex", "Sam prefers dark mode"]);
		expect(capturedPrompt).toContain("ONLY-LINES for: Sam works at Globex and prefers dark mode.");
		expect(capturedTemperature).toBe(0);
		expect(getExtractionStats().by_tier.host.successes).toBe(1);
	});

	it("extracts simple facts with the standalone heuristic helper", () => {
		expect(heuristicExtractFacts("I live in Berlin and I use TypeScript.")).toEqual([
			"The user lives in Berlin",
			"The user uses TypeScript",
		]);
	});

	it("captures `Instruction:` facts only when a subject precedes always/never", () => {
		// Subject-led imperatives are still captured.
		expect(heuristicExtractFacts("I never use semicolons and you always wrap lines at 100.")).toEqual([
			"Instruction: never use semicolons",
			"Instruction: always wrap lines at 100",
		]);
	});

	it("ignores subjectless always/never sentences (issue #3372)", () => {
		// Pre-fix this would have produced `Instruction: never activates` and
		// `Instruction: never populates …` from assistant narrative prose.
		const transcript =
			"[role: assistant]\nso reorder never activates and the panel never populates (because pointer events fire before the drop handler binds).\n[assistant:end]";
		const facts = heuristicExtractFacts(transcript);
		expect(facts.some(f => f.startsWith("Instruction:"))).toBe(false);
	});
});

describe("category-preserving parse helpers", () => {
	it("returns empty categories for null, undefined, blank, and NO_FACTS input", () => {
		const empty = { facts: [], instructions: [], preferences: [], timelines: [], kg: [] };
		expect(parseExtractedFactCategories(null)).toEqual(empty);
		expect(parseExtractedFactCategories(undefined)).toEqual(empty);
		expect(parseExtractedFactCategories("   ")).toEqual(empty);
		expect(parseExtractedFactCategories("no_facts")).toEqual(empty);
	});

	it("parses knowledge-graph triples from both object and positional-array forms", () => {
		const extracted = parseExtractedFactCategories(
			JSON.stringify({
				facts: ["The user ships on Fridays"],
				kg: [
					{ subject: "Ada", predicate: "works_at", object: "Globex" },
					["Server", "listens_on", "port 8080"],
					{ subject: "", predicate: "missing", object: "dropped" },
					["only", "two"],
				],
			}),
		);
		expect(extracted.kg).toEqual([
			{ subject: "Ada", predicate: "works_at", object: "Globex" },
			{ subject: "Server", predicate: "listens_on", object: "port 8080" },
		]);
		expect(extracted.facts).toEqual(["The user ships on Fridays"]);
	});

	it("recovers quoted 10+ char strings when the JSON object is malformed", () => {
		// Starts with `{` so JSON.parse is attempted, then throws (unterminated);
		// the catch salvages every quoted run of >=10 chars as a flat fact.
		const salvaged = parseExtractedFactCategories('{"facts": ["The user enjoys long walks", "short", "bad');
		expect(salvaged.facts).toEqual(["The user enjoys long walks"]);
		expect(salvaged.instructions).toEqual([]);
		expect(salvaged.kg).toEqual([]);
	});

	it("counts string facts plus KG triples and flattens categories in a fixed order", () => {
		const extracted = parseExtractedFactCategories(
			JSON.stringify({
				facts: ["Fact one"],
				instructions: ["Always use tabs"],
				preferences: ["Prefers dark mode"],
				timelines: ["Release on 2026-08-01"],
				kg: [{ subject: "a", predicate: "b", object: "c" }],
			}),
		);
		expect(countExtractedFactCategories(extracted)).toBe(5);
		// kg is excluded from the flat legacy list; the four string categories
		// flatten in declaration order.
		expect(flattenExtractedFactCategories(extracted)).toEqual([
			"Fact one",
			"Always use tabs",
			"Prefers dark mode",
			"Release on 2026-08-01",
		]);
	});

	it("returns no heuristic facts for whitespace-only text", () => {
		expect(heuristicExtractFacts("   \n\t  ")).toEqual([]);
	});

	it("substitutes both {text} and {lang} in a runtime-overridden prompt template", () => {
		const resolved: ResolvedMnemopiRuntimeOptions = {
			llm: { enabled: true, extractionPrompt: "lang={lang} :: {text}" },
		};
		const prompt = withMnemopiRuntimeOptions(resolved, () => buildExtractionPrompt("hello there", "de"));
		expect(prompt).toBe("lang=de :: hello there");
	});
});

describe("local heuristic fallback after an empty configured completion", () => {
	it("falls back to heuristic facts when the configured LLM yields no facts", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		const resolved: ResolvedMnemopiRuntimeOptions = {
			llm: { enabled: true, complete: () => "NO_FACTS" },
		};
		const facts = await withMnemopiRuntimeOptions(resolved, () => extractFacts("I live in Berlin and I use Rust."));
		expect(facts).toEqual(["The user lives in Berlin", "The user uses Rust"]);
		const stats = getExtractionStats();
		expect(stats.by_tier.local.successes).toBe(1);
	});

	it("returns no facts when the configured LLM is empty and no heuristic matches", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		const resolved: ResolvedMnemopiRuntimeOptions = {
			llm: { enabled: true, complete: () => "NO_FACTS" },
		};
		const facts = await withMnemopiRuntimeOptions(resolved, () => extractFacts("The sky is blue and clear today."));
		expect(facts).toEqual([]);
		const stats = getExtractionStats();
		expect(stats.by_tier.local.successes).toBe(0);
	});
});

/** A `fetch` stand-in returning one OpenAI chat-completions body, keeping `.preconnect` typed. */
function mockChatCompletion(content: string, status = 200) {
	return spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			() => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })),
			{
				preconnect: globalThis.fetch.preconnect,
			},
		),
	);
}

describe("extraction transport failure and no-output diagnostics", () => {
	it("returns empty categories and records configured_completion_raised when the completion throws", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		const resolved: ResolvedMnemopiRuntimeOptions = {
			llm: {
				enabled: true,
				complete: () => {
					throw new Error("completion exploded");
				},
			},
		};
		const result = await withMnemopiRuntimeOptions(resolved, () =>
			extractFactCategories("Ada uses Rust and drinks tea."),
		);
		expect(countExtractedFactCategories(result)).toBe(0);
		const host = getExtractionStats().by_tier.host;
		expect(host.failures).toBe(1);
		expect(host.error_samples[0]?.reason).toBe("configured_completion_raised");
	});

	it("records a host no_output and falls back to the local tier when the host returns blank text", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_ENABLED = "true";
		setHostLlmBackend(new CallableLlmBackend("blank-host", () => "   "));

		const result = await extractFactCategories("Zzz qqq opaque payload.");
		expect(countExtractedFactCategories(result)).toBe(0);
		const stats = getExtractionStats();
		expect(stats.by_tier.host.no_output).toBe(1);
		// localFallback runs after the blank host: callLocalLlm is a null stub, so the local tier
		// is attempted, misses (model_not_loaded), then the heuristic finds nothing in the payload.
		expect(stats.by_tier.local.attempts).toBe(1);
	});

	it("returns remote-extracted categories when the remote LLM yields facts", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_LLM_BASE_URL = "http://remote.test/v1";
		delete process.env.MNEMOPI_HOST_LLM_ENABLED;
		const spy = mockChatCompletion('{"facts":["Remote fact one"]}');
		try {
			const result = await extractFactCategories("Some input to embed remotely.");
			expect(result.facts).toEqual(["Remote fact one"]);
			expect(getExtractionStats().by_tier.remote.successes).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("records a remote no_output and falls back locally when the remote yields no facts", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_LLM_BASE_URL = "http://remote.test/v1";
		delete process.env.MNEMOPI_HOST_LLM_ENABLED;
		const spy = mockChatCompletion("NO_FACTS");
		try {
			const result = await extractFactCategories("Zzz qqq opaque payload.");
			expect(countExtractedFactCategories(result)).toBe(0);
			const stats = getExtractionStats();
			expect(stats.by_tier.remote.no_output).toBe(1);
			expect(stats.by_tier.local.attempts).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("line-parses a brace-prefixed string that is neither valid JSON nor holds quoted runs", () => {
		// startsWith("{") enters the JSON branch, JSON.parse throws, no 10+ char quoted run exists,
		// so the salvage misses and control falls through to the newline splitter.
		const result = parseExtractedFactCategories("{oops this is not valid json at all}");
		expect(result.facts).toEqual(["{oops this is not valid json at all}"]);
		expect(result.kg).toEqual([]);
	});
});

// The extractor parses raw LLM output, which is hostile input: a model can emit
// over-long arrays, mistyped entries, mixed object shapes, and fenced blocks.
// These tests pin the exact clamping, field-resolution, and fence-stripping
// contract so a pathological completion can never blow past the per-category or
// flat-fact caps nor smuggle non-string junk into the store. (kg-triple parsing
// and malformed-JSON salvage are pinned in "category-preserving parse helpers".)
describe("extractor output parsing under adversarial and boundary input", () => {
	it("clamps each structured category to five entries and drops overflow", () => {
		const result = parseExtractedFactCategories(JSON.stringify({ facts: ["a", "b", "c", "d", "e", "f", "g"] }));
		// STRUCTURED_CATEGORY_LIMIT is 5: the sixth and seventh facts are dropped.
		expect(result.facts).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("clamps the flattened fact list to five across categories in flatten order", () => {
		// flatten order is facts, then instructions, then preferences; six entries
		// collapse to the first five, so the second preference falls off the end.
		const facts = parseFacts(
			JSON.stringify({ facts: ["fa", "fb"], instructions: ["ia", "ib"], preferences: ["pa", "pb"] }),
		);
		expect(facts).toEqual(["fa", "fb", "ia", "ib", "pa"]);
	});

	it("resolves object-shaped entries by field priority and drops empty and non-string values", () => {
		const result = parseExtractedFactCategories(
			JSON.stringify({
				facts: [
					{ text: "from text field", statement: "ignored because text wins" },
					{ value: "from value field" },
					{ nested: { deep: "unreachable" } },
					{ fact: "   " },
					42,
				],
			}),
		);
		// FACT_TEXT_FIELD_KEYS priority is fact, text, content, value, statement; the
		// first non-blank field wins and the rest are ignored. Blank-only, deeply
		// nested, and non-object entries resolve to nothing and are skipped.
		expect(result.facts).toEqual(["from text field", "from value field"]);
	});

	it("joins every populated timeline field with a space in field order", () => {
		const result = parseExtractedFactCategories(JSON.stringify({ timelines: [{ event: "ship", timeline: "Q3" }] }));
		// Timelines set joinFields, so description/event/timeline/date all concatenate;
		// here only event and timeline are present, joined in that order.
		expect(result.timelines).toEqual(["ship Q3"]);
	});

	it("strips a bare code fence with no json tag before parsing", () => {
		const result = parseExtractedFactCategories('```\n{"facts":["bare fenced fact"]}\n```');
		expect(result.facts).toEqual(["bare fenced fact"]);
	});

	it("strips only trailing sentence punctuation and keeps internal punctuation", () => {
		const result = parseExtractedFactCategories(
			JSON.stringify({ facts: ["Ends with dots...", "Keep? internal! marks.", "  ", ""] }),
		);
		// A trailing run of . ! ? is removed; internal ? and ! survive; whitespace-only
		// and empty entries never reach the output.
		expect(result.facts).toEqual(["Ends with dots", "Keep? internal! marks"]);
	});

	it("keeps only lines over ten characters when falling back to the newline splitter", () => {
		const result = parseExtractedFactCategories("short\n1. This bullet line is clearly long enough\ntiny");
		// The line splitter strips leading numbering/bullets and requires more than ten
		// characters, so only the middle line survives.
		expect(result.facts).toEqual(["This bullet line is clearly long enough"]);
	});
});
