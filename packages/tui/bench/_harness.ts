/**
 * The bench harness the tui bench scripts use.
 *
 * It lives in `@veyyon/utils/bench-harness` because the coding-agent bench scripts need the same
 * loop and each package had written its own. Re-exported here so the bench scripts keep reading as
 * local imports.
 */
export { type BenchStats, benchFail, benchStats, makeBench } from "@veyyon/utils/bench-harness";
