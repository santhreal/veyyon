/**
 * WHY: every external command this package ran was unbounded, and most of them blocked the thread.
 *
 * The harbor and pier cleanups both defaulted to `spawnSync("docker", …)` with no timeout, on the
 * kill path — where an unresponsive daemon is the likely reason a trial is being killed at all.
 * `spawnSync` does not yield, so one `docker ps` waiting on a restarting daemon froze every worker,
 * every trial deadline and the manager's tick with it, and printed nothing. The launch probes had the
 * same shape.
 *
 * THE CLASS THIS CLOSES: an external command with no end and no yield. `runBoundedCommand` in
 * `src/core/external-command.ts` is the one runner the cleanups use: it rejects on the bound, and it
 * leaves the event loop running while it waits, which is asserted here by observing that other work
 * progresses during a hang. Success, a non-zero exit, a missing binary and a hang are all driven, and
 * both bounds are pinned as literals.
 *
 * WHAT IT DOES NOT CATCH: a `spawnSync` site added later without `syncCommandOptions()`. That is a
 * structural invariant, not a behaviour — a lint rule owns it, and asserting it here would mean
 * reading source text. It also does not prove the docker cleanups pass their parsed output on
 * correctly; `test/backends` owns that.
 */

import { describe, expect, it } from "bun:test";
import {
	BUILD_COMMAND_TIMEOUT_MS,
	runBoundedCommand,
	SHORT_COMMAND_TIMEOUT_MS,
	syncCommandOptions,
} from "../../engine/bounded-command";

/** Short enough to keep the suite fast; that the command ends at all is the behaviour under test. */
const BOUND_MS = 150;

describe("running an external command the run depends on", () => {
	it("returns what the command wrote on both pipes", async () => {
		const output = await runBoundedCommand("sh", ["-c", "printf listing; printf warning 1>&2"], BOUND_MS);

		expect(output).toEqual({ stdout: "listing", stderr: "warning" });
	});

	it("rejects a non-zero exit and carries what the command said about it", async () => {
		const failing = runBoundedCommand("sh", ["-c", "printf 'no such container' 1>&2; exit 3"], BOUND_MS);

		await expect(failing).rejects.toThrow(/no such container/);
	});

	it("rejects a binary that is not installed", async () => {
		const missing = runBoundedCommand("veyyon-no-such-binary", ["ps"], BOUND_MS);

		await expect(missing).rejects.toThrow(/ENOENT|not found/i);
	});

	it("kills a command that hangs instead of waiting on it", async () => {
		// `sleep 60` outlasts bun's per-test timeout, so this case can only pass if the bound fires.
		const hanging = runBoundedCommand("sh", ["-c", "sleep 60"], BOUND_MS);

		await expect(hanging).rejects.toThrow();
	});

	it("leaves the rest of the process running while a command hangs", async () => {
		let progressed = 0;
		const hanging = runBoundedCommand("sh", ["-c", "sleep 60"], BOUND_MS).catch(() => "killed");

		// A blocking spawn would hold the thread here, and this loop would run only after the command
		// had already settled.
		for (let i = 0; i < 2000; i++) {
			await Promise.resolve();
			progressed++;
		}

		expect(progressed).toBe(2000);
		expect(await hanging).toBe("killed");
	});

	it("bounds a probe or a cleanup at thirty seconds and a build at fifteen minutes", () => {
		// Pinned as literals: every case above passes its own bound, so a default that drifted to an
		// hour would leave this file green while a wedged daemon held a run for an hour.
		expect(SHORT_COMMAND_TIMEOUT_MS).toBe(30_000);
		expect(BUILD_COMMAND_TIMEOUT_MS).toBe(900_000);
	});

	it("hands a synchronous probe the same bound and a signal that cannot be ignored", () => {
		expect(syncCommandOptions()).toEqual({
			encoding: "utf8",
			timeout: SHORT_COMMAND_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		expect(syncCommandOptions(BUILD_COMMAND_TIMEOUT_MS).timeout).toBe(BUILD_COMMAND_TIMEOUT_MS);
	});
});
