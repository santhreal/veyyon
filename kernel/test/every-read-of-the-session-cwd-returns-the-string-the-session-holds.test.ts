/**
 * Every read of the session cwd returns the one string the session holds.
 *
 * WHY THIS SUITE EXISTS. `SessionManager.getCwd` returned `path.resolve(this.#cwd)`, a new string on
 * every call. A transcript row keeps the cwd its tool call rendered against, so a resumed 600-turn
 * session held 1,599 copies of one directory path, 148 KiB, one per tool row. The field is now a
 * private accessor whose setter resolves every write, and `getCwd` returns the field.
 *
 * The class it closes: a cwd read that allocates a copy of a value the session already holds. A heap
 * snapshot counts the distinct string cells behind each group of reads: `getCwd` after a relative
 * seed, `setCwd(".")` and the reads after it, `setCwd` to another directory with the value its cwd
 * listener received and the header cwd, and the reads after `restoreState` of a relative cwd. Each
 * group holds one cell, and the seed and the no-move `setCwd` share it. Every value is absolute and
 * names the directory the operation selected.
 *
 * WHAT IT DOES NOT CATCH: a caller outside `SessionManager` that resolves or copies the cwd it reads
 * before keeping it.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { READ_GROUPS, type SessionCwdReport } from "./fixtures/session-cwd-reads";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "session-cwd-reads.ts");

function report(): { cwd: string; report: SessionCwdReport } {
	const cwd = path.join(import.meta.dirname, "..");
	const run = spawnSync(process.execPath, [FIXTURE], { cwd, encoding: "utf8" });
	if (run.status !== 0) throw new Error(`session cwd fixture exited ${run.status}: ${run.stderr}`);
	return { cwd, report: JSON.parse(run.stdout) as SessionCwdReport };
}

describe("every read of the session cwd returns the string the session holds", () => {
	const { cwd, report: result } = report();
	const seed = path.resolve(cwd, result.seed);
	const moved = path.resolve(seed, result.other);

	it("returns one string cell for every read in each group", () => {
		for (const group of READ_GROUPS) expect({ group, cells: result.cells[group] }).toEqual({ group, cells: 1 });
		expect(result.seedAndSameDirectoryCells).toBe(1);
	});

	it("returns the absolute directory each operation selected", () => {
		expect(result.values).toEqual({
			seed: [seed, seed, seed],
			sameDirectory: [seed, seed],
			moved: [moved, moved, moved, moved],
			restored: [seed, seed],
		});
	});
});
