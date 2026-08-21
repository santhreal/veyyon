/**
 * WHY: the singleton/global-state bucket was the one coding-agent bucket with no
 * `chunkSize`, so its whole file list ran as a single `bun test` process. The
 * justification was that global-state suites have to share a process to exercise
 * process-wide state. They do not: the isolation such a suite needs is that
 * nothing runs BESIDE it, which is `parallel: 1`, and a chunk boundary is a
 * stronger guarantee than a shared heap. Left whole the bucket grew to 555 files,
 * far past the ~170-370-file OOM ceiling the runner's own comment records, and was
 * SIGKILLed with exit 137 on every CI run. It reported as a rotating handful of
 * unrelated TUI and MCP suites "failing" at 30-40s apiece under memory pressure,
 * every one of which passes on its own, so the real cause was invisible in the log
 * and main stayed red across several commits.
 *
 * The class this closes: a coding-agent bucket whose file list is handed to one
 * process, and therefore has no bound on peak RSS no matter how large the bucket
 * grows. It is closed at the plan table every bucket is built from, swept at run
 * time, so a bucket added later cannot reintroduce it. `chunkSize` is also
 * required by the type, which makes the same mistake a compile error; this suite
 * is what catches the runtime spellings a type cannot see (a zero, a negative, or
 * a number so large it is the file count in disguise).
 *
 * What it does NOT catch: a chunk size that is legal but still too big for a
 * future bucket's memory profile. Only a run can answer that, and the failure
 * mode is exit 137 with the chunk composition printed beside it.
 */
import { describe, expect, it } from "bun:test";
import { codingAgentBucketPlans } from "./ci-test-ts";

describe("coding-agent bucket plans", () => {
	// Swept from the table itself, so a bucket added later is covered without a
	// new case here and without this list going stale in silence.
	const buckets = Object.entries(codingAgentBucketPlans);

	it("covers every declared bucket", () => {
		expect(buckets.length).toBeGreaterThan(0);
	});

	it("bounds every bucket to a chunk, so none is handed to one process", () => {
		const unbounded = buckets.filter(([, plan]) => !Number.isInteger(plan.chunkSize) || plan.chunkSize < 1);
		expect(unbounded.map(([name]) => name)).toEqual([]);
	});

	it("keeps every chunk small enough to be a bound rather than a formality", () => {
		// The runner's measured ceiling is a single 170-370-file invocation. A chunk
		// an order of magnitude under that is a bound; one near it is the same
		// unchunked bucket wearing a number.
		const tooLarge = buckets.filter(([, plan]) => plan.chunkSize > 20);
		expect(tooLarge.map(([name, plan]) => `${name}=${plan.chunkSize}`)).toEqual([]);
	});

	it("runs every bucket serially, which is the isolation a global-state suite needs", () => {
		const concurrent = buckets.filter(([, plan]) => plan.parallel !== 1);
		expect(concurrent.map(([name]) => name)).toEqual([]);
	});
});
