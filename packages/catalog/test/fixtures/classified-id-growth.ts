/**
 * Classifies distinct model ids through every function `@veyyon/catalog/identity` exports and prints,
 * as JSON, the heap and extra memory the classification left live in the process that runs this
 * file. argv[2] is how many ids of each family shape to classify.
 */
import { heapStats } from "bun:jsc";
import * as identity from "@veyyon/catalog/identity";

export interface ClassifiedGrowth {
	/** Exports that took each id, sorted. */
	classified: string[];
	/** Exports that threw on a lone id, sorted. */
	rejected: string[];
	/** Ids classified by each export. */
	ids: number;
	/** Heap and extra memory bytes live after the classification that were not before it. */
	grown: number;
}

/** One id shape per family parse and predicate, suffixed so no two ids are equal. */
const SHAPES: ReadonlyArray<(i: number) => string> = [
	i => `anthropic/Claude-Opus-4-${i % 9}-${i}`,
	i => `claude-5-sonnet-${i}`,
	i => `openai/GPT-5.${i % 9}-codex-${i}`,
	i => `gemini-2.${i % 9}-pro-${i}`,
	i => `zai-org/GLM-4.${i % 9}v-air-${i}`,
	i => `moonshotai/Kimi-K2.6-thinking-${i}`,
	i => `minimax/m2-${i}`,
	i => `qwen3-deepseek-mimo-gemma-3-${i}`,
	i => `grok-4.3-${i}`,
	i => `o3-mini-${i}`,
];

function live(): number {
	Bun.gc(true);
	Bun.gc(true);
	const stats = heapStats();
	return stats.heapSize + stats.extraMemorySize;
}

const perShape = Number(process.argv[2]);
const classified: Array<[string, (id: string) => unknown]> = [];
const rejected: string[] = [];
for (const [name, value] of Object.entries(identity)) {
	if (typeof value !== "function") continue;
	const fn = value as (id: string) => unknown;
	try {
		// Every shape once before the baseline, so state built once per process (the bundled
		// reference index, compiled patterns) is live on both sides of the measurement.
		for (const shape of SHAPES) fn(shape(perShape));
		classified.push([name, fn]);
	} catch {
		rejected.push(name);
	}
}

const before = live();
for (let i = 0; i < perShape; i++) {
	for (const shape of SHAPES) {
		const id = shape(i);
		for (const [, fn] of classified) fn(id);
	}
}
const grown = live() - before;

const result: ClassifiedGrowth = {
	classified: classified.map(([name]) => name).sort(),
	rejected: rejected.sort(),
	ids: perShape * SHAPES.length,
	grown,
};
process.stdout.write(JSON.stringify(result));
