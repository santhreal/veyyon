# Search Benchmark

The offline search benchmark measures local in-process dispatch latency, output byte size, arm agreement (parity), and declared answer expectations across three search representations: `files`, `text`, and `structure`.

Runs execute offline against deterministic synthetic corpora without making network requests or consuming model provider quota.

## Benchmark Axes

The benchmark defines three extensible axes populated by explicit registration in `packages/evals/src/benches/search/registry.ts`.

### 1. Corpora

A corpus defines a deterministic set of files written to a temporary directory on disk during benchmarking.

```typescript
import { registerSearchCorpus, type SearchCorpusSpec } from "./registry";

export const CUSTOM_CORPUS: SearchCorpusSpec = {
	id: "custom-fixture",
	description: "Fixture containing sample modules and configuration files.",
	files: {
		"src/index.ts": "export function main(): void {}\n",
		"package.json": JSON.stringify({ name: "fixture" }, null, 2),
	},
	limitations: [
		"Synthetic fixture does not contain deeply nested submodule trees.",
	],
};

registerSearchCorpus(CUSTOM_CORPUS);
```

### 2. Case Suites

A case suite pairs a corpus identifier with an array of query cases. Every case declares a search type, tool input parameters, and an explicit expectation.

```typescript
import { registerSearchCaseSuite, type SearchCaseSuite } from "./registry";

export const CUSTOM_SUITE: SearchCaseSuite = {
	id: "custom-suite",
	description: "Query cases verifying file and text matching on custom-fixture.",
	corpusId: "custom-fixture",
	cases: [
		{
			id: "custom_files_index",
			type: "files",
			description: "Find index.ts entrypoint",
			input: { type: "files", input: "src/index.ts" },
			expect: {
				mustMatchPaths: ["src/index.ts"],
				exactMatchedPaths: 1,
			},
		},
	],
	limitations: [
		"Evaluates file search path resolution on exact path queries.",
	],
};

registerSearchCaseSuite(CUSTOM_SUITE);
```

### 3. Arms

An arm provides an implementation of `SearchToolInput` execution. The runner passes a `SearchArmContext` containing an isolated `ToolSession` and the materialized corpus root directory.

```typescript
import { registerSearchArm, type SearchArm } from "./registry";

export const CUSTOM_ARM: SearchArm = {
	id: "custom-arm",
	description: "Alternative search tool implementation or candidate backend.",
	prepare(context) {
		return {
			run: async (callId, input, signal) => {
				// Execute search and return AgentToolResult
			},
			dispose: async () => {
				// Clean up resources after suite completion
			},
		};
	},
	limitations: [
		"Experimental arm bypasses schema pre-validation.",
	],
};

registerSearchArm(CUSTOM_ARM);
```

## Running the Benchmark

Execute all registered suites and arms:

```sh
bun run bench:search
```

Execute with explicit options:

```sh
# Run single iteration across all suites
bun packages/evals/src/benches/search/runner.ts --iterations 1

# Filter by query type
bun packages/evals/src/benches/search/runner.ts --type text

# Run specific suites and arms
bun packages/evals/src/benches/search/runner.ts --suite unified-search --arms unified-tool,direct-engine

# List registered corpora, case suites, and arms
bun packages/evals/src/benches/search/runner.ts --list

# Emit JSON report
bun packages/evals/src/benches/search/runner.ts --json report.json
```

Execute the progressive disclosure artifact compaction benchmark:

```sh
bun run bench:search:disclosure
```

The progressive disclosure benchmark evaluates `SearchTool` output compaction on large result sets, measuring inline reduction and verifying exact artifact recovery.

## Parity vs Correctness

The benchmark distinguishes between arm agreement (parity) and answer accuracy (correctness).

```
Candidate Arm ────┐
                  ├──> Compare outputs (Parity / Arm Agreement)
Reference Arm ────┤
                  └──> Verify against SearchExpectation (Correctness / Declared Answer)
```

- **Reference Arm and Agreement**: The runner selects a declared reference arm (`unified-tool` by default). Each candidate arm is compared against the reference arm for byte-identical content and matching structured details payloads. Parity confirms that a facade tool matches the underlying engine, but parity alone does not confirm that either arm found the correct files.
- **Correctness and Declared Answers**: Each case defines a `SearchExpectation` specifying required paths (`mustMatchPaths`), excluded paths (`mustNotMatchPaths`), minimum match counts (`minMatchedPaths`), or exact match counts (`exactMatchedPaths`). Correctness checks the reference arm output against the declared expectations to detect engine regressions where both arms agree on an incorrect result.

## Limitations

The limitations list reported by the benchmark is the deduplicated union of static baseline limitations (`SEARCH_BENCHMARK_LIMITATIONS`) and contributions declared by registered corpora, case suites, and arms.

The benchmark does not measure:

- Remote file systems, SSH targets, or network search latency (exercises local in-process dispatch).
- Model-side tool selection accuracy, prompt tokenization efficiency, or provider quota usage.
- Schema validation outside the local tool runner.
- Non-JavaScript/TypeScript languages for AST structural patterns (ast-grep native parser queries exercise JavaScript and TypeScript fixtures).
- Semantic ranking or relevance scoring (progressive disclosure fixtures measure output compaction and artifact spill mechanics).
