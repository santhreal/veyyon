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
import { existsSync, promises as fsp, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { ownerReceiptBodyFor, ownerReceiptFor } from "../../../../scripts/install-tests/installer-artifacts";
import { replaceBinaryForUpdate } from "../../src/cli/update-cli";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirs("veyyon-update-swap-");

function sandbox(): { target: string; temp: string; backup: string } {
	const dir = makeTempDir();
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

describe("replaceBinaryForUpdate keeps the installer's ownership receipt honest", () => {
	/**
	 * The installer's sidecar records a sha256 of the artifact it was written for,
	 * and `install.sh` accepts it only while the file at that path still matches.
	 * That is what stops a receipt orphaned by a hand-deleted binary from handing
	 * ownership of the next unrelated file to take the name.
	 *
	 * It also makes this swap the updater's problem. There is no way to tell "the
	 * updater replaced the file" from "the user replaced the file" from the
	 * outside: after either one the path holds a file the installer never saw and
	 * the sidecar is untouched. So the replacer records. Skip it and every user
	 * who has auto-updated is refused by their own installer, which would be a
	 * worse bug than the one the receipt closes.
	 *
	 * Both directions are asserted. A rollback that restored the old binary and
	 * left a receipt describing the new one is the same defect reversed, on the
	 * path nobody exercises by hand.
	 */
	// Read from the installer suites' shared definition rather than restated here.
	// A second spelling of the format would let the updater and install.sh drift
	// apart while both suites stayed green, which is the failure this whole block
	// exists to prevent.

	it("re-stamps the receipt to describe the binary it swapped in", async () => {
		const { target, temp, backup } = sandbox();
		writeFileSync(target, "OLD-BINARY");
		writeFileSync(temp, "NEW-BINARY");
		const stale = ownerReceiptBodyFor(target);
		writeFileSync(ownerReceiptFor(target), stale);

		await replaceBinaryForUpdate({
			targetPath: target,
			tempPath: temp,
			backupPath: backup,
			expectedVersion: "9.9.9",
			verifyInstalledVersion: okVerifier,
		});

		expect(readFileSync(ownerReceiptFor(target), "utf8")).toBe(ownerReceiptBodyFor(target));
		// Not merely "still a receipt": the old one described OLD-BINARY, and
		// leaving it is exactly the state the installer refuses to act on.
		expect(readFileSync(ownerReceiptFor(target), "utf8")).not.toBe(stale);
	});

	it("re-stamps the receipt back when verification fails and the old binary returns", async () => {
		const { target, temp, backup } = sandbox();
		writeFileSync(target, "OLD-BINARY");
		writeFileSync(temp, "BROKEN-NEW-BINARY");
		// The receipt the automatic rollback has to restore agreement with. It is
		// seeded describing the NEW binary, which is the state a re-stamp on the
		// way in leaves behind when the swap succeeds and verification then fails.
		writeFileSync(ownerReceiptFor(target), ownerReceiptBodyFor(temp));

		await expect(
			replaceBinaryForUpdate({
				targetPath: target,
				tempPath: temp,
				backupPath: backup,
				expectedVersion: "9.9.9",
				verifyInstalledVersion: failVerifier,
			}),
		).rejects.toThrow(/restored previous/i);

		expect(readFileSync(target, "utf8")).toBe("OLD-BINARY");
		expect(readFileSync(ownerReceiptFor(target), "utf8")).toBe(ownerReceiptBodyFor(target));
	});

	it("leaves no half-written receipt temp beside the binary", async () => {
		// The receipt is staged as `.<name>.veyyon-owner.<pid>` and renamed, the
		// same shape install.sh uses, so the install suites that fail on leftover
		// installer temps also cover the updater. A surviving temp would be a full
		// second sidecar the installer never reads.
		const { target, temp, backup } = sandbox();
		writeFileSync(target, "OLD-BINARY");
		writeFileSync(temp, "NEW-BINARY");

		await replaceBinaryForUpdate({
			targetPath: target,
			tempPath: temp,
			backupPath: backup,
			expectedVersion: "9.9.9",
			verifyInstalledVersion: okVerifier,
		});

		const dir = path.dirname(target);
		const receipt = path.basename(ownerReceiptFor(target));
		expect((await fsp.readdir(dir)).filter(name => name.startsWith(`${receipt}.`))).toEqual([]);
	});
});

describe("replaceBinaryForUpdate recovers from a bad artifact that passes the size guard", () => {
	/**
	 * A download can be truncated and still be non-empty, so the `[ -s ]`-style
	 * size guard lets it through by design. Nothing before the swap can tell a
	 * short binary from a good one, which means the post-install version check is
	 * the ONLY thing standing between the user and an unrunnable binary. This
	 * asserts the recovery is byte-exact rather than merely "something is there":
	 * a rollback that restored a different or partial file would satisfy an
	 * existence check and still leave the user broken.
	 */
	it("rolls a truncated download back to the byte-exact previous binary", async () => {
		const { target, temp, backup } = sandbox();
		const original = "OLD-BINARY-WITH-REAL-CONTENT-\u0000\u0001\u0002";
		writeFileSync(target, original);
		// Non-empty, so the size guard passes; too short to run, so the version
		// check is what catches it.
		writeFileSync(temp, "EL");

		await expect(
			replaceBinaryForUpdate({
				targetPath: target,
				tempPath: temp,
				backupPath: backup,
				expectedVersion: "9.9.9",
				// What a truncated binary actually does: it cannot report a version.
				verifyInstalledVersion: () => Promise.resolve({ ok: false as const, actual: undefined, path: target }),
			}),
		).rejects.toThrow(/restored previous/i);

		expect(readFileSync(target, "utf8")).toBe(original);
		expect(existsSync(temp)).toBe(false);
		expect(existsSync(backup)).toBe(false);
	});

	/**
	 * The failure has to say what it could not do. "Could not verify" with no
	 * path leaves an operator with a working binary and no idea which artifact
	 * was rejected or where to look.
	 */
	it("names what it could not verify when the binary reports no version at all", async () => {
		const { target, temp, backup } = sandbox();
		writeFileSync(target, "OLD-BINARY");
		writeFileSync(temp, "TRUNCATED");

		const failure = await replaceBinaryForUpdate({
			targetPath: target,
			tempPath: temp,
			backupPath: backup,
			expectedVersion: "9.9.9",
			verifyInstalledVersion: () => Promise.resolve({ ok: false as const, actual: undefined, path: target }),
		}).then(
			() => undefined,
			(error: unknown) => String(error),
		);

		expect(failure).toContain("could not verify");
		expect(failure).toContain(target);
	});

	/**
	 * A mislabelled artifact is the quiet version of this failure: the binary
	 * runs fine, it is simply not the version that was asked for. The error must
	 * name BOTH versions, because "the update failed" without them cannot tell an
	 * operator whether the registry served the wrong file or their request was
	 * wrong.
	 */
	it("names both the requested and the installed version on a mislabelled artifact", async () => {
		const { target, temp, backup } = sandbox();
		writeFileSync(target, "OLD-BINARY");
		writeFileSync(temp, "A-PERFECTLY-GOOD-BUT-WRONG-VERSION");

		const failure = await replaceBinaryForUpdate({
			targetPath: target,
			tempPath: temp,
			backupPath: backup,
			expectedVersion: "9.9.9",
			verifyInstalledVersion: () => Promise.resolve({ ok: false as const, actual: "8.1.0", path: target }),
		}).then(
			() => undefined,
			(error: unknown) => String(error),
		);

		expect(failure).toContain("8.1.0");
		expect(failure).toContain("9.9.9");
		// And the user is left on the version they already had, not the wrong one.
		expect(readFileSync(target, "utf8")).toBe("OLD-BINARY");
	});

	/**
	 * The version check must not be able to pass by accident. An artifact that
	 * reports exactly the requested version is installed and kept, which is the
	 * twin that keeps the assertions above from passing against an
	 * implementation that rejected everything.
	 */
	it("keeps an artifact that reports exactly the requested version", async () => {
		const { target, temp, backup } = sandbox();
		writeFileSync(target, "OLD-BINARY");
		writeFileSync(temp, "NEW-BINARY");

		const verification = await replaceBinaryForUpdate({
			targetPath: target,
			tempPath: temp,
			backupPath: backup,
			expectedVersion: "9.9.9",
			verifyInstalledVersion: expected =>
				Promise.resolve({ ok: expected === "9.9.9", actual: "9.9.9", path: target }),
		});

		expect(verification.ok).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("NEW-BINARY");
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

		// The transaction now preserves the old inode with a hard link before the
		// atomic temp->target swap. Let that first rename run, then force the second
		// rename (backup->target rollback) to fail.
		const realRename = fsp.rename.bind(fsp);
		let renameCalls = 0;
		const renameSpy = spyOn(fsp, "rename").mockImplementation(async (from, to) => {
			renameCalls += 1;
			if (renameCalls >= 2) throw new Error("simulated rollback rename failure (EACCES)");
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
		// The rollback was actually attempted (swap-in, then restore).
		expect(renameCalls).toBe(2);
	});
});
