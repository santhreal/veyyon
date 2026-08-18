import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeOwnerReceipt } from "../../../scripts/install-tests/installer-artifacts";
import { sweepStaleBackups } from "../src/cli/update-cli";

/**
 * Every pathname a `veyyon update` attempt leaves behind must be reclaimed, by
 * the updater and by `--uninstall`, on every platform.
 *
 * THE DEFECT. A machine held a 147MB `veyyon.exe.6358c750-….bak` from an update
 * three days earlier, and no shipped command would remove it. The updater names
 * each attempt's files after a `crypto.randomUUID()` so two concurrent updates
 * cannot truncate each other's download — but the sweeps that reclaim those files
 * were written against the names of two releases earlier, a fixed `veyyon.new`
 * and a dot-numeric `veyyon.<timestamp>.<pid>.bak`. They matched neither shape
 * actually on disk. `--uninstall` printed "the install directory is left empty"
 * over a directory holding a copy of the binary.
 *
 * THE CLASS: a name is produced in one place and recognized in three
 * (`scripts/install.sh`, `scripts/install.ps1`, and `sweepStaleBackups` here), so
 * changing the producer silently breaks all three recognizers, and changing one
 * recognizer silently disagrees with the others. Closing the incident would mean
 * adding the UUID shape to each. Closing the class means the corpus of names is
 * taken FROM THE PRODUCER at run time — the real `updateViaBinaryAt` is run and
 * the pathnames it creates are recorded — so a change to how attempts are named
 * turns this red instead of quietly moving the target.
 *
 * WHAT IT DOES NOT CATCH: `install.ps1`'s `Test-UpdateAttemptLeftover`, which
 * needs a Windows registry and cannot be sourced here; it is asserted against the
 * same corpus by `scripts/install-tests/functions.test.ps1`. Nor does it catch a
 * file whose owning process is still alive, which is deliberately left alone.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const UPDATE_CLI = path.join(REPO_ROOT, "packages/coding-agent/src/cli/update-cli.ts");
const INSTALL_SH = path.join(REPO_ROOT, "scripts/install.sh");

/**
 * A stand-in release binary that answers the three things `verifyBinaryUsable`
 * asks of a freshly installed one: `--version` in the `veyyon/X.Y.Z` shape it
 * parses, `grep --help`, and a `grep` that really finds the file it is pointed
 * at. A stub that faked the search would satisfy the probe even if the update had
 * stopped pointing it anywhere, which is the failure the probe exists to catch.
 */
function standInBinary(version: string): string {
	return `#!/bin/sh
set -u
case "\${1:-}" in
	--version) echo "veyyon/${version}"; exit 0 ;;
	grep)
		[ "\${2:-}" = "--help" ] && { echo "usage: veyyon grep <pattern> <path>"; exit 0; }
		exec grep -rl -- "$2" "$3" ;;
	*) echo "unknown command: \${1:-}" >&2; exit 2 ;;
esac
`;
}

interface Attempt {
	/** Basenames the real update created beside the binary, in creation order. */
	created: string[];
	stdout: string;
	status: number | null;
}

/**
 * Runs the real `updateViaBinaryAt` against a local stub of the release server
 * and reports which pathnames it created next to the binary.
 *
 * `fetch` is replaced rather than a server started: the URL is built inside
 * `updateViaBinaryAt` from a hardcoded repository, so there is no seam to point
 * at a local port, and the property under test is the NAMES it chooses, which are
 * chosen before the first byte is fetched. `link` and `rename` are wrapped to
 * record the paths the swap creates, because a successful update deletes them
 * again and a directory listing afterwards would see nothing.
 */
function runRealUpdate(targetPath: string): Attempt {
	const script = `
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { updateViaBinaryAt } from ${JSON.stringify(UPDATE_CLI)};
// No initTheme(): the update path formats its own success line without one, which
// the-update-command-says-what-it-did-with-no-theme-loaded.test.ts owns. This child
// used to load a theme purely to get past that line.

const payload = ${JSON.stringify(standInBinary("2.0.0"))};
const digest = crypto.createHash("sha256").update(payload).digest("hex");
globalThis.fetch = async url => {
	const text = String(url).endsWith(".sha256") ? digest + "  veyyon\\n" : payload;
	return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
};

const created = [];
const realLink = fs.promises.link;
const realRename = fs.promises.rename;
fs.promises.link = async (from, to) => { created.push(String(to)); return realLink(from, to); };
fs.promises.rename = async (from, to) => { created.push(String(from)); return realRename(from, to); };
// rename(from) names the staged download and link(to) names the rollback copy,
// which is both halves of an attempt. createWriteStream is not wrapped: it is a
// readonly property under Bun, and the download path it is given is the same one
// the rename reports.

await updateViaBinaryAt(${JSON.stringify(targetPath)}, "2.0.0", () => {});
console.log("CREATED " + JSON.stringify(created));
`;
	const run = spawnSync("bun", ["-e", script], { encoding: "utf8", cwd: REPO_ROOT });
	const out = `${run.stdout}${run.stderr}`;
	const match = out.match(/CREATED (\[.*\])/);
	const created: string[] = match ? (JSON.parse(match[1]) as string[]) : [];
	return {
		created: [...new Set(created.map(p => path.basename(p)))].filter(name => name !== path.basename(targetPath)),
		stdout: out,
		status: run.status ?? null,
	};
}

/**
 * Whether the shipped `scripts/install.sh` treats `middle` as one of the
 * updater's, asked of the real predicate its uninstall sweep uses.
 *
 * `set --` before the source is load-bearing: sourcing leaves `$@` alone and
 * install.sh parses `$@` as its command line, so an inherited argument list gets
 * the usage screen back instead of a verdict.
 */
function shellClaimsMiddle(middle: string): boolean {
	const run = spawnSync(
		"sh",
		[
			"-c",
			'set -u; set --; VEYYON_INSTALL_SOURCED=1 . "$INSTALL_SH"; if update_attempt_middle_is_ours "$MIDDLE"; then echo ours; else echo foreign; fi',
		],
		{ encoding: "utf8", cwd: REPO_ROOT, env: { ...process.env, INSTALL_SH, MIDDLE: middle } },
	);
	const verdict = `${run.stdout}`.trim().split("\n").pop();
	if (verdict !== "ours" && verdict !== "foreign") {
		throw new Error(`install.sh gave no verdict for [${middle}]: ${run.stdout}${run.stderr}`);
	}
	return verdict === "ours";
}

/** Whether `sweepStaleBackups` reclaims `<binary>.bak` under `middle`. */
async function updaterReclaimsMiddle(middle: string): Promise<boolean> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-sweep-parity-"));
	try {
		const target = path.join(dir, "veyyon");
		const leftover = path.join(dir, `veyyon${middle}.bak`);
		await fs.writeFile(target, "binary");
		await fs.writeFile(leftover, "previous");
		await sweepStaleBackups(target);
		return !(await fs.readdir(dir)).includes(path.basename(leftover));
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("the names an update attempt leaves behind", () => {
	/**
	 * THE PRODUCER. Every name the real update creates has to be one all the
	 * recognizers claim. This is the assertion that goes red if the naming scheme
	 * changes without the sweeps following it — which is precisely what happened.
	 */
	it("are all recognized as the updater's own", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-attempt-names-"));
		try {
			const target = path.join(dir, "veyyon");
			await fs.writeFile(target, standInBinary("1.0.0"), { mode: 0o755 });
			const attempt = runRealUpdate(target);

			expect(attempt.status, attempt.stdout).toBe(0);
			// Both halves of an attempt: the staged download and the rollback copy.
			// Fewer than two means the harness stopped observing the producer and the
			// assertions below would be vacuous.
			const suffixed = attempt.created.filter(name => name.endsWith(".new") || name.endsWith(".bak"));
			expect(suffixed.length).toBeGreaterThanOrEqual(2);
			expect(new Set(suffixed.map(name => name.slice(name.lastIndexOf("."))))).toEqual(new Set([".new", ".bak"]));

			for (const name of suffixed) {
				const middle = name.slice("veyyon".length, name.lastIndexOf("."));
				expect(shellClaimsMiddle(middle), `install.sh does not claim ${name}`).toBe(true);
				expect(await updaterReclaimsMiddle(middle), `sweepStaleBackups does not reclaim ${name}`).toBe(true);
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	/**
	 * The recognizers must agree with EACH OTHER, not merely each be defensible.
	 * A name swept by the updater and left by uninstall, or the reverse, is a file
	 * whose fate depends on which command the user happened to run.
	 *
	 * The corpus is every shape any shipped release has written, plus the
	 * near-misses that a looser pattern would swallow: a hand-saved backup, a
	 * truncated UUID, and a UUID-shaped name that no `randomUUID` produces.
	 */
	it("are classified identically by the shell installer and the updater", async () => {
		const corpus: Array<[middle: string, ours: boolean]> = [
			["", true],
			[`.${crypto.randomUUID()}`, true],
			[`.${crypto.randomUUID()}`, true],
			[".1753660000.4242", true],
			[".1753660000", true],
			[".mine", false],
			[".keep-this", false],
			// One hex digit short of a UUID.
			[".6358c750-7c88-4c71-81c0-91c9b27c6c7", false],
			// UUID-shaped, but no version-4 UUID has a `0` version nibble.
			[".6358c750-7c88-0c71-81c0-91c9b27c6c76", false],
			// Nor a `c` variant nibble.
			[".6358c750-7c88-4c71-c1c0-91c9b27c6c76", false],
			[".backup.2026", false],
		];

		for (const [middle, ours] of corpus) {
			expect(shellClaimsMiddle(middle), `install.sh, for [${middle}]`).toBe(ours);
			expect(await updaterReclaimsMiddle(middle), `sweepStaleBackups, for [${middle}]`).toBe(ours);
		}
	});

	/**
	 * `--uninstall` is where the reported symptom was visible, so it is asserted
	 * through the real uninstall rather than through the predicate it calls: the
	 * defect was in the loop around the predicate, not in the decision.
	 */
	it("are gone after the shipped uninstall runs", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-uninstall-names-"));
		try {
			const bin = path.join(home, "bin");
			await fs.mkdir(bin);
			const attempt = crypto.randomUUID();
			// A receipt, because an install without one is a different case: uninstall
			// leaves an unowned binary alone, and the directory listing below would
			// then be asserting that rather than the sweep.
			await fs.writeFile(path.join(bin, "veyyon"), "binary");
			writeOwnerReceipt(path.join(bin, "veyyon"));
			await fs.writeFile(path.join(bin, `veyyon.${attempt}.new`), "staged");
			await fs.writeFile(path.join(bin, `veyyon.${attempt}.bak`), "previous");
			await fs.writeFile(path.join(bin, "veyyon.mine.bak"), "mine");

			const run = spawnSync("sh", [INSTALL_SH, "--uninstall"], {
				encoding: "utf8",
				cwd: REPO_ROOT,
				env: { ...process.env, HOME: home, VEYYON_INSTALL_DIR: bin },
			});

			expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
			expect((await fs.readdir(bin)).sort()).toEqual(["veyyon.mine.bak"]);
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	});
});
