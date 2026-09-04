/**
 * A valueless (boolean) flag must leave the following option intact.
 * A flag like `--dry-run` must not consume `--tasks` as its value.
 * This covers every flag registered as valueless in BOOLEAN_FLAGS.
 */
import { describe, expect, it } from "bun:test";
import { BOOLEAN_FLAGS, parseEvalsArgs } from "../../evals";

describe("valueless evals flags", () => {
	for (const flag of Object.keys(BOOLEAN_FLAGS)) {
		it(`preserves the option following ${flag}`, () => {
			const parsed = parseEvalsArgs([flag, "--tasks", "tasks/smoke.txt"]);
			expect(parsed.tasks).toEqual(["tasks/smoke.txt"]);
		});
	}
});
