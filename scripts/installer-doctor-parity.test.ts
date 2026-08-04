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
		const shFrom = installSh.indexOf("check_not_shadowed() {");
		const shFn = installSh.slice(shFrom, installSh.indexOf("\n}\n", shFrom));
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

describe("a release binary is the version its tag claims before replacement", () => {
	it("both installers run the staged executable's version gate", () => {
		// The checksum only proves the bytes match the published asset. It cannot
		// catch a release that uploaded the wrong binary for its tag, or a stale
		// cached download. This must be checked on the staged path while the
		// previous executable and installer metadata are still untouched.
		expect(installSh).toContain("version_from_output() {");
		expect(installSh).toContain('require_release_version "$tmpbin" "$LATEST" "downloaded"');
		expect(installPs1).toContain("function ConvertFrom-VersionOutput {");
		expect(installPs1).toContain(
			'Assert-ReleaseVersion -Command $StagingPath -ExpectedTag $Latest -Phase "downloaded"',
		);
	});

	it("both strip a leading v from the tag before comparing", () => {
		// Tags are `v1.0.37`; `--version` reports `veyyon/1.0.37`.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: quotes install.sh; the ${...} is shell source under test.
		expect(installSh).toContain('want="${want_tag#v}"');
		expect(installPs1).toContain("$want = $ExpectedTag -replace '^v', ''");
	});

	it("a version mismatch is fatal in both, never a warning", () => {
		// Printing "Installation complete" over a wrong-version binary is exactly
		// the silent failure being removed, so this one must abort.
		expect(installSh).toMatch(/die "installed \$BIN_NAME reports \$got but the \$want_tag release was requested/);
		expect(installPs1).toContain('throw "installed $BinName reports $got but the $ExpectedTag release was requested');
	});

	it("an unparseable version output fails closed rather than passing the gate", () => {
		// Law 10: if the version cannot be read, the check has not passed — it has
		// failed to run, and must not be treated as success.
		expect(installSh).toContain("could not read a version from");
		expect(installPs1).toContain("could not read a version from");
	});

	it("the version gate only runs when a tag is supplied", () => {
		// A `--local`/`-Local` install has no release tag to compare against — it
		// installs whatever version the checkout built — so the gate is skipped
		// rather than fabricating an expectation.
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

describe("the installer does not create the shadowing it then warns about", () => {
	it("both put the install dir at the FRONT of PATH", () => {
		// PATH order decides which copy of a name runs. install.ps1 appended, so
		// any older veyyon already on PATH kept winning and doctor reported a
		// shadow on every single install — one the installer had just caused.
		// The line text has one owner now (path_line_for), shared with uninstall.
		// The directory is single-quoted and `$PATH` is not: a directory name
		// containing `$` used to expand when the profile was sourced, so the
		// entry that landed on PATH was not the one the line named. `$PATH` still
		// has to expand, which is why only the directory is inside the quotes.
		expect(installSh).toContain(`printf 'export PATH=%s:"$PATH"' "$(shell_single_quote "$2")"`);
		expect(installSh).toContain(`printf 'fish_add_path %s' "$(shell_single_quote "$2")"`);
		expect(installPs1).toContain("return ((@($Dir) + @(Split-PathEntries $Raw)) -join ';')");
	});

	it("neither appends the install dir behind the existing entries", () => {
		expect(installPs1).not.toContain("(@(Split-PathEntries $Raw) + $Dir)");
		expect(installSh).not.toContain(`printf 'export PATH="$PATH:%s"'`);
		expect(installSh).not.toContain(`printf 'export PATH="$PATH":%s'`);
	});
});

/**
 * Both doctors must prove the native addon LOADS, not merely that the binary
 * starts.
 *
 * `--version` is served entirely by the JS entry point, so it succeeds on an
 * install whose addon is missing or was staged for the wrong architecture. Both
 * installers printed "veyyon runs" for exactly that install and the user met
 * the failure on their first real command. This is the one class of install
 * breakage the musl preflight catches for a single cause and cannot catch for
 * the rest, so it belongs in the self-test on both platforms or on neither.
 */
describe("doctor proves the native addon loads", () => {
	it("both run a real search rather than trusting --version", () => {
		expect(installSh).toContain("doctor_natives() {");
		expect(installSh).toContain('_dn_out=$("$_dn_bin" grep veyyon-native-self-test "$_dn_dir" 2>&1)');
		expect(installPs1).toContain("function Test-NativeAddon {");
		expect(installPs1).toContain("& $Command grep veyyon-native-self-test $dir 2>&1");
	});

	it("both are called from doctor, before the shadow checks", () => {
		// Ordering matters for the reader: an addon that cannot load makes a PATH
		// warning beside the point.
		expect(installSh.indexOf('doctor_natives "$bin"')).toBeGreaterThan(-1);
		expect(installSh.indexOf('doctor_natives "$bin"')).toBeLessThan(
			installSh.indexOf('check_not_shadowed "$BIN_NAME"'),
		);
		expect(installPs1.indexOf("Test-NativeAddon -Command $Command")).toBeLessThan(
			installPs1.indexOf("Test-NotShadowed -Name $BinName"),
		);
	});

	it("both check the RESULT, not only the exit status", () => {
		// A walker that returns nothing exits 0 too, so the exit code alone would
		// report a healthy install for a broken one.
		expect(installSh).toContain("*probe.txt*)");
		expect(installPs1).toContain("if ($out -notmatch 'probe\\.txt')");
	});

	it("both treat a build with no grep command as fine, not broken", () => {
		// An older binary predating the subcommand is not a failed install.
		expect(installSh).toContain("skipping the native addon self-test");
		expect(installPs1).toContain("skipping the native addon self-test");
	});

	it("both name the platform remedy their own users can actually run", () => {
		// This is the one failure with no installer-side fix: the release has no
		// build that loads here, so no flag and no retry helps. The remedy used to
		// be "run the installer again with --source", which cloned the repository
		// into $HOME/.veyyon/src behind the user's back; that flag is gone, and
		// the remedy is now a checkout the USER makes. Both installers say it
		// through one constant each, so the two cannot drift into different
		// advice, and each doctor interpolates that constant rather than
		// rewording it.
		expect(installSh).toContain(
			'MANUAL_BUILD="build it from a checkout you own: git clone https://github.com/${REPO}.git && cd veyyon && bun run setup"',
		);
		expect(installPs1).toContain(
			'$ManualBuild = "build it from a checkout you own: git clone $RepoUrl && cd veyyon && bun run setup"',
		);
		const shNatives = installSh.slice(installSh.indexOf("doctor_natives() {"));
		expect(shNatives.slice(0, shNatives.indexOf("\n}\n"))).toContain(
			"No prebuilt binary works here, so $MANUAL_BUILD",
		);
		const psNatives = installPs1.slice(installPs1.indexOf("function Test-NativeAddon {"));
		expect(psNatives.slice(0, psNatives.indexOf("\n}\n"))).toContain(
			"No prebuilt binary works here, so $ManualBuild",
		);
	});

	it("neither remedy sends the user back through an installer flag that clones", () => {
		// The exact shapes that were wrong, so they cannot come back by copy-paste:
		// suggesting a flag the installer no longer has would answer a broken
		// install with "Unknown option".
		expect(installSh).not.toContain("sh -s -- --source");
		expect(installPs1).not.toContain("install.ps1))) -Source");
	});

	it("both remove the directory they staged, on success and on failure", () => {
		// It runs on every install, so a leak is a directory per install forever.
		expect(installSh).toContain('rm -rf "$_dn_dir"');
		expect(installPs1).toContain("} finally {");
		expect(installPs1).toContain("Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue");
	});
});

/**
 * A checksum proves the bytes are the ones that were published. It cannot tell
 * whether the release published the tag's version or whether the native build
 * works for this platform.
 *
 * Either gap must be rejected while the download is STAGED. Discovering it
 * after the move destroys the previous executable and can rewrite the `vey`
 * alias, shell profile, and completions before reporting failure. Staging makes
 * both checks transactional: rejection costs only the owned temporary file.
 */
describe("an invalid release is refused before it touches the system", () => {
	/** The body of one shell function, so ordering is asserted inside the caller
	 * that matters rather than against the first match anywhere in the file. */
	function shFn(name: string): string {
		const from = installSh.indexOf(`${name}() {`);
		expect(from, `missing function ${name}`).toBeGreaterThan(-1);
		const to = installSh.indexOf("\n}\n", from);
		return installSh.slice(from, to === -1 ? undefined : to);
	}

	it("install.sh checks version and native search on the staged download", () => {
		expect(installSh).toContain('require_release_version "$tmpbin" "$LATEST" "downloaded"');
		expect(installSh).toContain('doctor_natives "$tmpbin" "downloaded"');
	});

	it("both staged gates run after the checksum and before the move", () => {
		// Order is the whole point. After finalize_binary these are reports;
		// before it, they preserve the working executable.
		const body = shFn("install_binary");
		const checksum = body.indexOf('verify_release_binary "$tmpbin"');
		const version = body.indexOf('require_release_version "$tmpbin" "$LATEST" "downloaded"');
		const natives = body.indexOf('doctor_natives "$tmpbin" "downloaded"');
		const finalize = body.indexOf('finalize_binary "$tmpbin"');
		expect(checksum).toBeGreaterThan(-1);
		expect(version).toBeGreaterThan(checksum);
		expect(natives).toBeGreaterThan(version);
		expect(finalize).toBeGreaterThan(natives);
	});

	it("nothing the user can see is written before the version gate", () => {
		// The alias, PATH edit, and completions all follow finalize_binary, so the
		// earliest gate must precede every one of them.
		const body = shFn("install_binary");
		const preflight = body.indexOf('require_release_version "$tmpbin" "$LATEST" "downloaded"');
		expect(preflight).toBeGreaterThan(-1);
		for (const mutation of [
			'link_alias "$(install_dir)"',
			'install_completions "$(install_dir)/$BIN_NAME"',
			'ensure_on_path "$(install_dir)"',
		]) {
			expect(body.indexOf(mutation), mutation).toBeGreaterThan(preflight);
		}
	});

	it("the staged file is executable before either gate runs", () => {
		// curl writes it 0644; both --version and the native probe must execute it.
		const body = shFn("install_binary");
		const chmod = body.indexOf('chmod +x "$tmpbin"');
		const version = body.indexOf('require_release_version "$tmpbin" "$LATEST" "downloaded"');
		const natives = body.indexOf('doctor_natives "$tmpbin" "downloaded"');
		expect(chmod).toBeGreaterThan(-1);
		expect(chmod).toBeLessThan(version);
		expect(chmod).toBeLessThan(natives);
	});

	it("the two runs are the same function, told which phase they are in", () => {
		// One implementation of "does the addon load", not a preflight copy that
		// drifts from the post-install check.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: quotes install.sh; the ${...} is shell source under test.
		expect(installSh).toContain('_dn_bin="$1"; _dn_phase="${2:-installed}"');
		expect(installSh).toContain('doctor_natives "$bin"');
		expect(installSh).toContain('ok "native addon loads ($_dn_phase)');
	});

	it("install.ps1 applies both gates to the staged download", () => {
		// Windows had the identical ordering gap: verified, moved into place,
		// aliased, PATH-edited, and only then asked whether it was the right build.
		expect(installPs1).toContain(
			'Assert-ReleaseVersion -Command $StagingPath -ExpectedTag $Latest -Phase "downloaded"',
		);
		expect(installPs1).toContain('Test-NativeAddon -Command $StagingPath -Phase "downloaded"');
	});

	it("install.ps1 gates version and native search before every mutation", () => {
		// Scoped to Install-Binary: Install-LocalBinary calls some of the same
		// helpers and matching those would prove nothing about ordering here.
		const from = installPs1.indexOf("function Install-Binary {");
		expect(from).toBeGreaterThan(-1);
		const body = installPs1.slice(from);
		const version = body.indexOf(
			'Assert-ReleaseVersion -Command $StagingPath -ExpectedTag $Latest -Phase "downloaded"',
		);
		const natives = body.indexOf('Test-NativeAddon -Command $StagingPath -Phase "downloaded"');
		expect(version).toBeGreaterThan(-1);
		expect(natives).toBeGreaterThan(version);
		for (const mutation of [
			"Move-StagedBinaryIntoPlace -StagingPath $StagingPath -TargetPath $OutPath",
			"Install-Alias -Target $OutPath",
			"$needsRestart = Add-ToPath",
			"Install-Completions -BinPath $OutPath",
		]) {
			expect(body.indexOf(mutation), mutation).toBeGreaterThan(natives);
		}
	});

	it("install.ps1 removes the staged file when either gate rejects it", () => {
		// A rejected download must not sit in the install directory waiting to be
		// mistaken for a partial install.
		const body = installPs1.slice(installPs1.indexOf("function Install-Binary {"));
		const preflight = body.indexOf(
			'Assert-ReleaseVersion -Command $StagingPath -ExpectedTag $Latest -Phase "downloaded"',
		);
		const cleanup = body.indexOf("Remove-Item $StagingPath -ErrorAction SilentlyContinue", preflight);
		const move = body.indexOf("Move-StagedBinaryIntoPlace -StagingPath $StagingPath");
		expect(cleanup).toBeGreaterThan(preflight);
		expect(cleanup).toBeLessThan(move);
	});
});
