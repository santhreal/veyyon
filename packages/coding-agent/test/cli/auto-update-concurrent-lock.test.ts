import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, promises as fsp, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runAutoUpdate } from "../../src/cli/update-cli";

/**
 * Two launches must never install over each other.
 *
 * The background auto-update fires on startup, and nothing stops two terminals
 * from starting within the same second. Both would see the same newer release,
 * both would download it, and both would run the binary swap: two processes
 * renaming the same target and the same backup path at the same time. The
 * interleavings that produces range from a wasted download to a target that has
 * been renamed away by the other process mid-swap, which is how a self-update
 * leaves a machine with no binary at all.
 *
 * The state file doubles as the lock, so exclusion and the failure record share
 * one owner and cannot disagree about whether an install is in flight. This
 * suite races two `runAutoUpdate` calls against the same state path and asserts
 * the outcome that matters: exactly ONE install ran.
 *
 * The installer is injected. A race test cannot download a release twice, and
 * counting invocations is the only way to prove the second caller was actually
 * excluded rather than merely reporting that it was.
 */
describe("two concurrent auto-updates", () => {
	let dir = "";
	let statePath = "";

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "veyyon-autoupdate-lock-"));
		statePath = path.join(dir, "auto-update.json");
	});

	afterEach(async () => {
		if (dir) {
			await fsp.rm(dir, { recursive: true, force: true });
			dir = "";
		}
	});

	const release = { version: "9.9.9" } as Parameters<typeof runAutoUpdate>[1];
	const binaryInstall = () => "binary" as const;

	/**
	 * An installer that reports when it started and blocks so the second caller
	 * is guaranteed to arrive while the first still holds the lock. Without the
	 * gate the race is decided by scheduling and the test passes for the wrong
	 * reason on a fast machine.
	 */
	function gatedInstaller() {
		let calls = 0;
		let release!: () => void;
		const started = Promise.withResolvers<void>();
		const blocked = new Promise<void>(resolve => {
			release = resolve;
		});
		return {
			get calls() {
				return calls;
			},
			started: started.promise,
			finish: release,
			install: async () => {
				calls++;
				started.resolve();
				await blocked;
			},
		};
	}

	/**
	 * The core case. The second caller must not install, and must say why rather
	 * than reporting a successful update it did not perform.
	 */
	it("lets exactly one install run and tells the other one what happened", async () => {
		const installer = gatedInstaller();

		const first = runAutoUpdate("1.0.0", release, statePath, binaryInstall, installer.install);
		await installer.started;
		const second = await runAutoUpdate("1.0.0", release, statePath, binaryInstall, installer.install);

		expect(second.status).toBe("skipped");
		expect(second).toMatchObject({ reason: "another-process", version: "9.9.9" });
		// The assertion the whole suite exists for: the second caller did NOT
		// download or swap anything.
		expect(installer.calls).toBe(1);

		installer.finish();
		expect(await first).toMatchObject({ status: "updated", version: "9.9.9" });
		expect(installer.calls).toBe(1);
	});

	/**
	 * The lock has to be released when the winner finishes, or the first update
	 * of the day would block every launch after it for the whole stale window.
	 */
	it("releases the lock so a later attempt can install", async () => {
		const installer = gatedInstaller();
		const first = runAutoUpdate("1.0.0", release, statePath, binaryInstall, installer.install);
		await installer.started;
		installer.finish();
		await first;

		let laterCalls = 0;
		const later = await runAutoUpdate("1.0.0", release, statePath, binaryInstall, async () => {
			laterCalls++;
		});

		expect(later.status).toBe("updated");
		expect(laterCalls).toBe(1);
	});

	/**
	 * A failed install must release the lock too. A crash that left it held would
	 * silently disable auto-update for the stale window, which is the failure
	 * nobody notices because the symptom is "nothing happened".
	 */
	it("releases the lock after the install fails", async () => {
		const failed = await runAutoUpdate("1.0.0", release, statePath, binaryInstall, async () => {
			throw new Error("install died halfway");
		});
		expect(failed).toMatchObject({ status: "failed", version: "9.9.9" });

		// The failure is recorded, which is what the cooldown reads, so a retry of
		// the SAME version is deliberately skipped rather than blocked by a lock.
		expect(existsSync(statePath)).toBe(true);
		let retryCalls = 0;
		const retry = await runAutoUpdate("1.0.0", release, statePath, binaryInstall, async () => {
			retryCalls++;
		});
		expect(retry).toMatchObject({ status: "skipped", reason: "recent-failure" });
		expect(retryCalls).toBe(0);

		// A DIFFERENT version is not under that cooldown, and proves the lock is
		// free rather than the retry merely being suppressed.
		let nextCalls = 0;
		const next = await runAutoUpdate(
			"1.0.0",
			{ version: "9.9.10" } as typeof release,
			statePath,
			binaryInstall,
			async () => {
				nextCalls++;
			},
		);
		expect(next).toMatchObject({ status: "updated", version: "9.9.10" });
		expect(nextCalls).toBe(1);
	});

	/**
	 * Three at once is the shape a shell startup script actually produces when a
	 * terminal multiplexer restores a session. Two-way exclusion that broke down
	 * at three would still corrupt a binary.
	 */
	it("excludes every extra caller, not just the second", async () => {
		const installer = gatedInstaller();
		const first = runAutoUpdate("1.0.0", release, statePath, binaryInstall, installer.install);
		await installer.started;

		const others = await Promise.all([
			runAutoUpdate("1.0.0", release, statePath, binaryInstall, installer.install),
			runAutoUpdate("1.0.0", release, statePath, binaryInstall, installer.install),
		]);

		expect(others.map(outcome => outcome.status)).toEqual(["skipped", "skipped"]);
		expect(installer.calls).toBe(1);
		installer.finish();
		await first;
	});

	/**
	 * Nothing is installed and no lock is taken when there is nothing to do.
	 * Without this the suite would pass against an implementation that ran an
	 * install on every launch.
	 */
	it("installs nothing when the current version is already the latest", async () => {
		let calls = 0;
		const outcome = await runAutoUpdate("9.9.9", release, statePath, binaryInstall, async () => {
			calls++;
		});

		expect(outcome.status).toBe("up-to-date");
		expect(calls).toBe(0);
	});
});
