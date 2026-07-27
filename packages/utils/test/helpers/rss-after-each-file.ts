/**
 * A `--preload` that reports this process's RSS after every test file it runs.
 *
 * Bun runs an `afterAll` registered in a preload once per test FILE, so a run
 * with this preloaded emits one line per file, in the order the files ran. That
 * is the only instrument that separates "this run peaked at N" from "each file
 * costs N", and the difference decides whether a memory problem is a leak or a
 * per-file cost. See `scripts/check-test-memory.ts`, which is the only caller,
 * and `docs/internal/testing.md` for what the two run modes do differently.
 *
 * The line is written to stderr rather than stdout so it cannot be confused with
 * a reporter's output, and it carries the pid because bun's default parallelism
 * runs files in several worker processes at once: without the pid the series
 * from four workers interleaves into one meaningless curve.
 */
import { afterAll } from "bun:test";

/** The prefix `scripts/check-test-memory.ts` parses. Changing it breaks that gate. */
export const RSS_REPORT_PREFIX = "RSS_AFTER_FILE";

afterAll(() => {
	process.stderr.write(`${RSS_REPORT_PREFIX} ${process.pid} ${process.memoryUsage.rss()}\n`);
});
