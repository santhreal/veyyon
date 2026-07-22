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
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
