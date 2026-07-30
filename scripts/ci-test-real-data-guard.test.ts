import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	diffRealConfigRoot,
	isExternallyOwnedDatabaseSidecar,
	isLiveAppChurn,
	type LiveVeyyonOwnershipSnapshot,
	liveVeyyonProcessCount,
	SANDBOX_HOME,
	scanLiveVeyyonOwnership,
	snapshotRealConfigRoot,
} from "./ci-test-ts";

/**
 * The runner's third protection layer: after every test run it proves the real
 * veyyon data directory did not change. These tests exist because that proof is
 * itself a mechanism that can silently break — if the snapshot quietly returned
 * nothing, every run would report "clean" while damage went unnoticed, which is
 * the precise failure mode the layer was built to end.
 */
describe("real-data change detection", () => {
	function withRoot<T>(run: (root: string) => T): T {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-l3-"));
		try {
			return run(root);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}

	it("detects a file CREATED during the run", () => {
		withRoot(root => {
			const before = snapshotRealConfigRoot(root);
			fs.writeFileSync(path.join(root, "config.yml"), "profileSharing: false\n");
			const changes = diffRealConfigRoot(before, snapshotRealConfigRoot(root));
			expect(changes).toEqual([`CREATED  ${path.join(root, "config.yml")}`]);
		});
	});

	it("detects a file MODIFIED during the run", () => {
		withRoot(root => {
			const target = path.join(root, "install-id");
			fs.writeFileSync(target, "original");
			const before = snapshotRealConfigRoot(root);
			fs.writeFileSync(target, "tampered-with-different-length");
			expect(diffRealConfigRoot(before, snapshotRealConfigRoot(root))).toEqual([`MODIFIED ${target}`]);
		});
	});

	it("detects a file DELETED during the run, the least recoverable case", () => {
		withRoot(root => {
			const target = path.join(root, "shared-auth", "agent.db");
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, "credentials");
			const before = snapshotRealConfigRoot(root);
			fs.rmSync(target);
			expect(diffRealConfigRoot(before, snapshotRealConfigRoot(root))).toEqual([`DELETED  ${target}`]);
		});
	});

	it("reports NO change when nothing happened, so the check cannot cry wolf", () => {
		withRoot(root => {
			fs.mkdirSync(path.join(root, "shared-auth"), { recursive: true });
			fs.writeFileSync(path.join(root, "shared-auth", "agent.db"), "credentials");
			const before = snapshotRealConfigRoot(root);
			expect(diffRealConfigRoot(before, snapshotRealConfigRoot(root))).toEqual([]);
		});
	});

	it("ignores logs and session transcripts, which a LIVE veyyon writes during any run", () => {
		withRoot(root => {
			const before = snapshotRealConfigRoot(root);
			// Exactly what was observed during development: the developer's own running
			// session logging and saving transcripts while the suite ran. Reporting these
			// would train everyone to ignore the check.
			fs.mkdirSync(path.join(root, "profiles", "work", "logs"), { recursive: true });
			fs.writeFileSync(path.join(root, "profiles", "work", "logs", "veyyon.2026-07-24.log"), "{}\n");
			fs.mkdirSync(path.join(root, "profiles", "work", "agent", "sessions"), { recursive: true });
			fs.writeFileSync(path.join(root, "profiles", "work", "agent", "sessions", "s.jsonl"), "{}\n");
			expect(diffRealConfigRoot(before, snapshotRealConfigRoot(root))).toEqual([]);
		});
	});

	it("still watches the credential store inside a profile that also has logs", () => {
		withRoot(root => {
			const agentDir = path.join(root, "profiles", "work", "agent");
			fs.mkdirSync(path.join(root, "profiles", "work", "logs"), { recursive: true });
			fs.mkdirSync(agentDir, { recursive: true });
			const before = snapshotRealConfigRoot(root);
			fs.writeFileSync(path.join(root, "profiles", "work", "logs", "x.log"), "noise\n");
			fs.writeFileSync(path.join(agentDir, "agent.db"), "credentials");
			// The churn exclusion must be narrow: a database written next to an ignored
			// logs directory is still a violation.
			expect(diffRealConfigRoot(before, snapshotRealConfigRoot(root))).toEqual([
				`CREATED  ${path.join(agentDir, "agent.db")}`,
			]);
		});
	});

	it("classifies churn paths precisely, without swallowing similarly named ones", () => {
		const root = "/fake/.veyyon";
		expect(isLiveAppChurn(path.join(root, "logs", "a.log"), root)).toBe(true);
		expect(isLiveAppChurn(path.join(root, "profiles", "work", "agent", "sessions", "s.jsonl"), root)).toBe(true);
		expect(
			isLiveAppChurn(
				path.join(root, "profiles", "work", "run", "daemons", "host", "daemons", "costprobe", "meta.json"),
				root,
			),
		).toBe(true);
		// A file merely NAMED like a churn directory, or durable state beside it,
		// stays watched.
		expect(isLiveAppChurn(path.join(root, "logs.db"), root)).toBe(false);
		expect(isLiveAppChurn(path.join(root, "profiles", "work", "run", "state.json"), root)).toBe(false);
		expect(isLiveAppChurn(path.join(root, "shared-auth", "agent.db"), root)).toBe(false);
	});
});

describe("concurrent Veyyon session ownership", () => {
	const root = path.join(path.sep, "fake", ".veyyon");
	const database = path.join(root, "profiles", "work", "agent", "agent.db");
	const wal = `${database}-wal`;
	const shm = `${database}-shm`;

	function ownership(
		externalPaths: readonly string[],
		testPaths: readonly string[] = [],
	): LiveVeyyonOwnershipSnapshot {
		return {
			supported: true,
			external: [{ pid: 101, openRealPaths: new Set(externalPaths) }],
			testOwned: testPaths.length > 0 ? [{ pid: 202, openRealPaths: new Set(testPaths) }] : [],
		};
	}

	/**
	 * Prevents suffix-based suppression. A sidecar disappears only when one exact
	 * external process owns both it and the corresponding primary database.
	 */
	it("attributes only an exactly owned database sidecar", () => {
		const snapshot = ownership([database, wal]);
		expect(isExternallyOwnedDatabaseSidecar(wal, [snapshot])).toBe(true);
		expect(isExternallyOwnedDatabaseSidecar(shm, [snapshot])).toBe(false);
		expect(isExternallyOwnedDatabaseSidecar(database, [snapshot])).toBe(false);
		expect(isExternallyOwnedDatabaseSidecar(`${wal}.backup`, [snapshot])).toBe(false);
	});

	/**
	 * Locks out a mixed-owner escape. If a test descendant also owns the same
	 * database pair, the external owner cannot clear that actionable change.
	 */
	it("keeps a sidecar actionable when a test-owned process also holds it", () => {
		const snapshot = ownership([database, wal], [database, wal]);
		expect(isExternallyOwnedDatabaseSidecar(wal, [snapshot])).toBe(false);
	});

	/**
	 * Replays the observed workspace warning while proving durable changes remain
	 * visible in the same diff instead of being downgraded with the WAL noise.
	 */
	it("removes exact external WAL churn but preserves durable changes", () => {
		const config = path.join(root, "config.yml");
		const before = new Map([
			[database, "100:1"],
			[wal, "100:1"],
		]);
		const after = new Map([
			[database, "120:2"],
			[wal, "140:2"],
			[config, "20:2"],
		]);

		expect(diffRealConfigRoot(before, after, { ownership: [ownership([database, wal])] })).toEqual([
			`CREATED  ${config}`,
			`MODIFIED ${database}`,
		]);
	});

	/**
	 * Preserves the hard-failure path when no external ownership evidence exists.
	 * A WAL suffix by itself is never treated as proof.
	 */
	it("keeps sidecar changes visible without exact ownership evidence", () => {
		const before = new Map([[wal, "100:1"]]);
		const after = new Map([[wal, "140:2"]]);
		expect(diffRealConfigRoot(before, after)).toEqual([`MODIFIED ${wal}`]);
		expect(
			diffRealConfigRoot(before, after, {
				ownership: [{ supported: false, external: [], testOwned: [] }],
			}),
		).toEqual([`MODIFIED ${wal}`]);
	});
});

/**
 * Process discovery for the ownership proof above.
 *
 * The runner reads exact NUL-delimited environment markers to separate its own
 * descendants from external Veyyon sessions. It then records their real-root
 * file descriptors. A repository path in argv is not process identity, and an
 * environment-looking argv value is not an environment marker.
 */
describe("live-session attribution", () => {
	interface FakeProcess {
		cmdline: string;
		environment?: string;
		fds?: readonly string[];
	}

	function fakeProc(entries: Record<string, string | FakeProcess>): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-proc-"));
		for (const [pid, value] of Object.entries(entries)) {
			const processDir = path.join(dir, pid);
			const process = typeof value === "string" ? { cmdline: value } : value;
			fs.mkdirSync(processDir, { recursive: true });
			fs.writeFileSync(path.join(processDir, "cmdline"), process.cmdline);
			fs.writeFileSync(path.join(processDir, "environ"), process.environment ?? "");
			if (process.fds) {
				const fdDir = path.join(processDir, "fd");
				fs.mkdirSync(fdDir);
				process.fds.forEach((target, index) => {
					fs.symlinkSync(target, path.join(fdDir, String(index)));
				});
			}
		}
		return dir;
	}

	it("counts another veyyon process", () => {
		const proc = fakeProc({ "101": "/usr/local/bin/veyyon\u0000", "102": "/usr/bin/bash\u0000" });
		try {
			expect(liveVeyyonProcessCount(proc, 999)).toBe(1);
		} finally {
			fs.rmSync(proc, { recursive: true, force: true });
		}
	});

	it("counts zero when nothing veyyon-shaped is running", () => {
		// The case that keeps the hard failure meaningful: with no live session the
		// diff is unambiguous and must stay a violation.
		const proc = fakeProc({ "101": "/usr/bin/bash\u0000", "102": "/usr/bin/node server.js\u0000" });
		try {
			expect(liveVeyyonProcessCount(proc, 999)).toBe(0);
		} finally {
			fs.rmSync(proc, { recursive: true, force: true });
		}
	});

	it("ignores its own process", () => {
		// Without this the runner would always see itself and never fail, which would
		// silently disable the layer entirely.
		const proc = fakeProc({ "101": "/usr/local/bin/veyyon\u0000" });
		try {
			expect(liveVeyyonProcessCount(proc, 101)).toBe(0);
		} finally {
			fs.rmSync(proc, { recursive: true, force: true });
		}
	});

	/**
	 * Reproduces the production spawn contract: HOME is in `/proc/<pid>/environ`,
	 * not cmdline. This catches the impossible fixture that hid the original bug.
	 */
	it("ignores a Veyyon process carrying the sandbox environment marker", () => {
		const proc = fakeProc({
			"101": {
				cmdline: "/usr/local/bin/veyyon\u0000",
				environment: `HOME=${SANDBOX_HOME}\u0000`,
			},
		});
		try {
			expect(liveVeyyonProcessCount(proc, 999)).toBe(0);
		} finally {
			fs.rmSync(proc, { recursive: true, force: true });
		}
	});

	/**
	 * Enforces exact NUL-delimited environment equality so a developer whose home
	 * merely shares the sandbox prefix remains an external session.
	 */
	it("does not accept an environment marker prefix lookalike", () => {
		const proc = fakeProc({
			"101": {
				cmdline: "/usr/local/bin/veyyon\u0000",
				environment: `HOME=${SANDBOX_HOME}-other\u0000`,
			},
		});
		try {
			expect(liveVeyyonProcessCount(proc, 999)).toBe(1);
		} finally {
			fs.rmSync(proc, { recursive: true, force: true });
		}
	});

	/**
	 * Prevents argv text from impersonating the exact environment marker used for
	 * test ownership.
	 */
	it("does not read a sandbox-looking command argument as environment ownership", () => {
		const proc = fakeProc({ "101": `/usr/local/bin/veyyon\u0000HOME=${SANDBOX_HOME}\u0000` });
		try {
			expect(liveVeyyonProcessCount(proc, 999)).toBe(1);
		} finally {
			fs.rmSync(proc, { recursive: true, force: true });
		}
	});

	/**
	 * Keeps repository paths from making ordinary Bun tests look like external
	 * Veyyon sessions.
	 */
	it("requires a Veyyon entrypoint rather than a repository-name substring", () => {
		const proc = fakeProc({ "101": "/usr/bin/bun\u0000test\u0000/work/veyyon/scripts/example.test.ts\u0000" });
		try {
			expect(liveVeyyonProcessCount(proc, 999)).toBe(0);
		} finally {
			fs.rmSync(proc, { recursive: true, force: true });
		}
	});

	/**
	 * Proves the Linux ownership seam records exact open database and sidecar
	 * paths. A generic test helper is still test-owned through its environment,
	 * even though it is not a Veyyon entrypoint.
	 */
	it("captures exact real-root file descriptors for an external Veyyon process", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-owned-root-"));
		const database = path.join(root, "shared-auth", "agent.db");
		const wal = `${database}-wal`;
		const proc = fakeProc({
			"101": {
				cmdline: "/usr/local/bin/veyyon\u0000",
				environment: "HOME=/tmp/live-home\u0000",
				fds: [database, wal],
			},
			"202": {
				cmdline: "/usr/bin/test-helper\u0000",
				environment: `VEYYON_TEST_REAL_CONFIG_ROOT=${root}\u0000`,
				fds: [database, wal],
			},
		});
		try {
			const ownership = scanLiveVeyyonOwnership(proc, root, 999, SANDBOX_HOME);
			expect(ownership.supported).toBe(true);
			expect(ownership.external).toHaveLength(1);
			expect([...ownership.external[0]!.openRealPaths].sort()).toEqual([database, wal]);
			expect(ownership.testOwned).toHaveLength(1);
			expect([...ownership.testOwned[0]!.openRealPaths].sort()).toEqual([database, wal]);
		} finally {
			fs.rmSync(proc, { recursive: true, force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("assumes a session may be live when /proc cannot be read", () => {
		// macOS and Windows have no /proc. Claiming "nothing was running" there would
		// assert an attribution the platform cannot support, and would turn every
		// concurrent-session diff into a false violation.
		expect(liveVeyyonProcessCount("/nonexistent-proc-dir", 999)).toBe(1);
	});

	it("skips unreadable process entries rather than aborting the scan", () => {
		// A process that exits between readdir and readFile is normal, and it must not
		// take the whole detection with it.
		const proc = fakeProc({ "101": "/usr/local/bin/veyyon\u0000" });
		fs.mkdirSync(path.join(proc, "202"), { recursive: true });
		try {
			expect(liveVeyyonProcessCount(proc, 999)).toBe(1);
		} finally {
			fs.rmSync(proc, { recursive: true, force: true });
		}
	});
});
