import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The positive parity gate for the installer contract: a curl install downloads
 * a verified prebuilt binary, or it stops and hands the user a manual route.
 *
 * The outage this locks out: `install.sh --source` (and `--ref <branch>`, which
 * silently implied it) ran `git clone` into `$HOME/.veyyon/src`, bootstrapped
 * bun, ran `bun install`, fetched Git LFS content and built there. Every machine
 * that used that path carried a SECOND, divergent checkout of the product,
 * indistinguishable from a real one — which is how development ended up
 * happening inside an installed harness rather than in the repository. The
 * capability is gone from both installers, and this suite is what keeps it gone:
 * these are text assertions against the real installer sources because a POSIX
 * shell script and a PowerShell script cannot be exercised in-process, and
 * because "the flag does not exist" is a property of the file, not of a run.
 *
 * Uninstall's handling of a LEGACY `~/.veyyon/src` is deliberately NOT covered
 * here and must not be read as forbidden: older installers really did create
 * such a tree, so uninstall still finds one and still refuses to destroy work in
 * it. That contract lives in scripts/installer-uninstall-parity.test.ts.
 */

const repoRoot = path.resolve(import.meta.dir, "..");
const installSh = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");
const installPs1 = fs.readFileSync(path.join(repoRoot, "scripts", "install.ps1"), "utf8");

const REPO = "santhreal/veyyon";
const REPO_URL = `https://github.com/${REPO}.git`;

/** The one manual route out of every hard failure, fully expanded. */
const MANUAL_BUILD = `build it from a checkout you own: git clone ${REPO_URL} && cd veyyon && bun run setup`;

/**
 * Executable lines only. Both scripts comment with `#`, and both explain the
 * removed source path in prose — a comment describing an old bug is not that
 * bug, so every "must not contain" assertion reads this and not the raw file.
 */
function code(body: string): string {
	return body
		.split("\n")
		.filter(line => !line.trimStart().startsWith("#"))
		.join("\n");
}

const installers = [
	{ name: "install.sh", body: installSh, code: code(installSh) },
	{ name: "install.ps1", body: installPs1, code: code(installPs1) },
] as const;

describe("the manual build route is the only clone either installer mentions", () => {
	it("both define the same manual path, expanded to the same bytes", () => {
		// The user runs the clone; the installer never does. Each script builds
		// the advice from its own repo constant, so this extracts the assignment
		// and expands it: a drift between the two would hand Windows and POSIX
		// users different recovery instructions for the same refusal.
		const shLine = installSh.split("\n").find(line => line.startsWith("MANUAL_BUILD="));
		expect(shLine, "install.sh must define MANUAL_BUILD").toBeString();
		// biome-ignore lint/suspicious/noTemplateCurlyInString: `${REPO}` is install.sh's own shell expansion, quoted as a fixture.
		const shManual = (shLine ?? "").slice('MANUAL_BUILD="'.length, -1).replace("${REPO}", REPO);
		expect(shManual).toBe(MANUAL_BUILD);

		const psLine = installPs1.split("\n").find(line => line.startsWith("$ManualBuild = "));
		expect(psLine, "install.ps1 must define $ManualBuild").toBeString();
		const psManual = (psLine ?? "").slice('$ManualBuild = "'.length, -1).replace("$RepoUrl", REPO_URL);
		expect(psManual).toBe(MANUAL_BUILD);

		// The expansion only holds if the repo constants really are these.
		expect(installSh).toContain(`REPO="${REPO}"`);
		expect(installPs1).toContain(`$Repo = "${REPO}"`);
		expect(installPs1).toContain('$RepoUrl = "https://github.com/$Repo.git"');
	});

	for (const script of installers) {
		it(`${script.name} contains no git clone it would execute`, () => {
			// The outage: this exact command ran inside the installer, against
			// $HOME/.veyyon/src, without the user asking for a checkout. The only
			// permitted occurrence now is the manual-path string the user runs.
			const cloneLines = script.code.split("\n").filter(line => line.includes("git clone"));
			expect(cloneLines, `${script.name} should mention git clone only in its manual-path constant`).toHaveLength(1);
			expect(cloneLines[0]).toMatch(/^(MANUAL_BUILD=|\$ManualBuild = )/);
		});
	}
});

describe("neither installer needs a toolchain", () => {
	for (const script of installers) {
		it(`${script.name} never runs bun install`, () => {
			// The source path ran `bun install` in the cloned tree, so a curl
			// install pulled a full dependency graph from a package registry onto
			// a machine that had asked for one binary.
			expect(script.code).not.toContain("bun install");
		});

		it(`${script.name} never bootstraps bun`, () => {
			// It also installed bun itself, by downloading and running
			// https://bun.sh/install. A binary install needs no runtime, so the
			// downloader, the version floor, and their helpers are all gone.
			expect(script.code).not.toContain("bun.sh");
			for (const gone of [
				"install_bun",
				"Install-Bun",
				"require_bun_version",
				"MIN_BUN_VERSION",
				"install_via_bun",
				"Install-FromSource",
			]) {
				expect(script.code, `${script.name} still references ${gone}`).not.toContain(gone);
			}
		});

		it(`${script.name} never fetches Git LFS content`, () => {
			// LFS only mattered because the installer had a checkout to
			// materialize. With no checkout there is nothing to pull, and the
			// old "pull if git-lfs happens to be here" step swallowed its own
			// failures anyway, leaving pointer text on disk under a success line.
			expect(script.code).not.toContain("git lfs");
			expect(script.code).not.toContain("git-lfs");
			expect(script.code).not.toContain("filter=lfs");
			for (const gone of ["fetch_lfs_assets", "lfs_tracked_file", "Get-LfsAssets", "Test-GitLfsInstalled"]) {
				expect(script.code, `${script.name} still references ${gone}`).not.toContain(gone);
			}
		});
	}
});

describe("no option asks either installer to build from source", () => {
	it("install.sh has no --source flag and no source mode", () => {
		// `--source` was the entry point to the whole outage, and `--ref <branch>`
		// silently implied it. `--ref` now names a published release tag only.
		expect(code(installSh)).not.toContain("--source");
		expect(code(installSh)).not.toMatch(/MODE=(["']?)source\1/);
		expect(code(installSh)).not.toContain("fetch_source_tree");
		expect(code(installSh)).not.toContain("preserve_local_src_changes");
	});

	it("install.ps1 has no -Source switch", () => {
		// `-Source` was the Windows spelling of the same flag. The negative match
		// stops at a word boundary so it does not collide with `-SourcePath`,
		// which is Move-InstallItemWithRetry's parameter and unrelated.
		const paramStart = installPs1.indexOf("param(");
		const paramBlock = installPs1.slice(paramStart, installPs1.indexOf(")", paramStart));
		expect(paramBlock).not.toMatch(/\$Source(?![A-Za-z])/);
		expect(code(installPs1)).not.toMatch(/-Source(?![A-Za-z])/);
		expect(code(installPs1)).not.toContain("Fetch-SourceTree");
		expect(code(installPs1)).not.toContain("Preserve-LocalSrcChanges");
	});

	it("neither help text offers a flag that clones", () => {
		// The usage text is the copy a `curl … | sh -s -- --help` user reads. It
		// pointed at `--source` as the fallback for an unsupported platform; the
		// fallback is now prose telling the user to clone the repository himself.
		expect(installSh).toContain("Branches and commits are not installable: clone the");
		expect(installPs1).toContain("$ManualBuild");
		for (const script of installers) {
			expect(script.code, `${script.name} still advertises a source install`).not.toMatch(
				/(--source|-Source(?![A-Za-z]))/,
			);
		}
	});
});
