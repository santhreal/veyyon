/**
 * Pins argot's PUBLIC export surface — the `index.ts` barrel that consumers
 * import as `from "argot"`. Every other test in this suite reaches into
 * `../src/<module>` directly, so none of them notices if an export is
 * accidentally dropped from, or quietly added to, the barrel: the implementation
 * stays green while the shipped contract silently changes and a consumer (veyyon)
 * breaks. This test is the one that fails on that drift.
 *
 * It asserts the exact set of runtime exports (a removal AND an undocumented
 * addition both go red, forcing a conscious edit here), the kind of each, and
 * concrete values/behaviors for the load-bearing ones. The type-only import block
 * at the bottom makes tsc fail if a TYPE export is removed, since types are not
 * visible at runtime.
 */

import { describe, expect, it } from "bun:test";
import type { Vocabulary } from "../src/index.js";
import * as argot from "../src/index.js";

/** An empty runtime Vocabulary, built entirely from barrel exports. */
function emptyVocab(): Vocabulary {
	return { version: argot.SUPPORTED_VERSION, sigil: argot.DEFAULT_SIGIL, handles: new Map(), meta: new Map() };
}

// The complete runtime (value) export surface, by kind. Adding or removing an
// export here in lockstep with index.ts is the intended, reviewable action; a
// mismatch against the actual barrel is the regression this test catches.
const EXPECTED: Record<string, "function" | "string" | "number" | "object"> = {
	// cache.ts
	cacheDictPath: "function",
	listingSignature: "function",
	readDictFile: "function",
	resolveProjectCache: "function",
	writeDictFileAtomic: "function",
	// codec.ts
	ArgotConflictError: "function",
	emptyDict: "function",
	makeDict: "function",
	makeExpander: "function",
	makePromptFragment: "function",
	measureDecode: "function",
	unionVocabularies: "function",
	// constants.ts
	ARGOT_LOAD_TOOL: "string",
	ARGOT_UNLOAD_TOOL: "string",
	DEFAULT_SIGIL: "string",
	DEFAULT_TOKEN_BUDGET: "number",
	DICT_FILENAME: "string",
	MAX_EXPANSION_BYTES: "number",
	SUPPORTED_VERSION: "number",
	// generate.ts
	extractCandidates: "function",
	estimateTokens: "function",
	generateDict: "function",
	generateDictFromRepo: "function",
	scoringFrequency: "function",
	// load.ts
	load: "function",
	// corpus.ts
	CONTENT_SKIP_BASENAMES: "object",
	CONTENT_SKIP_SUFFIXES: "object",
	gatherRepoFiles: "function",
	MAX_FILE_CONTENT_BYTES: "number",
	shouldScanContent: "function",
	TOTAL_CONTENT_BUDGET_BYTES: "number",
	walkProjectTree: "function",
	WALK_FILE_CAP: "number",
	WALK_IGNORE_NAMES: "object",
	// project-vocab.ts
	budgetKeyedSignature: "function",
	resolveProjectVocab: "function",
	resolveTokenBudget: "function",
	// parse.ts
	ArgotParseError: "function",
	parseDict: "function",
	// project.ts
	PROJECT_MARKERS: "object",
	projectCacheId: "function",
	resolveProjectRoot: "function",
	// policy.ts
	EMPTY_GATE: "object",
	makeGate: "function",
	modelAllowed: "function",
	modelIdSegment: "function",
	shouldEncode: "function",
	// preamble.ts
	ARGOT_PREAMBLE: "string",
	renderPreamble: "function",
	// session.ts
	ArgotSession: "function",
	// stream.ts
	makeStreamDecoder: "function",
	StreamDecoder: "function",
};

describe("argot public export surface", () => {
	it("exposes exactly the expected set of runtime exports, no more and no fewer", () => {
		const actual = Object.keys(argot).sort();
		expect(actual).toEqual(Object.keys(EXPECTED).sort());
	});

	it("exports each symbol with the expected kind", () => {
		for (const [name, kind] of Object.entries(EXPECTED)) {
			expect((argot as Record<string, unknown>)[name], `export "${name}"`).toBeDefined();
			expect(typeof (argot as Record<string, unknown>)[name], `typeof "${name}"`).toBe(kind);
		}
	});

	it("pins the concrete values of the shipped constants", () => {
		expect(argot.DEFAULT_SIGIL).toBe("§");
		expect(argot.DICT_FILENAME).toBe("AGENTS.dict");
		expect(argot.DEFAULT_TOKEN_BUDGET).toBe(1000);
		expect(argot.SUPPORTED_VERSION).toBe(1);
		expect(argot.MAX_EXPANSION_BYTES).toBe(8192);
		expect(argot.ARGOT_LOAD_TOOL).toBe("argot_load");
		expect(argot.ARGOT_UNLOAD_TOOL).toBe("argot_unload");
		expect(argot.PROJECT_MARKERS).toEqual([".git", ".argot"]);
		expect(argot.EMPTY_GATE).toEqual({ models: [], disableAboveTokens: 0 });
	});

	it("exposes the model-matching predicate through the barrel with its two entry kinds", () => {
		// A harness (the eval runner) checks ahead of a run whether a gate's allowlist
		// would encode the model under test, using the SAME predicate the runtime gate
		// uses so the two cannot drift. Prove both entry kinds are reachable and behave:
		// a bare entry is a provider wildcard matching the id's last segment; a
		// provider-qualified entry (with a slash) matches only its exact id.
		expect(argot.modelAllowed("gemini-3.6-flash", "google-antigravity/gemini-3.6-flash")).toBe(true);
		expect(argot.modelAllowed("google-antigravity/gemini-3.6-flash", "google-antigravity/gemini-3.6-flash")).toBe(
			true,
		);
		expect(argot.modelAllowed("openai/gemini-3.6-flash", "google-antigravity/gemini-3.6-flash")).toBe(false);
		expect(argot.modelAllowed("flash", "google-antigravity/gemini-3.6-flash")).toBe(false);
		expect(argot.modelIdSegment("google-antigravity/gemini-3.6-flash")).toBe("gemini-3.6-flash");
		expect(argot.modelIdSegment("bare-id")).toBe("bare-id");
	});

	it("exposes constructible error and session classes through the barrel", () => {
		expect(new argot.ArgotParseError("x", "AGENTS.dict")).toBeInstanceOf(Error);
		expect(new argot.ArgotConflictError("x")).toBeInstanceOf(Error);
		expect(new argot.ArgotSession()).toBeInstanceOf(argot.ArgotSession);
	});

	it("exposes a working StreamDecoder through the barrel (the seam-3 primitive)", () => {
		// A consumer wires seam 3 entirely through the barrel; prove it is reachable
		// and inert on an empty vocabulary (identity passthrough).
		const decoder = argot.makeStreamDecoder(emptyVocab());
		expect(decoder).toBeInstanceOf(argot.StreamDecoder);
		expect(decoder.push("plain §db text")).toBe("plain §db text");
		expect(decoder.flush()).toBe("");
	});

	it("exposes makeExpander producing a callable expander through the barrel", () => {
		const expand = argot.makeExpander(emptyVocab());
		expect(typeof expand).toBe("function");
		expect(expand("no handles here")).toBe("no handles here");
	});
});

// Compile-time lock for the TYPE exports (invisible at runtime). If any of these
// type names is removed from the barrel, this block fails to type-check and the
// suite cannot build — the same drift protection the runtime set gives values.
import type {
	AgentDict,
	ArgotGate,
	ArgotGateInput,
	CorpusNotice,
	DecodeMeasurement,
	DecodeReplacement,
	GeneratedDict,
	GeneratedHandle,
	GenerateOptions,
	HandleMeta,
	HandleNaming,
	MakeGateOptions,
	PreambleOptions,
	ProjectVocabIO,
	ProjectVocabNotice,
	RepoFile,
	ResolveCacheOptions,
	ResolvedCache,
	ResolvedProjectVocab,
	ResolveProjectOptions,
	ResolveProjectVocabOptions,
} from "../src/index.js";

// A value typed as each imported type export, referenced so the imports are
// "used" and tsc must resolve every one of them.
type _TypeExportsPresent = [
	AgentDict,
	ArgotGate,
	ArgotGateInput,
	CorpusNotice,
	DecodeMeasurement,
	DecodeReplacement,
	GeneratedDict,
	GeneratedHandle,
	GenerateOptions,
	HandleMeta,
	HandleNaming,
	MakeGateOptions,
	PreambleOptions,
	ProjectVocabIO,
	ProjectVocabNotice,
	ResolveCacheOptions,
	ResolvedCache,
	ResolvedProjectVocab,
	ResolveProjectOptions,
	ResolveProjectVocabOptions,
	RepoFile,
	Vocabulary,
];

describe("argot public type surface", () => {
	it("re-exports every documented type through the barrel (enforced at compile time)", () => {
		// The assertion is the successful compilation of _TypeExportsPresent above;
		// this runtime check simply anchors the contract in the suite output.
		const typeExportCount: number = 22;
		expect(typeExportCount).toBe(22);
	});
});
