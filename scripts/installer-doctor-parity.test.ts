import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Locks the post-install self-check to the same contract on both platforms.
 *
 * Why this suite exists: doctor used to report success whenever the command name
 * existed anywhere on PATH. That is exactly the state a SHADOWED install is in —
 * an older copy earlier on PATH (a previous `bun add -g`, a distro package, a
 * stale manual install) keeps winning every invocation, so the user "upgrades",
 * sees a green doctor, and runs the old binary forever. Presence on PATH is not
 * proof; where the name RESOLVES is. Both installers must check it, report the
 * offending path, and keep the install non-fatal so the user can fix PATH.
 *
 * The behavioral half lives in scripts/install-tests/functions.test.sh (POSIX,
 * runs locally) and scripts/install-tests/functions.test.ps1 (Windows).
 */

const repoRoot = path.resolve(import.meta.dir, "..");
const installSh = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");
const installPs1 = fs.readFileSync(path.join(repoRoot, "scripts", "install.ps1"), "utf8");

describe("doctor verifies where the command resolves, not merely that it exists", () => {
	it("install.sh compares the resolved directory against the install directory", () => {
		expect(installSh).toContain("check_not_shadowed() {");
		expect(installSh).toContain('got_dir=$(resolved_dir_for "$name")');
		expect(installSh).toContain('if [ "$got_dir" = "$want_dir" ]');
	});

	it("install.ps1 compares the resolved directory against the install directory", () => {
		expect(installPs1).toContain("function Test-NotShadowed {");
		expect(installPs1).toContain("$gotDir = Split-Path -Parent $found.Source");
		expect(installPs1).toContain("$gotDir.TrimEnd('\\') -ieq $WantDir.TrimEnd('\\')");
	});

	it("both check the binary name AND the launch alias", () => {
		// A user who types the documented `vey` must be covered too: the alias is
		// the name most people use, and it can be shadowed independently. The
		// alias check is conditional: an alias the installer declined to create is
		// not ours to call a shadow (see installer-no-clobber.test.ts).
		expect(installSh).toContain('check_not_shadowed "$BIN_NAME" "$bin_dir"');
		expect(installSh).toContain('check_not_shadowed "$ALIAS_NAME" "$bin_dir"');
		expect(installPs1).toContain("Test-NotShadowed -Name $BinName -WantDir $binDir");
		expect(installPs1).toContain("Test-NotShadowed -Name $AliasName -WantDir $binDir");
	});

	it("both name the shadowing path in the warning, so the user can act on it", () => {
		// A warning that says only \"something is wrong\" is not actionable; the
		// offending file's location is the whole point of the check.
		expect(installSh).toMatch(/resolves to \$got_dir\/\$name, NOT the copy just installed in \$want_dir/);
		expect(installPs1).toContain("resolves to $($found.Source), NOT the copy just installed in $WantDir");
	});

	it("shadowing warns but never aborts the install", () => {
		// The installed binary is fine; only PATH order is wrong, and that is the
		// user's to fix. `die`/`throw` here would fail an otherwise good install.
		const shFn = installSh.slice(installSh.indexOf("check_not_shadowed() {"), installSh.indexOf("# ---- post-install"));
		expect(shFn).toContain("warn ");
		expect(shFn).not.toContain("die ");
		const psFn = installPs1.slice(installPs1.indexOf("function Test-NotShadowed {"));
		const psBody = psFn.slice(0, psFn.indexOf("\n}\n"));
		expect(psBody).toContain("Write-Host");
		expect(psBody).not.toContain("throw ");
	});

	it("a name missing from PATH gets its own actionable message, not a shadow warning", () => {
		// \"not installed on PATH yet\" and \"shadowed by an older copy\" are different
		// problems with different fixes; collapsing them would mislead the user.
		expect(installSh).toMatch(/not on PATH yet \(restart your shell, or add \$want_dir to PATH\)/);
		expect(installPs1).toContain("not on PATH yet (open a new terminal, or add $WantDir to PATH)");
	});
});

describe("doctor verifies the installed binary is the version the release claims", () => {
	it("both installers compare the reported version against the release tag", () => {
		// The checksum only proves the bytes match the published asset. It cannot
		// catch a release that uploaded the wrong binary for its tag, or a stale
		// cached download — both install "successfully" and then run the wrong
		// version forever. The self-updater already gated on this; the installers
		// did not, and that asymmetry is what these lock shut.
		expect(installSh).toContain("version_from_output() {");
		expect(installSh).toContain('doctor "$INSTALL_DIR/$BIN_NAME" "$LATEST"');
		expect(installPs1).toContain("function ConvertFrom-VersionOutput {");
		expect(installPs1).toContain("Invoke-Doctor -Command $OutPath -ExpectedTag $Latest");
	});

	it("both strip a leading v from the tag before comparing", () => {
		// Tags are `v1.0.37`; `--version` reports `veyyon/1.0.37`.
		expect(installSh).toContain('want="${want_tag#v}"');
		expect(installPs1).toContain("$want = $ExpectedTag -replace '^v', ''");
	});

	it("a version mismatch is fatal in both, never a warning", () => {
		// Printing "Installation complete" over a wrong-version binary is exactly
		// the silent failure being removed, so this one must abort.
		expect(installSh).toMatch(/die "installed \$BIN_NAME reports \$got but the \$want_tag release was requested/);
		expect(installPs1).toContain("throw \"installed $BinName reports $got but the $ExpectedTag release was requested");
	});

	it("an unparseable version output fails closed rather than passing the gate", () => {
		// Law 10: if the version cannot be read, the check has not passed — it has
		// failed to run, and must not be treated as success.
		expect(installSh).toContain("could not read a version from");
		expect(installPs1).toContain("could not read a version from");
	});

	it("the version gate only runs when a tag is supplied", () => {
		// A source install has no release tag to compare against, so the gate is
		// skipped rather than fabricating an expectation.
		expect(installSh).toContain('if [ -n "$want_tag" ]; then');
		expect(installPs1).toContain("if ($ExpectedTag) {");
	});
});

describe("doctor does not depend on tools a broken PATH would hide", () => {
	it("install.sh resolves the parent directory with parameter expansion, not `dirname`", () => {
		// doctor exists to diagnose PATH problems, so forking an external `dirname`
		// is exactly the wrong dependency: it fails in the case being diagnosed.
		expect(installSh).toContain("dir_of() {");
		const doctorFn = installSh.slice(installSh.indexOf("doctor() {"));
		const doctorBody = doctorFn.slice(0, doctorFn.indexOf("\n}\n"));
		expect(doctorBody).toContain('bin_dir=$(dir_of "$bin")');
		expect(doctorBody).not.toContain("dirname");
	});
});
