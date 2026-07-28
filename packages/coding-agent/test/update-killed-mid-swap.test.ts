import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sweepStaleBackups } from "../src/cli/update-cli";

/**
 * What a machine is left holding when an update is KILLED, not merely failed.
 *
 * Every other test of the binary swap fails it politely: a rejected download, a
 * bad checksum, a verifier that says no. Each of those runs the `catch`, which
 * restores the backup and removes the temp. A SIGKILL, a laptop lid closing on a
 * dying battery, and a power cut run none of it, and that is the case a user
 * actually reports — "I updated and now nothing works". Nothing exercised it,
 * because a test cannot kill itself and then assert.
 *
 * So the swap runs in a CHILD process which kills itself with SIGKILL at a point
 * chosen by the test, and the parent then reads the directory the child left
 * behind. SIGKILL is deliberate: SIGTERM and `process.exit` both give the
 * runtime a chance to unwind, which is exactly the chance a real kill does not.
 *
 * The contract, at every point: the file the user's PATH points at is either the
 * old binary or the new one, whole and executable, and never a partial or absent
 * file. Litter is allowed (a `.bak` the sweep reclaims); a broken install is not.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const UPDATE_CLI = path.join(REPO_ROOT, "packages/coding-agent/src/cli/update-cli.ts");

/** Contents distinct enough that a byte comparison names which one survived. */
const OLD_BINARY = "#!/bin/sh\necho veyyon/1.0.0\n";
const NEW_BINARY = "#!/bin/sh\necho veyyon/2.0.0\n";

/** Where the child is told to die. */
type KillPoint = "before-verify";

interface Layout {
	dir: string;
	target: string;
	temp: string;
	backup: string;
}

async function makeLayout(): Promise<Layout> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-killed-swap-"));
	const target = path.join(dir, "veyyon");
	const temp = path.join(dir, "veyyon.new");
	const backup = path.join(dir, "veyyon.1700000000000.4242.bak");
	await fs.writeFile(target, OLD_BINARY, { mode: 0o755 });
	await fs.writeFile(temp, NEW_BINARY, { mode: 0o755 });
	return { dir, target, temp, backup };
}

/**
 * Runs the real `replaceBinaryForUpdate` in a child that SIGKILLs itself at
 * `killPoint`, and returns what the child's exit looked like.
 *
 * The kill is delivered by the injected verifier, which is the one seam that
 * lands between the second rename and the verification: the instant at which the
 * new binary is in place, the backup still exists, and nothing has yet decided
 * whether to keep it.
 */
function killDuringSwap(layout: Layout, killPoint: KillPoint): { signal: string | null; status: number | null } {
	const script = `
import { replaceBinaryForUpdate } from ${JSON.stringify(UPDATE_CLI)};
await replaceBinaryForUpdate({
	targetPath: ${JSON.stringify(layout.target)},
	tempPath: ${JSON.stringify(layout.temp)},
	backupPath: ${JSON.stringify(layout.backup)},
	expectedVersion: "2.0.0",
	verifyInstalledVersion: async () => {
		if (${JSON.stringify(killPoint)} === "before-verify") process.kill(process.pid, "SIGKILL");
		return { ok: true, reportedVersion: "2.0.0" };
	},
});
`;
	const run = spawnSync("bun", ["-e", script], { encoding: "utf8", cwd: REPO_ROOT });
	return { signal: run.signal ?? null, status: run.status ?? null };
}

async function read(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return null;
	}
}

async function isExecutable(file: string): Promise<boolean> {
	const stat = await fs.stat(file);
	return (stat.mode & 0o111) !== 0;
}

describe("an update killed mid-swap", () => {
	/**
	 * The control. Without it every assertion below would also pass if the child
	 * had simply failed to start, which is the shape a broken test path takes.
	 */
	it("really dies by signal rather than exiting", async () => {
		const layout = await makeLayout();
		try {
			const outcome = killDuringSwap(layout, "before-verify");
			expect(outcome.signal).toBe("SIGKILL");
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});

	/**
	 * Killed after the swap and before the verification, the user is left on the
	 * NEW binary. That is the correct outcome — the bytes were checksummed before
	 * the rename — and it is asserted byte-exactly rather than by existence,
	 * because "a file is there" is also true of a half-written one.
	 */
	it("leaves a whole, executable binary at the path PATH points at", async () => {
		const layout = await makeLayout();
		try {
			killDuringSwap(layout, "before-verify");

			const installed = await read(layout.target);
			expect(installed).toBe(NEW_BINARY);
			expect(await isExecutable(layout.target)).toBe(true);
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});

	/**
	 * The rename is atomic, so there is no window in which the target is a partial
	 * file — but the TEMP must also be gone, because it sits in the install
	 * directory mode 0755 under a name one keystroke from the real one, and an
	 * executable-looking half-download beside the binary is its own hazard.
	 */
	it("leaves no staged download behind", async () => {
		const layout = await makeLayout();
		try {
			killDuringSwap(layout, "before-verify");

			expect(await read(layout.temp)).toBeNull();
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});

	/**
	 * The backup DOES survive, because the code that would have removed it never
	 * ran. That is litter rather than damage, and it is the reason
	 * `sweepStaleBackups` exists: this asserts the pair actually works together,
	 * rather than each being correct on its own.
	 */
	it("leaves the backup, and the sweep reclaims it without touching the binary", async () => {
		const layout = await makeLayout();
		try {
			killDuringSwap(layout, "before-verify");
			expect(await read(layout.backup)).toBe(OLD_BINARY);

			await sweepStaleBackups(layout.target);

			expect(await read(layout.backup)).toBeNull();
			expect(await read(layout.target)).toBe(NEW_BINARY);
			expect(await fs.readdir(layout.dir)).toEqual(["veyyon"]);
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});

	/**
	 * A second kill on the next attempt must not compound: the directory after two
	 * killed updates holds one binary and backups the sweep can name, never a
	 * growing pile of files a user has to identify themselves. Each backup path is
	 * unique per attempt, so this is the assertion that keeps them sweepable.
	 */
	it("does not accumulate unsweepable files across repeated kills", async () => {
		const layout = await makeLayout();
		try {
			killDuringSwap(layout, "before-verify");
			// Stage a second update over the result, and lose that one too.
			await fs.writeFile(layout.temp, NEW_BINARY, { mode: 0o755 });
			const secondBackup = path.join(layout.dir, "veyyon.1700000000001.4243.bak");
			killDuringSwap({ ...layout, backup: secondBackup }, "before-verify");

			expect(await read(layout.target)).toBe(NEW_BINARY);
			await sweepStaleBackups(layout.target);
			expect(await fs.readdir(layout.dir)).toEqual(["veyyon"]);
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	});
});
