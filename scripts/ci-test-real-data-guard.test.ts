import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	diffRealConfigRoot,
	isLiveAppChurn,
	liveVeyyonProcessCount,
	SANDBOX_HOME,
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
		// A file merely NAMED like a churn directory is watched, not ignored.
		expect(isLiveAppChurn(path.join(root, "logs.db"), root)).toBe(false);
		expect(isLiveAppChurn(path.join(root, "shared-auth", "agent.db"), root)).toBe(false);
	});
});

/**
 * Attribution for the diff above.
 *
 * The snapshot can tell that a file changed but not WHO changed it. A developer
 * running the suite with their own veyyon session open will see that session
 * refresh a token mid-run, and the diff reports it as a test writing to real
 * data. That false alarm actually happened, and a detector that cries wolf is
 * one people learn to ignore, which costs more than it saves.
 *
 * So the runner asks whether another veyyon is live and reports the same diff
 * either as a VIOLATION (nothing else was running, the tests did it) or as
 * UNATTRIBUTABLE (something else was running, close it and re-run for an
 * authoritative answer). The detection itself is never used to skip the check,
 * which is why these tests care about its bias: it must lean toward reporting a
 * live session, because calling a real violation unattributable is a far cheaper
 * mistake than declaring an innocent run guilty and teaching people to ignore
 * the alarm.
 */
describe("live-session attribution", () => {
	function fakeProc(entries: Record<string, string>): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-proc-"));
		for (const [pid, cmdline] of Object.entries(entries)) {
			fs.mkdirSync(path.join(dir, pid), { recursive: true });
			fs.writeFileSync(path.join(dir, pid, "cmdline"), cmdline);
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

	it("ignores processes carrying the sandbox HOME, which are the runner's own children", () => {
		// Test children are veyyon processes by name and would otherwise make every
		// run unattributable, defeating the check.
		const proc = fakeProc({ "101": `bun test\u0000HOME=${SANDBOX_HOME}\u0000` });
		try {
			expect(liveVeyyonProcessCount(proc, 999)).toBe(0);
		} finally {
			fs.rmSync(proc, { recursive: true, force: true });
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
