/**
 * Whether this process is running in CI, decided in one place.
 *
 * Two scripts asked the question and each answered it with its own copy of the same four
 * lines: `ci-test-ts.ts`, where the answer picks sequential chunks over local fan-out
 * because every bucket is a memory-capped runner job, and `run-rs-task.ts`, where it
 * decides whether a Rust task may skip work no change could have affected. Identical
 * copies of a predicate are how two callers end up disagreeing about the same fact.
 *
 * `CI=0` and `CI=false` mean not CI. Both spellings are set by people trying to turn CI
 * behavior OFF locally, and a bare truthiness check honors neither.
 *
 * This module deliberately imports nothing. `run-rs-task.ts` runs in the `Checks` Rust job,
 * which has no `bun install` step, so anything it reaches must resolve without workspace
 * symlinks — a relative import of a dependency-free file does; `@veyyon/...` would not.
 * `scripts/no-install-jobs-resolve-their-imports.test.ts` is the gate that holds that.
 */
export function isCI(): boolean {
	const value = Bun.env.CI;
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}
