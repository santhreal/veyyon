import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isProcessAlive } from "../src/process-liveness";

describe("isProcessAlive", () => {
	test("reports this process as alive", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	test("reports a pid that cannot exist as dead", () => {
		// 0x7fffffff is above every platform's pid_max, so no process can hold it
		// and the kernel answers ESRCH.
		expect(isProcessAlive(0x7fffffff)).toBe(false);
	});

	test("reports an exited child as dead once it has been reaped", async () => {
		const child = Bun.spawn(["true"]);
		const pid = child.pid;
		await child.exited;

		expect(isProcessAlive(pid)).toBe(false);
	});

	test("treats a permission failure as alive, because EPERM means the process exists", () => {
		// REGRESSION and the reason this owner exists. Six of the seven hand-rolled
		// copies caught every error and reported dead. Signal 0 fails with EPERM for
		// a process owned by another user, which is the normal case in a container
		// or sandbox. Reporting that as dead let a caller reap a lock from a live
		// holder, admitting two processes to a critical section built for one.
		const kill = process.kill;
		try {
			process.kill = () => {
				const error = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			};
			expect(isProcessAlive(1234)).toBe(true);
		} finally {
			process.kill = kill;
		}
	});

	test("treats ESRCH as the only proof of death", () => {
		const kill = process.kill;
		try {
			process.kill = () => {
				const error = new Error("ESRCH: no such process") as NodeJS.ErrnoException;
				error.code = "ESRCH";
				throw error;
			};
			expect(isProcessAlive(1234)).toBe(false);
		} finally {
			process.kill = kill;
		}
	});

	test("treats an error with no code as alive rather than guessing death", () => {
		// Reaping is destructive and liveness alone should never authorize it: a
		// caller pairs this with a timestamp, so an unrecognized failure costs a
		// staleness window rather than a live owner's lock.
		const kill = process.kill;
		try {
			process.kill = () => {
				throw new Error("something unexpected");
			};
			expect(isProcessAlive(1234)).toBe(true);
		} finally {
			process.kill = kill;
		}
	});
});

describe("single-owner lock", () => {
	test("no package hand-rolls a signal-0 liveness probe of its own", async () => {
		// This predicate was duplicated seven times under three names, and the
		// copies disagreed on EPERM. If a new one appears, this fails and points at
		// the file so it can be re-pointed at the owner instead.
		// Anchored at the repo root, not cwd: a cwd-relative scan finds nothing when
		// the suite runs from inside a package and would pass without checking.
		const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
		const scan = Bun.spawnSync({
			cmd: [
				"rg",
				"--line-number",
				"--glob",
				"packages/**/src/**/*.ts",
				String.raw`process\.kill\([^,)]+,\s*0\)`,
				".",
			],
			cwd: repoRoot,
		});
		// rg exits 1 when it matches nothing and 2 on a real error (no rg, bad
		// glob). Only the first is a pass; the second must not read as one.
		expect(scan.exitCode).toBeLessThan(2);
		const hits = scan.stdout
			.toString()
			.split("\n")
			.filter(line => line.trim().length > 0)
			.filter(line => !line.includes("process-liveness.ts"));

		expect(hits).toEqual([]);
	});
});
