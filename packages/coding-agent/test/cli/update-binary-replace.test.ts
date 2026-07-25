/**
 * Robustness of the self-update binary swap (replaceBinaryForUpdate) and its
 * pre-swap size guard. These lock the two gaps closed on 2026-07-21 where the
 * `veyyon update` binary path was weaker than install.sh's finalize_binary:
 *
 *   1. A junk (empty/missing) download must be refused BEFORE the live binary is
 *      touched, never renamed over it and rolled back afterwards. install.sh
 *      fails on `[ -s "$tmp" ]` before finalizing; the swap must do the same.
 *   2. A verification failure after a real swap must restore the exact previous
 *      binary and leave no temp behind.
 *
 * The verifier is injected, so the swap is exercised with real files and no
 * binary exec.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, promises as fsp, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { replaceBinaryForUpdate } from "../../src/cli/update-cli";

function sandbox(): { target: string; temp: string; backup: string } {
	const dir = mkdtempSync(path.join(tmpdir(), "veyyon-update-swap-"));
	return {
		target: path.join(dir, "veyyon"),
		temp: path.join(dir, "veyyon.new"),
		backup: path.join(dir, "veyyon.1.2.bak"),
	};
}

const okVerifier = () => Promise.resolve({ ok: true as const, actual: "9.9.9" });
const failVerifier = () => Promise.resolve({ ok: false as const, actual: "0.0.0" });

describe("replaceBinaryForUpdate size guard", () => {
	it("refuses an empty download without touching the installed binary", async () => {
		const { target, temp, backup } = sandbox();
		writeFileSync(target, "GOOD-INSTALLED-BINARY");
		writeFileSync(temp, ""); // 0-byte download (truncated but HTTP 200)

		await expect(
			replaceBinaryForUpdate({
				targetPath: target,
				tempPath: temp,
				backupPath: backup,
				expectedVersion: "9.9.9",
				verifyInstalledVersion: okVerifier,
			}),
		).rejects.toThrow(/empty/i);

		// The live binary is byte-for-byte untouched, no backup was ever made, and
		// the junk temp is cleaned up.
		expect(readFileSync(target, "utf8")).toBe("GOOD-INSTALLED-BINARY");
		expect(existsSync(backup)).toBe(false);
		expect(existsSync(temp)).toBe(false);
	});

	it("refuses a missing download without touching the installed binary", async () => {
		const { target, temp, backup } = sandbox();
		writeFileSync(target, "GOOD-INSTALLED-BINARY");
		// temp intentionally never written

		await expect(
			replaceBinaryForUpdate({
				targetPath: target,
				tempPath: temp,
				backupPath: backup,
				expectedVersion: "9.9.9",
				verifyInstalledVersion: okVerifier,
			}),
		).rejects.toThrow(/missing/i);

		expect(readFileSync(target, "utf8")).toBe("GOOD-INSTALLED-BINARY");
		expect(existsSync(backup)).toBe(false);
	});
});

describe("replaceBinaryForUpdate swap and rollback", () => {
	it("swaps a good download in and removes the backup when verification passes", async () => {
		const { target, temp, backup } = sandbox();
		writeFileSync(target, "OLD-BINARY");
		writeFileSync(temp, "NEW-BINARY");

		const verification = await replaceBinaryForUpdate({
			targetPath: target,
			tempPath: temp,
			backupPath: backup,
			expectedVersion: "9.9.9",
			verifyInstalledVersion: okVerifier,
		});

		expect(verification.ok).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("NEW-BINARY");
		expect(existsSync(temp)).toBe(false);
		expect(existsSync(backup)).toBe(false);
	});

	it("restores the previous binary and drops the temp when verification fails", async () => {
		const { target, temp, backup } = sandbox();
		writeFileSync(target, "OLD-BINARY");
		writeFileSync(temp, "BROKEN-NEW-BINARY");

		await expect(
			replaceBinaryForUpdate({
				targetPath: target,
				tempPath: temp,
				backupPath: backup,
				expectedVersion: "9.9.9",
				verifyInstalledVersion: failVerifier,
			}),
		).rejects.toThrow(/restored previous/i);

		// The exact original binary is back in place; no temp or backup litter.
		expect(readFileSync(target, "utf8")).toBe("OLD-BINARY");
		expect(existsSync(temp)).toBe(false);
		expect(existsSync(backup)).toBe(false);
	});
});

describe("replaceBinaryForUpdate rollback failure", () => {
	/**
	 * The worst case: the swap fails verification AND the automatic restore also
	 * fails (permission error, a locked destination, the backup file vanished
	 * mid-restore). Before this was hardened, the rollback error silently replaced
	 * the original failure (losing why the update failed), the temp download was
	 * left behind, and the user was stranded with NO binary at targetPath and no
	 * idea their previous one was sitting at backupPath. This locks the fail-loud
	 * contract: the thrown error names the manual recovery, the previous binary is
	 * left intact at the backup path exactly as the message says, the temp is
	 * cleaned, and the original failure is preserved as `cause`.
	 */
	it("fails loud with manual-recovery guidance and leaves the previous binary intact at the backup path", async () => {
		const { target, temp, backup } = sandbox();
		writeFileSync(target, "OLD-BINARY");
		writeFileSync(temp, "BROKEN-NEW-BINARY");

		// Let the two forward renames run (target->backup move-aside, temp->target
		// swap-in) but force the third (backup->target rollback) to fail.
		const realRename = fsp.rename.bind(fsp);
		let renameCalls = 0;
		const renameSpy = spyOn(fsp, "rename").mockImplementation(async (from, to) => {
			renameCalls += 1;
			if (renameCalls >= 3) throw new Error("simulated rollback rename failure (EACCES)");
			return realRename(from as string, to as string);
		});

		let caught: Error | undefined;
		try {
			await replaceBinaryForUpdate({
				targetPath: target,
				tempPath: temp,
				backupPath: backup,
				expectedVersion: "9.9.9",
				verifyInstalledVersion: failVerifier,
			});
		} catch (err) {
			caught = err as Error;
		} finally {
			renameSpy.mockRestore();
		}

		expect(caught).toBeDefined();
		expect(caught?.message).toMatch(/automatic rollback could not restore/i);
		// The message must point the user at both the intact backup and where it goes.
		expect(caught?.message).toContain(backup);
		expect(caught?.message).toContain(target);
		// The original verification failure is preserved, not masked by the rollback error.
		expect(caught?.cause).toBeDefined();
		// The previous binary is NOT lost: it is still at the backup path, byte-intact.
		expect(existsSync(backup)).toBe(true);
		expect(readFileSync(backup, "utf8")).toBe("OLD-BINARY");
		// The failed download is cleaned up even on the rollback-failure path.
		expect(existsSync(temp)).toBe(false);
		// The rollback was actually attempted (3 renames: move-aside, swap, restore).
		expect(renameCalls).toBe(3);
	});
});
