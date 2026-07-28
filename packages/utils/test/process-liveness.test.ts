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
	/** Invalid scalar and process-group IDs must not be mistaken for live individual processes. */
	test("rejects invalid and process-group pids without probing the operating system", () => {
		const kill = process.kill;
		const probed: number[] = [];
		try {
			process.kill = pid => {
				probed.push(pid);
				return true;
			};
			for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x80000000]) {
				expect(isProcessAlive(pid)).toBe(false);
				expect(getProcessStartIdentity(pid)).toBeNull();
				expect(isProcessInstanceAlive(pid, null)).toBe(false);
			}
			expect(probed).toEqual([]);
		} finally {
			process.kill = kill;
		}
	});

});

describe("cross-platform process incarnation identity", () => {
	/** Linux must parse field 22 after the comm terminator, even when comm contains spaces and `)`. */
	test("linux proc stat parsing preserves the exact boot and start-tick identity", () => {
		const bootId = "01234567-89ab-cdef-0123-456789abcdef";
		const fields = ["S", ...Array.from({ length: 18 }, () => "0"), "987654"];
		const dependencies: ProcessIdentityDependencies = {
			platform: "linux",
			readBoundedTextFile: filePath => {
				if (filePath === "/proc/sys/kernel/random/boot_id") return bootId;
				if (filePath === "/proc/4242/stat") return `4242 (worker ) name) ${fields.join(" ")}`;
				return null;
			},
			querySystem: () => null,
			queryDarwinProcessStart: () => null,
			queryWindowsProcessStart: () => null,
		};

		expect(getProcessStartIdentity(4242, dependencies)).toBe(
			"linux:01234567-89ab-cdef-0123-456789abcdef:987654",
		);
	});

	/** A malformed boot UUID or proc record must remain unverifiable rather than identify the wrong PID. */
	test("linux rejects malformed and substituted proc identity records", () => {
		let bootId = "01234567-89ab-cdef-0123-456789abcdef";
		let stat = `9999 (other) ${["S", ...Array.from({ length: 18 }, () => "0"), "123"].join(" ")}`;
		const dependencies: ProcessIdentityDependencies = {
			platform: "linux",
			readBoundedTextFile: filePath =>
				filePath === "/proc/sys/kernel/random/boot_id" ? bootId : stat,
			querySystem: () => null,
			queryDarwinProcessStart: () => null,
			queryWindowsProcessStart: () => null,
		};

		expect(getProcessStartIdentity(4242, dependencies)).toBeNull();
		stat = `4242 (owner) ${["S", ...Array.from({ length: 18 }, () => "0"), "123"].join(" ")}`;
		bootId = "0123456789abcdef0123456789abcdef0123";
		expect(getProcessStartIdentity(4242, dependencies)).toBeNull();
	});

	/** Out-of-range timeval microseconds must not create a plausible macOS process identity. */
	test("darwin rejects malformed timevals and canonicalizes numeric fields", () => {
		let bootTime = "{ sec = 001670000000, usec = 000123 }";
		let processStart = "001672628645.000456";
		const dependencies: ProcessIdentityDependencies = {
			platform: "darwin",
			readBoundedTextFile: () => null,
			querySystem: () => bootTime,
			queryDarwinProcessStart: () => processStart,
			queryWindowsProcessStart: () => null,
		};

		expect(getProcessStartIdentity(4242, dependencies)).toBe(
			"darwin:1670000000.123:1672628645.456",
		);
		processStart = "1672628645.1000000";
		expect(getProcessStartIdentity(4242, dependencies)).toBeNull();
		processStart = "1672628645.123456";
		bootTime = "{ sec = 1670000000, usec = 1000000 }";
		expect(getProcessStartIdentity(4242, dependencies)).toBeNull();
	});

	/** Windows FILETIME parsing must accept the uint64 domain but reject overflow and zero sentinels. */
	test("win32 validates the complete unsigned FILETIME boundary", () => {
		let processCreation = "00000000000000000001";
		const dependencies: ProcessIdentityDependencies = {
			platform: "win32",
			readBoundedTextFile: () => null,
			querySystem: () => null,
			queryDarwinProcessStart: () => null,
			queryWindowsProcessStart: () => processCreation,
		};

		expect(getProcessStartIdentity(5151, dependencies)).toBe("win32:1");
		processCreation = "18446744073709551615";
		expect(getProcessStartIdentity(5151, dependencies)).toBe("win32:18446744073709551615");
		processCreation = "18446744073709551616";
		expect(getProcessStartIdentity(5151, dependencies)).toBeNull();
		processCreation = "0";
		expect(getProcessStartIdentity(5151, dependencies)).toBeNull();
	});

	/** Identity I/O failures must fail closed so recovery cannot steal from a possibly-live owner. */
	test("dependency errors remain unverifiable and preserve a live process instance", () => {
		const dependencies: ProcessIdentityDependencies = {
			platform: "linux",
			readBoundedTextFile: () => {
				throw new Error("procfs became unavailable");
			},
			querySystem: () => null,
			queryDarwinProcessStart: () => null,
			queryWindowsProcessStart: () => null,
		};
		const kill = process.kill;
		try {
			process.kill = () => true;
			expect(getProcessStartIdentity(4242, dependencies)).toBeNull();
			expect(isProcessInstanceAlive(4242, "linux:owner", dependencies)).toBe(true);
		} finally {
			process.kill = kill;
		}
	});

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
