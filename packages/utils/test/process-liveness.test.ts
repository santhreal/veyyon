import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	getProcessStartIdentity,
	isProcessAlive,
	isProcessInstanceAlive,
	type ProcessIdentityDependencies,
} from "../src/process-liveness";
import { scanShippedSourceLines } from "./support/scan-shipped-source";

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

describe("cross-platform process incarnation identity", () => {
	/** macOS keeps a live owner when boot/start match, but exposes PID reuse for orphan recovery. */
	test("darwin boot and process-start queries distinguish a reused live PID", () => {
		let processStart = "1672628645.123456";
		const dependencies: ProcessIdentityDependencies = {
			platform: "darwin",
			readBoundedTextFile: () => null,
			querySystem: executable =>
				executable === "/usr/sbin/sysctl" ? "{ sec = 1670000000, usec = 123456 }" : null,
			queryDarwinProcessStart: () => processStart,
			queryWindowsProcessStart: () => null,
		};
		const kill = process.kill;
		try {
			process.kill = () => true;
			const ownerIdentity = getProcessStartIdentity(4242, dependencies);
			expect(ownerIdentity).toBe("darwin:1670000000.123456:1672628645.123456");
			expect(isProcessInstanceAlive(4242, ownerIdentity, dependencies)).toBe(true);
			processStart = "1672715045.123456";
			expect(isProcessInstanceAlive(4242, ownerIdentity, dependencies)).toBe(false);

			// Query failure cannot prove reuse and therefore must not steal from a
			// possibly-live owner.
			processStart = "";
			expect(isProcessInstanceAlive(4242, ownerIdentity, dependencies)).toBe(true);
		} finally {
			process.kill = kill;
		}
	});

	/** Windows FILETIME preserves a live owner and makes a reused PID reapable without a shell. */
	test("win32 native process-start queries distinguish a reused live PID", () => {
		let processCreation = "133485518451234560";
		const dependencies: ProcessIdentityDependencies = {
			platform: "win32",
			readBoundedTextFile: () => null,
			querySystem: () => null,
			queryDarwinProcessStart: () => null,
			queryWindowsProcessStart: () => processCreation,
		};
		const kill = process.kill;
		try {
			process.kill = () => true;
			const ownerIdentity = getProcessStartIdentity(5151, dependencies);
			expect(ownerIdentity).toBe("win32:133485518451234560");
			expect(isProcessInstanceAlive(5151, ownerIdentity, dependencies)).toBe(true);

			processCreation = "133485518461234560";
			expect(isProcessInstanceAlive(5151, ownerIdentity, dependencies)).toBe(false);
		} finally {
			process.kill = kill;
		}
	});

	/** A failed Windows native query cannot prove reuse and therefore cannot steal a live owner's lease. */
	test("win32 native query failure remains fail-closed", () => {
		let processCreation: string | null = "133485518451234560";
		const dependencies: ProcessIdentityDependencies = {
			platform: "win32",
			readBoundedTextFile: () => null,
			querySystem: () => null,
			queryDarwinProcessStart: () => null,
			queryWindowsProcessStart: () => processCreation,
		};
		const kill = process.kill;
		try {
			process.kill = () => true;
			const ownerIdentity = getProcessStartIdentity(6161, dependencies);
			processCreation = null;
			expect(isProcessInstanceAlive(6161, ownerIdentity, dependencies)).toBe(true);
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
		// the suite runs from inside a package and would pass without checking. The
		// scan is a self-contained file walk (no external `rg`, which is absent on
		// GitHub-hosted runners and used to throw here, red-lining the release gate).
		const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
		const hits = scanShippedSourceLines(repoRoot, /process\.kill\([^,)]+,\s*0\)/).filter(
			line => !line.includes("process-liveness.ts"),
		);

		expect(hits).toEqual([]);
	});
});
