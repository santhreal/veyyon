import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A source install must either materialize its Git LFS content or stop.
 *
 * Both installers wrapped the fetch in "do it if git-lfs happens to be here":
 * POSIX `has git-lfs && ( ... git lfs pull ) || true`, Windows
 * `if (Test-GitLfsInstalled) { git lfs pull | Out-Null }`. Every failure mode is
 * silent. git-lfs missing means the pull never runs; git-lfs present but the
 * pull failing means the error is discarded (`|| true`, `Out-Null` plus an
 * unchecked $LASTEXITCODE). In both cases every LFS-tracked file stays a
 * ~130-byte pointer TEXT file, the installer prints success, and veyyon dies
 * later on a file that is right there on disk. `.gitattributes` puts `*.wasm`
 * under LFS, so this goes live the moment a wasm asset lands.
 *
 * The POSIX behavior is exercised for real against throwaway git repos in
 * scripts/install-tests/functions.test.sh; this suite holds the cross-platform
 * contract, since pwsh is not available on the Linux dev host.
 */

const repoRoot = path.resolve(import.meta.dir, "..");
const installSh = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");
const installPs1 = fs.readFileSync(path.join(repoRoot, "scripts", "install.ps1"), "utf8");
const gitattributes = fs.readFileSync(path.join(repoRoot, ".gitattributes"), "utf8");

describe("the repository really does declare LFS-managed files", () => {
	it(".gitattributes routes an extension through the LFS filter", () => {
		// If this ever stops being true the rest of the suite is guarding nothing,
		// and that should be a deliberate decision, not a silent drift.
		expect(gitattributes).toMatch(/filter=lfs/);
	});
});

describe("neither installer swallows a Git LFS failure", () => {
	it("install.sh no longer ends the LFS step with `|| true`", () => {
		expect(installSh).not.toContain("git lfs pull ) || true");
		expect(installSh).toContain("fetch_lfs_assets() {");
	});

	it("install.sh aborts when the checkout needs LFS and git-lfs is absent", () => {
		expect(installSh).toContain("has git-lfs || die ");
		expect(installSh).toContain("git-lfs is not installed");
	});

	it("install.sh aborts when the pull itself fails", () => {
		expect(installSh).toMatch(/git lfs pull \) \|\| die "git lfs pull failed/);
	});

	it("install.ps1 checks the pull's exit code instead of discarding it", () => {
		// `| Out-Null` hides output, not failure: without an explicit
		// $LASTEXITCODE check a failed pull reads as success.
		expect(installPs1).toContain("function Get-LfsAssets {");
		const fn = installPs1.slice(installPs1.indexOf("function Get-LfsAssets {"));
		const body = fn.slice(0, fn.indexOf("\nfunction "));
		expect(body).toContain("if ($LASTEXITCODE -ne 0) {");
		expect(body).toContain("git lfs pull failed");
	});

	it("install.ps1 aborts when the checkout needs LFS and git-lfs is absent", () => {
		expect(installPs1).toContain("if (-not (Test-GitLfsInstalled)) {");
		expect(installPs1).toContain("git-lfs is not installed");
	});

	it("both name the consequence and the fix, not just the failure", () => {
		// "pointer text" is the whole point: the file exists and looks fine, which
		// is why the user would otherwise never connect the later crash to this.
		for (const [name, body] of [
			["install.sh", installSh],
			["install.ps1", installPs1],
		] as const) {
			expect(body, `${name} must explain what a skipped pull leaves behind`).toContain("pointer text");
			expect(body, `${name} must say where to get git-lfs`).toContain("https://git-lfs.com");
		}
	});
});

describe("a checkout that tracks nothing through LFS installs without git-lfs", () => {
	it("both decide by what is actually tracked, not by the .gitattributes rule alone", () => {
		// Today `*.wasm filter=lfs` matches zero files. Requiring git-lfs from that
		// declaration alone would block every source install on a machine without
		// it, for a rule governing nothing.
		expect(installSh).toContain("git ls-files ':(attr:filter=lfs)'");
		expect(installPs1).toContain("git ls-files ':(attr:filter=lfs)'");
	});

	it("both treat an unanswerable check as unknown, never as `no LFS`", () => {
		// git < 2.18 rejects the pathspec magic. Reading that as "nothing tracked"
		// would reintroduce the silent skip on exactly the oldest toolchains.
		expect(installSh).toContain("|| return 2");
		expect(installSh).toContain("cannot list LFS-tracked paths");
		expect(installPs1).toContain("return 'unknown'");
		expect(installPs1).toContain("cannot list LFS-tracked paths");
	});
});
