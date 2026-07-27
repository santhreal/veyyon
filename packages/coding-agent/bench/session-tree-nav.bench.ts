/**
 * Benchmark: session-tree navigation context build (perf/sessiontree-dedupe-context-build)
 *
 * Measures the O(N) walk performed by buildSessionContext during navigateTree.
 * Demonstrates the dedupe win: one walk vs two walks per navigation.
 *
 * Run: bun packages/coding-agent/bench/session-tree-nav.bench.ts
 */

import { makeBench } from "@veyyon/utils/bench-harness";
// Both moved out of `session-manager.ts` (the context builder to `session-context.ts`, the entry union to
// `session-entries.ts`), which this script had not followed, so it had stopped running at all -- the same
// way the parse-key bench had. A bench that cannot start publishes nothing and says nothing about it.
import { buildSessionContext } from "../src/session/session-context";
import type { SessionEntry } from "../src/session/session-entries";

// ─── Synthetic session ───────────────────────────────────────────────────────

const MSG_COUNT = 100;
const CODE_BLOCKS_PER_MSG = 5;

function makeId(i: number): string {
	return `entry-${i.toString().padStart(6, "0")}`;
}

function makeCodeBlock(idx: number): string {
	return `\`\`\`typescript\nconst x${idx} = ${idx};\nconsole.log(x${idx});\n\`\`\``;
}

function buildEntries(): SessionEntry[] {
	const entries: SessionEntry[] = [];
	const now = new Date();

	for (let i = 0; i < MSG_COUNT; i++) {
		const id = makeId(i);
		const parentId = i === 0 ? null : makeId(i - 1);
		const timestamp = new Date(now.getTime() + i * 1000).toISOString();

		const codeBlocks = Array.from({ length: CODE_BLOCKS_PER_MSG }, (_, k) =>
			makeCodeBlock(i * CODE_BLOCKS_PER_MSG + k),
		).join("\n\n");

		if (i % 2 === 0) {
			// User message
			entries.push({
				type: "message",
				id,
				parentId,
				timestamp,
				message: {
					role: "user",
					content: `User message ${i}: please analyze this code.\n\n${codeBlocks}`,
				},
			} satisfies SessionEntry);
		} else {
			// Assistant message
			entries.push({
				type: "message",
				id,
				parentId,
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: `Assistant reply ${i}:\n\n${codeBlocks}` }],
				},
			} satisfies SessionEntry);
		}
	}

	return entries;
}

// ─── Bench helpers ────────────────────────────────────────────────────────────

const WARMUP = 20;
const ITERATIONS = 200;

// The shared harness, which runs the warmup this script used to run for itself. It was the only bench that
// already knew a cold first iteration distorts the reading, and that is now the default for every one of
// them. `bench` returns total elapsed milliseconds, so the per-navigation figures below divide by
// ITERATIONS rather than being handed a per-op number.
const bench = makeBench(ITERATIONS, { warmup: WARMUP });

// ─── Run ──────────────────────────────────────────────────────────────────────

const entries = buildEntries();
const leafId = makeId(MSG_COUNT - 1);

console.log(
	`\nBenchmark: session-tree-nav (${MSG_COUNT} messages, ${CODE_BLOCKS_PER_MSG} code blocks each, ${ITERATIONS} iterations)\n`,
);

// Baseline: two O(N) walks (old behaviour — navigateTree + renderInitialMessages each called buildSessionContext)
const twoWalks = bench("two walks   [BEFORE — old behaviour]", () => {
	buildSessionContext(entries, leafId);
	buildSessionContext(entries, leafId);
});

// Optimized: one O(N) walk (new behaviour — navigateTree returns context, renderInitialMessages reuses it)
const oneWalk = bench("one walk    [AFTER  — dedupe fix]    ", () => {
	buildSessionContext(entries, leafId);
});

const savedMs = (twoWalks - oneWalk) / ITERATIONS;
const pctSaved = (((twoWalks - oneWalk) / twoWalks) * 100).toFixed(1);
console.log(`\n  Saved ${savedMs.toFixed(4)}ms/navigation (${pctSaved}% reduction per navigate)\n`);
