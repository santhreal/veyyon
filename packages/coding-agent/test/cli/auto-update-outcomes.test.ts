import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runAutoUpdate } from "../../src/cli/update-cli";

/**
 * Automatic update outcomes are consumed by a live TUI. Every operational
 * failure and non-fatal repair must arrive as data so the caller can render it
 * without raw console output or an unhandled rejection.
 */
describe("automatic update outcomes", () => {
	let dir = "";
	const release = { tag: "v9.9.9", version: "9.9.9" };
	const binaryInstall = () => "binary" as const;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-auto-update-outcome-"));
	});

	afterEach(async () => {
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	});

	/**
	 * An unusable state parent used to reject outside AutoUpdateOutcome. The
	 * startup continuation only logged that rejection, so the visible UI said
	 * nothing and stayed pinned to the old version.
	 */
	it("returns a visible failure when the state path cannot be read", async () => {
		const regularFile = path.join(dir, "not-a-directory");
		await fs.writeFile(regularFile, "blocks descendants");

		const outcome = await runAutoUpdate(
			"1.0.0",
			release,
			path.join(regularFile, "auto-update.json"),
			binaryInstall,
			async () => {
				throw new Error("installer must not run");
			},
		);

		expect(outcome.status).toBe("failed");
		expect(outcome).toMatchObject({ status: "failed", version: "9.9.9" });
		if (outcome.status === "failed") expect(outcome.error).toContain("ENOTDIR");
	});

	/**
	 * Completion refresh failures happen after the verified binary is installed.
	 * They must not relabel that install as failed, but the TUI still needs the
	 * exact warning so it can tell the user to regenerate stale completions.
	 */
	it("carries non-fatal install warnings on a successful update", async () => {
		const warning = "Could not refresh the shell completion at /tmp/veyyon.fish";
		const outcome = await runAutoUpdate(
			"1.0.0",
			release,
			path.join(dir, "auto-update.json"),
			binaryInstall,
			async () => ({ warnings: [warning] }),
		);

		expect(outcome).toEqual({ status: "updated", version: "9.9.9", warnings: [warning] });
	});

	/** A healthy install carries an explicit empty warning set, never stale data. */
	it("returns no warnings when every update follow-up succeeds", async () => {
		const outcome = await runAutoUpdate(
			"1.0.0",
			release,
			path.join(dir, "auto-update.json"),
			binaryInstall,
			async () => ({ warnings: [] }),
		);

		expect(outcome).toEqual({ status: "updated", version: "9.9.9", warnings: [] });
	});
});
