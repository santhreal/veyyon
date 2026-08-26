/**
 * Directory layout for the terminal-bench suite.
 *
 * The generic shapes are defined in `src/paths.ts`; this module states the suite name once and
 * derives every terminal-bench directory from it. A leaf module: it imports no other suite file, so
 * `dataset.ts` and `provenance.ts` can both read the suite name from here.
 */
import { suiteCacheDir, suiteDatasetDir } from "../../paths";

/** Registered name of the terminal-bench suite, and its directory name under `datasets/`. */
export const TERMINAL_BENCH_SUITE_NAME = "terminal-bench";

/** Extracted dataset directory for one dataset tag (`.cache/datasets/terminal-bench/<tag>`). */
export function terminalBenchDatasetDir(tag: string): string {
	return suiteCacheDir(TERMINAL_BENCH_SUITE_NAME, tag);
}

/** Curated task lists directory (`datasets/terminal-bench/tasks`). */
export function terminalBenchTaskListsDir(): string {
	return suiteDatasetDir(TERMINAL_BENCH_SUITE_NAME, "tasks");
}
