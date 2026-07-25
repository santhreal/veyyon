import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A source install rewrites a git checkout the user owns. Both installers must
 * treat that tree the same way: never destroy work, and never continue on a
 * checkout that did not actually reach the requested ref.
 *
 * Two classes of bug live here. The first is destruction: the clone path used to
 * `rm -rf` whatever sat at `~/.veyyon/src`, and the update path resets `--hard`
 * over uncommitted edits. The second is silence: a `git reset` whose exit code
 * nobody reads leaves the OLD tree in place while the installer goes on to
 * `bun install` it and report the new version.
 *
 * The POSIX behavior is exercised against throwaway repos in
 * scripts/install-tests/functions.test.sh; this suite holds the cross-platform
 * contract, since pwsh is not available on the Linux dev host.
 */

const repoRoot = path.resolve(import.meta.dir, "..");
const installSh = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");
const installPs1 = fs.readFileSync(path.join(repoRoot, "scripts", "install.ps1"), "utf8");

describe("a checkout that fails to reset never gets installed anyway", () => {
	it("install.sh aborts when neither reset target works", () => {
		// The two resets are one `&&` chain under a single `|| die`, so a failure
		// of the fallback cannot leak past it.
		expect(installSh).toMatch(
			/git reset --hard "origin\/\$ref" 2>\/dev\/null \|\| git reset --hard "\$ref"; \} \)[\s\S]{0,40}\|\| die "failed to check out/,
		);
	});

	it("install.ps1 checks the fallback reset's exit code, not just the first", () => {
		// `git reset --hard $ref | Out-Null` used to end the branch with its
		// $LASTEXITCODE unread: both resets could fail and the install continued
		// on the previous release's tree, under the new version's name.
		const fn = installPs1.slice(installPs1.indexOf("function Fetch-SourceTree {"));
		const body = fn.slice(0, fn.indexOf("\nfunction "));
		const fallback = body.indexOf("git reset --hard $ref | Out-Null");
		expect(fallback, "the fallback reset should still exist").toBeGreaterThan(-1);
		expect(body.slice(fallback)).toMatch(/if \(\$LASTEXITCODE -ne 0\) \{ throw "failed to reset/);
	});

	it("both abort on a failed checkout of the requested ref", () => {
		expect(installSh).toContain("failed to check out '$ref'");
		expect(installPs1).toContain("failed to check out '$ref'");
	});
});

describe("neither installer destroys work in a checkout it did not create", () => {
	it("both commit local edits to a recovery branch before resetting", () => {
		expect(installSh).toContain("preserve_local_src_changes() {");
		expect(installPs1).toContain("function Preserve-LocalSrcChanges {");
		// The branch name is the recovery handle, so both must print it.
		expect(installSh).toContain("preserved your local changes on branch");
		expect(installPs1).toContain("preserved your local changes on branch");
	});

	it("both refuse the update when preservation itself fails", () => {
		// Fail closed: if the edits could not be captured, resetting over them is
		// unrecoverable, so the update stops instead.
		expect(installSh).toContain("refusing to update: could not preserve local changes");
		expect(installPs1).toContain("refusing to update: could not preserve local changes");
	});

	it("both move an existing tree aside rather than deleting it", () => {
		expect(installSh).toContain("move_aside_existing_src() {");
		expect(installPs1).toContain("function Move-AsideExistingSrc {");
		expect(installSh).toContain("nothing was deleted");
		expect(installPs1).toContain("nothing was deleted");
	});

	it("neither clone path still rm -rf's the destination", () => {
		// The specific regression: `rm -rf "$VEYYON_SRC_DIR"` immediately before
		// `git clone`, which took every file a user had put there.
		expect(installSh).not.toMatch(/rm -rf "\$VEYYON_SRC_DIR"\s*$/m);
		const psFn = installPs1.slice(installPs1.indexOf("function Fetch-SourceTree {"));
		const psBody = psFn.slice(0, psFn.indexOf("\nfunction "));
		expect(psBody).not.toMatch(/Remove-Item -Recurse -Force \$SrcDir/);
	});

	it("uninstall keeps a checkout that holds unpushed local work", () => {
		// A `veyyon-local-*` recovery branch from a previous update is exactly the
		// kind of unpushed work that must survive `--uninstall`.
		expect(installSh).toContain("src_has_local_work() {");
		expect(installPs1).toContain("function Test-SrcHasLocalWork {");
		expect(installSh).toContain("git log --branches --not --remotes");
		expect(installPs1).toContain("git log --branches --not --remotes");
	});
});
