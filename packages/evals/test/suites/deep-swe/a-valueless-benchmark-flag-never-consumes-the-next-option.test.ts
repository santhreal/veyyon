/**
 * A valueless benchmark flag must leave the following option intact. The old parser
 * consumed `--tasks` as the value of `--dry-run`, silently expanding a one-task
 * smoke plan into the full corpus. This covers every flag registered as valueless;
 * it does not decide whether a newly introduced flag belongs in that registry.
 */
import { describe, expect, it } from "bun:test";
import { parseArgs, VALUELESS_FLAGS } from "../../../src/suites/deep-swe/runner/cli-args";

describe("valueless benchmark flags", () => {
	for (const flag of Object.keys(VALUELESS_FLAGS)) {
		it(`preserves the option following --${flag}`, () => {
			expect(parseArgs([`--${flag}`, "--tasks", "tasks/smoke.txt"])).toEqual({
				[flag]: "",
				tasks: "tasks/smoke.txt",
			});
		});
	}
});
