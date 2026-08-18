import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A `veyyon update` that dies between placing the new binary and recording it
 * must leave a binary the installer can still claim.
 *
 * THE DEFECT, as reported from a Windows machine: `install.ps1` refused with
 * "refusing to replace C:\...\veyyon.exe because it has changed since this
 * installer wrote it", while the file at that path hashed to the published
 * sha256 of a real release — a binary the product itself had put there. The
 * ownership receipt beside it still described the binary that had been retired
 * three days earlier. So the swap had completed and the receipt rewrite had not,
 * and from that moment the install was unrepairable through any shipped command:
 * install refused, uninstall left the file, and the user's only remedy was
 * deleting a 150MB executable by hand.
 *
 * THE CLASS: the updater placed the artifact FIRST and recorded it SECOND, so
 * every instruction between those two — a rename, a version verification, a
 * ~150MB hash of a file an antivirus scanner has just begun reading — was a point
 * at which a kill produced a permanently unowned binary. Closing the reported
 * incident would mean retrying the hash; closing the class means there is no
 * instant at which the file on disk is described by nothing. A provisional
 * receipt naming the incoming bytes is written BEFORE the swap, so the binary is
 * covered by the pending record or the durable one at every point.
 *
 * WHY IT IS SHAPED THIS WAY. The window is only observable from outside the
 * process, so the swap runs in a CHILD that SIGKILLs itself at a chosen point:
 * SIGTERM and `process.exit` both let the runtime unwind, which is the chance a
 * real kill does not give. The kill points are not a list of places someone
 * thought of — they are "the Nth `rename` this swap performs", so they track the
 * real sequence and a change to it turns this red rather than quietly moving the
 * window out from under the test. Every verdict then comes from the REAL
 * `scripts/install.sh`, sourced and asked the same question a reinstall asks,
 * because "the installer accepts it" is the contract and a TypeScript
 * reimplementation of the predicate would prove only that this file agrees with
 * itself.
 *
 * WHAT IT DOES NOT CATCH: `install.ps1`'s half of the answer (asserted by
 * `scripts/install-tests/functions.test.ps1`, which cannot run here); a
 * filesystem that acknowledges a rename and loses it; and a kill so early that
 * no update has begun, which needs no recovery.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const UPDATE_CLI = path.join(REPO_ROOT, "packages/coding-agent/src/cli/update-cli.ts");
const INSTALL_SH = path.join(REPO_ROOT, "scripts/install.sh");

/** Distinct enough that a byte comparison names which binary survived. */
const OLD_BINARY = "#!/bin/sh\necho veyyon/1.0.0\n";
const NEW_BINARY = "#!/bin/sh\necho veyyon/2.0.0\n";

/**
 * Which `rename` the child dies on, counting from the start of the swap.
 *
 * The swap renames exactly three times, in this order: the pending receipt into
 * place, the download onto the binary, the durable receipt into place. Numbering
 * the kill by that count is what keeps these cases pinned to the real sequence:
 * add or reorder a rename and the recorded order below stops matching.
 */
const RENAME_COUNT_BEFORE_PENDING = 1;
const RENAME_COUNT_BEFORE_SWAP = 2;
const RENAME_COUNT_BEFORE_RECEIPT = 3;

interface Layout {
	dir: string;
	target: string;
	temp: string;
	backup: string;
	receipt: string;
	pending: string;
}

/**
 * An install directory in the state the reported machine was in before its last
 * update: a binary, and a receipt that correctly describes it.
 */
async function makeLayout(): Promise<Layout> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-unrecorded-swap-"));
	const attempt = crypto.randomUUID();
	const layout: Layout = {
		dir,
		target: path.join(dir, "veyyon"),
		temp: path.join(dir, `veyyon.${attempt}.new`),
		backup: path.join(dir, `veyyon.${attempt}.bak`),
		receipt: path.join(dir, ".veyyon.veyyon-owner"),
		pending: path.join(dir, ".veyyon.veyyon-owner.pending"),
	};
	await fs.writeFile(layout.target, OLD_BINARY, { mode: 0o755 });
	await fs.writeFile(layout.temp, NEW_BINARY, { mode: 0o755 });
	await fs.writeFile(layout.receipt, `veyyon-installer-v2\nfile sha256:${sha256Of(OLD_BINARY)}\n`);
	return layout;
}

function sha256Of(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Runs the real `replaceBinaryForUpdate` in a child that SIGKILLs itself on the
 * `killOnRename`th rename, and reports how the child died.
 */
function killDuringSwap(layout: Layout, killOnRename: number): { signal: string | null; status: number | null } {
	const script = `
import * as fs from "node:fs";
import { replaceBinaryForUpdate } from ${JSON.stringify(UPDATE_CLI)};
let renames = 0;
const realRename = fs.promises.rename;
fs.promises.rename = async (from, to) => {
	renames += 1;
	if (renames === ${killOnRename}) {
		process.kill(process.pid, "SIGKILL");
		throw new Error("unreachable");
	}
	return realRename(from, to);
};
await replaceBinaryForUpdate({
	targetPath: ${JSON.stringify(layout.target)},
	tempPath: ${JSON.stringify(layout.temp)},
	backupPath: ${JSON.stringify(layout.backup)},
	expectedVersion: "2.0.0",
	verifyInstalledVersion: async () => ({ ok: true, reportedVersion: "2.0.0" }),
});
`;
	const run = spawnSync("bun", ["-e", script], { encoding: "utf8", cwd: REPO_ROOT });
	return { signal: run.signal ?? null, status: run.status ?? null };
}

/**
 * Runs `body` with the shipped `scripts/install.sh` sourced and `$ARTIFACT` set,
 * and returns what it printed.
 *
 * `set --` before the source is load-bearing: sourcing leaves `$@` alone, and
 * install.sh parses `$@` as its command line, so a sourced copy that inherited
 * this shell's arguments answers with its usage screen instead of a verdict.
 */
function askInstaller(body: string, artifactPath: string): string {
	const run = spawnSync("sh", ["-c", `set -u; set --; VEYYON_INSTALL_SOURCED=1 . "$INSTALL_SH"; ${body}`], {
		encoding: "utf8",
		cwd: REPO_ROOT,
		env: { ...process.env, INSTALL_SH, ARTIFACT: artifactPath },
	});
	return `${run.stdout}${run.stderr}`.trim();
}

/**
 * Whether the shipped installer would treat `binaryPath` as one of its own — the
 * same question a reinstall asks before it refuses.
 */
function installerClaims(binaryPath: string): boolean {
	const out = askInstaller(
		'if binary_artifact_is_ours "$ARTIFACT"; then echo ours; else echo foreign; fi',
		binaryPath,
	);
	const verdict = out.split("\n").pop();
	if (verdict !== "ours" && verdict !== "foreign") {
		throw new Error(`install.sh gave no verdict for ${binaryPath}: ${out}`);
	}
	return verdict === "ours";
}

/** Why the installer would refuse, in its own words. */
function refusalReason(binaryPath: string): string {
	return askInstaller('binary_refusal_reason "$ARTIFACT"', binaryPath);
}

async function read(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return null;
	}
}

describe("an update interrupted before its receipt", () => {
	/**
	 * The control for every case below. If the child ever exits normally, the
	 * assertions stop describing a kill and start describing a clean swap, and
	 * they would keep passing while proving nothing.
	 */
	it("really is a kill and not a graceful failure", async () => {
		const layout = await makeLayout();
		try {
			const exit = killDuringSwap(layout, RENAME_COUNT_BEFORE_RECEIPT);
			expect(exit.signal).toBe("SIGKILL");
			expect(exit.status).toBeNull();
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});

	/**
	 * THE REPORTED DEFECT. The binary is the new one, the durable receipt still
	 * describes the old one, and the installer has to claim it anyway.
	 */
	it("leaves the new binary claimable when the durable receipt never landed", async () => {
		const layout = await makeLayout();
		try {
			killDuringSwap(layout, RENAME_COUNT_BEFORE_RECEIPT);

			expect(await read(layout.target)).toBe(NEW_BINARY);
			expect(await read(layout.receipt)).toBe(`veyyon-installer-v2\nfile sha256:${sha256Of(OLD_BINARY)}\n`);
			expect(await read(layout.pending)).toBe(`veyyon-installer-v2\nfile sha256:${sha256Of(NEW_BINARY)}\n`);
			expect(installerClaims(layout.target)).toBe(true);
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});

	/**
	 * NEGATIVE CONTROL, and the proof that the pending receipt is what does the
	 * work. Delete it and the machine is back in the state that was reported,
	 * refused in the words that were reported.
	 */
	it("is refused again once the provisional record is removed", async () => {
		const layout = await makeLayout();
		try {
			killDuringSwap(layout, RENAME_COUNT_BEFORE_RECEIPT);
			await fs.rm(layout.pending);

			expect(installerClaims(layout.target)).toBe(false);
			expect(refusalReason(layout.target)).toContain("changed since this installer wrote it");
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});

	/**
	 * The provisional record vouches for BYTES, not for a path. Without this the
	 * fix would hand ownership of whatever turns up at the binary's path to the
	 * installer, which is the exact defect the durable receipt exists to prevent:
	 * delete the binary, drop your own script in its place, and the next install
	 * overwrites it and uninstall deletes it.
	 */
	it("does not vouch for a different file that takes the binary's place", async () => {
		const layout = await makeLayout();
		try {
			killDuringSwap(layout, RENAME_COUNT_BEFORE_RECEIPT);
			await fs.writeFile(layout.target, "#!/bin/sh\necho somebody elses tool\n", { mode: 0o755 });

			expect(installerClaims(layout.target)).toBe(false);
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});

	/**
	 * The other edge of the window. Killed before the download is renamed onto the
	 * binary, the path still holds the OLD binary — so the provisional record,
	 * which names the new bytes, must not be what answers for it. Its own durable
	 * receipt still does, and that is the whole reason a stale provisional record
	 * is harmless rather than a licence.
	 */
	it("leaves the previous binary claimable when the swap itself never happened", async () => {
		const layout = await makeLayout();
		try {
			killDuringSwap(layout, RENAME_COUNT_BEFORE_SWAP);

			expect(await read(layout.target)).toBe(OLD_BINARY);
			expect(await read(layout.pending)).toBe(`veyyon-installer-v2\nfile sha256:${sha256Of(NEW_BINARY)}\n`);
			expect(installerClaims(layout.target)).toBe(true);
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});

	/**
	 * Killed before anything was recorded at all, which is the only point in the
	 * swap where nothing on disk has moved yet. Nothing to recover, and nothing
	 * claiming to have been recorded.
	 */
	it("changes nothing when it dies before recording anything", async () => {
		const layout = await makeLayout();
		try {
			killDuringSwap(layout, RENAME_COUNT_BEFORE_PENDING);

			expect(await read(layout.target)).toBe(OLD_BINARY);
			expect(await read(layout.pending)).toBeNull();
			expect(installerClaims(layout.target)).toBe(true);
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});

	/**
	 * A swap that COMPLETES leaves no provisional record. Asserted by exact
	 * directory contents rather than by checking the one name this change adds:
	 * every "the install directory is clean" assertion in the install suites reads
	 * the whole directory, so a sidecar that outlives a successful update is a
	 * regression in those suites too, and it should be caught here first.
	 */
	it("leaves no provisional record behind when it succeeds", async () => {
		const layout = await makeLayout();
		try {
			const script = `
import { replaceBinaryForUpdate } from ${JSON.stringify(UPDATE_CLI)};
await replaceBinaryForUpdate({
	targetPath: ${JSON.stringify(layout.target)},
	tempPath: ${JSON.stringify(layout.temp)},
	backupPath: ${JSON.stringify(layout.backup)},
	expectedVersion: "2.0.0",
	verifyInstalledVersion: async () => ({ ok: true, reportedVersion: "2.0.0" }),
});
`;
			const run = spawnSync("bun", ["-e", script], { encoding: "utf8", cwd: REPO_ROOT });
			expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);

			expect((await fs.readdir(layout.dir)).sort()).toEqual([".veyyon.veyyon-owner", "veyyon"]);
			expect(await read(layout.receipt)).toBe(`veyyon-installer-v2\nfile sha256:${sha256Of(NEW_BINARY)}\n`);
			expect(installerClaims(layout.target)).toBe(true);
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});

	/**
	 * A rollback restores the previous binary, so the records beside it must
	 * describe THAT binary and not the one that was rejected. The same defect with
	 * the arrow reversed, on the path nobody exercises by hand.
	 */
	it("describes the restored binary after a rollback, not the rejected one", async () => {
		const layout = await makeLayout();
		try {
			const script = `
import { replaceBinaryForUpdate } from ${JSON.stringify(UPDATE_CLI)};
try {
	await replaceBinaryForUpdate({
		targetPath: ${JSON.stringify(layout.target)},
		tempPath: ${JSON.stringify(layout.temp)},
		backupPath: ${JSON.stringify(layout.backup)},
		expectedVersion: "2.0.0",
		verifyInstalledVersion: async () => ({ ok: false, reportedVersion: "1.0.0" }),
	});
} catch {}
`;
			spawnSync("bun", ["-e", script], { encoding: "utf8", cwd: REPO_ROOT });

			expect(await read(layout.target)).toBe(OLD_BINARY);
			expect(await read(layout.pending)).toBeNull();
			expect(await read(layout.receipt)).toBe(`veyyon-installer-v2\nfile sha256:${sha256Of(OLD_BINARY)}\n`);
			expect(installerClaims(layout.target)).toBe(true);
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});

	/**
	 * FAIL CLOSED. If the provisional record cannot be written, the swap must not
	 * happen: proceeding would recreate exactly the unrecoverable window this
	 * whole mechanism exists to close, and it would do so on the machines least
	 * able to recover from it. Nothing on disk has been disturbed at that point,
	 * so refusing costs the user only the update.
	 */
	it("refuses to swap at all when the provisional record cannot be written", async () => {
		const layout = await makeLayout();
		try {
			const script = `
import * as fs from "node:fs";
import { replaceBinaryForUpdate } from ${JSON.stringify(UPDATE_CLI)};
const realWrite = Bun.write;
Bun.write = async (dest, ...rest) => {
	if (String(dest).includes(".veyyon-owner.pending")) throw new Error("EROFS: read-only file system");
	return realWrite(dest, ...rest);
};
try {
	await replaceBinaryForUpdate({
		targetPath: ${JSON.stringify(layout.target)},
		tempPath: ${JSON.stringify(layout.temp)},
		backupPath: ${JSON.stringify(layout.backup)},
		expectedVersion: "2.0.0",
		verifyInstalledVersion: async () => ({ ok: true, reportedVersion: "2.0.0" }),
	});
	console.log("SWAPPED");
} catch (err) {
	console.log("REFUSED", err.message);
}
`;
			const run = spawnSync("bun", ["-e", script], { encoding: "utf8", cwd: REPO_ROOT });

			expect(run.stdout).toContain("REFUSED");
			expect(run.stdout).toContain("pending ownership");
			expect(await read(layout.target)).toBe(OLD_BINARY);
			expect(installerClaims(layout.target)).toBe(true);
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});
});
