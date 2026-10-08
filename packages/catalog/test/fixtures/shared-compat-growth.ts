/**
 * Shares argv[2] distinct compat-shaped records through `shareCompat`, 500 per event-loop turn as
 * a registry rebuild would, drops every reference to them, and prints, as JSON, the heap and extra
 * memory the sharing left live in the process that runs this file.
 *
 * A `WeakRef` keeps its target alive until the turn that created it ends, so records shared in one
 * turn are collectable only in the next.
 */
import { heapStats } from "bun:jsc";
import { setTimeout as sleep } from "node:timers/promises";
import { shareCompat } from "../../src/compat/share";

export interface SharedGrowth {
	/** Records shared, each with a shape no other record has. */
	records: number;
	/** Heap and extra memory bytes live after the records were dropped that were not before. */
	grown: number;
}

const PER_TURN = 500;

async function live(): Promise<number> {
	Bun.gc(true);
	await sleep(0);
	Bun.gc(true);
	const stats = heapStats();
	return stats.heapSize + stats.extraMemorySize;
}

/** Shares `count` distinct records, each with a nested map and a 256-character field. */
async function shareDistinct(count: number, offset: number): Promise<void> {
	for (let start = 0; start < count; start += PER_TURN) {
		for (let i = start; i < Math.min(count, start + PER_TURN); i++) {
			shareCompat({
				supportsStore: i % 2 === 0,
				maxTokensField: `max_tokens_${offset + i}_${"x".repeat(240)}`,
				reasoningEffortMap: { low: `low-${offset + i}`, high: "high" },
			});
		}
		Bun.gc(true);
		await sleep(0);
	}
}

// One pass before the baseline, so the table and compiled code are live on both sides.
await shareDistinct(PER_TURN, 0);
const records = Number(process.argv[2]);
const before = await live();
await shareDistinct(records, 1_000_000);
const grown = (await live()) - before;

const result: SharedGrowth = { records, grown };
process.stdout.write(JSON.stringify(result));
