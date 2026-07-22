import { describe, expect, it } from "bun:test";
import type { DaemonSnapshot } from "@veyyon/coding-agent/launch/protocol";
import { parseDaemonSnapshot } from "@veyyon/coding-agent/launch/protocol";
import { daemonLabel } from "@veyyon/coding-agent/tools/launch";

// WHY THIS SUITE EXISTS (BACKLOG DOG-2)
// -------------------------------------
// `launch stop` on a signal-killable process (e.g. `bash -c '...; sleep 60'`) used
// to report `exit=1`, hiding the real termination signal, because the broker only
// recorded the numeric exit from `process.exited` and never `process.signalCode`.
// The broker now captures the terminating signal into `DaemonSnapshot.signal`, it
// survives the IPC round-trip, and the label shows `signal=SIGTERM` instead of a
// misleading numeric code. These tests lock the serialization + display contract;
// the broker-side capture is exercised by the live launch path.

function baseSnapshot(overrides: Partial<DaemonSnapshot>): Record<string, unknown> {
	return {
		name: "job",
		id: "job-1",
		state: "exited",
		createdAt: 1,
		startedAt: 2,
		exitedAt: 3,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
		...overrides,
	};
}

describe("launch daemon signal termination reporting (DOG-2)", () => {
	it("round-trips the terminating signal through the IPC snapshot parser", () => {
		const parsed = parseDaemonSnapshot(baseSnapshot({ signal: "SIGTERM" }));
		expect(parsed.signal).toBe("SIGTERM");
	});

	it("leaves signal undefined for a clean numeric exit", () => {
		const parsed = parseDaemonSnapshot(baseSnapshot({ exitCode: 0 }));
		expect(parsed.signal).toBeUndefined();
		expect(parsed.exitCode).toBe(0);
	});

	it("labels a signal-terminated daemon with the signal, not a numeric exit", () => {
		const label = daemonLabel(parseDaemonSnapshot(baseSnapshot({ signal: "SIGTERM", exitCode: 1 })));
		expect(label).toContain("signal=SIGTERM");
		expect(label).not.toContain("exit=1");
	});

	it("still labels a genuine non-signal exit with its exit code", () => {
		const label = daemonLabel(parseDaemonSnapshot(baseSnapshot({ exitCode: 2 })));
		expect(label).toContain("exit=2");
		expect(label).not.toContain("signal=");
	});
});
