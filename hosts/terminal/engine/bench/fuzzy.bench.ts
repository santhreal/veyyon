/**
 * Fuzzy-filter performance harness.
 *
 * Models the realistic interactive cost: a user TYPES a query one keystroke at
 * a time, and every keystroke re-filters the SAME stable candidate list (the
 * model selector / settings selector / file-tree selector scenario). The warm
 * session is the primary metric because that is the user-facing latency.
 *
 * `fuzzyMatch` rebuilds a `SearchIndex` (normalize + index) per item per call
 * with no cross-call reuse, so the warm session currently pays N index rebuilds
 * on EVERY keystroke. The optimization target is to memoize that pure build.
 *
 * Guards:
 *   - Golden ranking checksums for a fixed corpus + queries. Any scoring drift
 *     (e.g. a bad cache) fails the harness with a non-zero exit.
 *   - A cold/unique-text pass with no possible reuse, so cache overhead can't
 *     hide a cold-path regression.
 */
import { fuzzyFilter, fuzzyRank, resetFuzzyIndexCache } from "@veyyon/utils/fuzzy";
import { makeLcg, median, timeRuns } from "./_harness";

// ─── Deterministic corpus ───────────────────────────────────────────────────
// Base model IDs × variant tags (real catalogs look exactly like this), plus a
// spread of repo file paths for length/structure variety. Built identically on
// every run so the golden checksums stay valid.

const BASES = [
	"openai/gpt-4o",
	"openai/gpt-4o-mini",
	"openai/gpt-4.1",
	"openai/gpt-4.1-mini",
	"openai/gpt-4-turbo",
	"openai/gpt-5",
	"openai/gpt-5-mini",
	"openai/o3",
	"openai/o3-mini",
	"openai/o4-mini",
	"anthropic/claude-3.5-sonnet",
	"anthropic/claude-3.5-haiku",
	"anthropic/claude-3-7-sonnet",
	"anthropic/claude-3-opus",
	"anthropic/claude-4-sonnet",
	"anthropic/claude-4-opus",
	"anthropic/claude-4.5-sonnet",
	"google/gemini-2.0-flash",
	"google/gemini-2.5-pro",
	"google/gemini-2.5-flash",
	"google/gemini-1.5-pro",
	"meta/llama-3.3-70b",
	"meta/llama-3.1-405b",
	"meta/llama-4-scout",
	"meta/llama-4-maverick",
	"mistral/mistral-large",
	"mistral/codestral",
	"deepseek/deepseek-v3",
	"deepseek/deepseek-r1",
	"xai/grok-3",
	"xai/grok-4",
	"qwen/qwen3-coder",
	"qwen/qwen3-235b",
	"qwen/qwen-max",
	"amazon/nova-pro",
];
const VARIANTS = [
	"",
	"-2024-06-01",
	"-2025-03-01",
	"-latest",
	"-preview",
	"-0513",
	"-0806",
	"-fp8",
	"-q4-k-m",
	"-32k",
	"-128k",
];
const FILES = [
	"src/components/markdown.ts",
	"src/tools/read.ts",
	"src/tools/text-search.ts",
	"src/utils/git.ts",
	"src/modes/theme/theme.ts",
	"src/system-prompt.ts",
	"src/workspace-tree.ts",
	"packages/tui/src/fuzzy.ts",
	"packages/tui/src/autocomplete.ts",
	"packages/tui/src/utils.ts",
	"crates/veyyon-natives/src/grep.rs",
	"crates/veyyon-ast/src/summary.rs",
	"crates/veyyon-shell/src/shell.rs",
	"packages/coding-agent/src/tools/write.ts",
	"packages/coding-agent/src/tools/bash.ts",
];

function buildCorpus(): string[] {
	const out: string[] = [];
	for (const b of BASES) for (const v of VARIANTS) out.push(b + v);
	for (const f of FILES) out.push(f);
	return out;
}

// ─── Golden ranking checksums (ranking-drift guard) ─────────────────────────
// FNV-1a/32 over the joined ranked output for each query. Any scoring change
// — including an incorrect cache — fails the harness.

function fnv1a(str: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

const GOLDENS: Record<string, string> = {
	gpt4: "cb4c08c",
	claude: "a424a682",
	rs: "c85f61bc",
	src: "b81a34b9",
	"deepseek r1": "6f6aad2d",
	son: "79c9d65f",
	o3: "4a34b147",
	"4o": "b49f44ac",
	"0513": "563822f3",
};

function assertGolden(corpus: string[]): void {
	let failed = false;
	for (const [query, golden] of Object.entries(GOLDENS)) {
		const out = fuzzyRank(corpus, query, t => t)
			.map(r => r.item)
			.join("\n");
		const hash = fnv1a(out);
		if (hash !== golden) {
			console.error(`GOLDEN MISMATCH for "${query}": expected ${golden}, got ${hash}`);
			failed = true;
		}
	}
	if (failed) {
		console.error("Ranking drifted — aborting. The harness results must stay byte-identical.");
		process.exit(1);
	}
}

// ─── Workloads ──────────────────────────────────────────────────────────────

const KEYSTROKES = ["g", "gp", "gpt", "gpt4", "gpt4o", "gpt4o-", "gpt4o-m", "gpt4o-mini"];

function warmSession(corpus: string[]): void {
	for (const q of KEYSTROKES) fuzzyFilter(corpus, q, t => t);
}

function coldUniqueCorpus(rng: () => number): string[] {
	const out: string[] = [];
	for (let i = 0; i < 400; i++) {
		out.push(`model-${(rng() * 1e9) | 0}-${i}-v${(i * 7) % 13}`);
	}
	return out;
}

// ─── Main ───────────────────────────────────────────────────────────────────

const corpus = buildCorpus();
assertGolden(corpus);

const WARM_REPS = 21;
const COLD_REPS = 21;
const COLD_SEED = 0xc0ffee;

const JIT_WARMUP_CORPUS: string[] = Array.from({ length: 400 }, (_, i) => `jit-warmup-entry-${i}-alpha-beta-gamma`);
for (let i = 0; i < 5; i++) for (const q of ["jit", "warmup", "entry"]) fuzzyFilter(JIT_WARMUP_CORPUS, q, t => t);

const warmSamples = timeRuns(WARM_REPS, () => {
	resetFuzzyIndexCache();
	warmSession(corpus);
});
const warmMedian = median(warmSamples);

const coldRng = makeLcg(COLD_SEED);
for (let i = 0; i < 3; i++) {
	fuzzyFilter(coldUniqueCorpus(coldRng), "model", t => t);
}
const coldSamples: number[] = [];
const coldRng2 = makeLcg(COLD_SEED + 1);
for (let r = 0; r < COLD_REPS; r++) {
	const c = coldUniqueCorpus(coldRng2);
	const t0 = performance.now();
	fuzzyFilter(c, "model", t => t);
	coldSamples.push(performance.now() - t0);
}
const coldMedian = median(coldSamples);

console.log(`fuzzy benchmark — corpus ${corpus.length} items, ${KEYSTROKES.length} keystrokes\n`);
console.log(`warm incremental-typing session: ${warmMedian.toFixed(4)}ms (median of ${WARM_REPS})`);
console.log(`cold unique-text single filter:   ${coldMedian.toFixed(4)}ms (median of ${COLD_REPS})`);
console.log("");
console.log(`METRIC fuzzy_warm_ms=${warmMedian.toFixed(4)}`);
console.log(`METRIC fuzzy_cold_ms=${coldMedian.toFixed(4)}`);
