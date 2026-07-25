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
		// the name most people use, and it can be shadowed independently.
		expect(installSh).toContain('check_not_shadowed "$BIN_NAME" "$bin_dir"');
		expect(installSh).toContain('check_not_shadowed "$ALIAS_NAME" "$bin_dir"');
		expect(installPs1).toContain("foreach ($name in @($BinName, $AliasName))");
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
