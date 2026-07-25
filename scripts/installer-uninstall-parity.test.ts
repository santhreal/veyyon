import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Locks `install.sh --uninstall` and `install.ps1 -Uninstall` to the SAME
 * reclaim contract, and locks both to the loader's own path contract.
 *
 * Why this suite exists: a binary install stages the native addon in a
 * per-version cache (~150MB per version) resolved by `getNativesDir()` in
 * packages/natives/native/loader-state.js. Both uninstallers used to remove only
 * the binary, the alias, the source checkout and the completions, so every
 * version ever installed leaked its addon cache forever: uninstall "succeeded"
 * while leaving hundreds of MB on disk, and a later reinstall silently inherited
 * stale addons from a cache the user believed was gone.
 *
 * The cache path is owned by ONE place (loader-state.js). These tests read that
 * owner and assert both installers mirror its exact condition, so the three
 * copies can never drift into resolving different directories. The behavioral
 * half of this contract (a seeded cache is actually removed, and sibling user
 * data is not) lives in scripts/install-tests/functions.test.sh; pwsh is not
 * available on the Linux dev host, so this static suite is what keeps the
 * Windows half honest between CI runs.
 */

/** A named shell function's body, from its opening line to the closing brace. */
function fnBody(body: string, start: string, end: string): string {
	const from = body.indexOf(start);
	expect(from, `missing ${start}`).toBeGreaterThan(-1);
	const to = body.indexOf(end, from);
	expect(to, `missing terminator after ${start}`).toBeGreaterThan(from);
	return body.slice(from, to);
}

const repoRoot = path.resolve(import.meta.dir, "..");
const installSh = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");
const installPs1 = fs.readFileSync(path.join(repoRoot, "scripts", "install.ps1"), "utf8");
const loaderState = fs.readFileSync(
	path.join(repoRoot, "packages", "natives", "native", "loader-state.js"),
	"utf8",
);

/** The uninstall body of each script, so assertions cannot match an install-path string. */
function uninstallBody(body: string, startMarker: string, endMarker: string): string {
	const start = body.indexOf(startMarker);
	expect(start, `missing uninstall entry point: ${startMarker}`).toBeGreaterThan(-1);
	const end = body.indexOf(endMarker, start);
	expect(end, `missing uninstall terminator after ${startMarker}`).toBeGreaterThan(start);
	return body.slice(start, end);
}

const shUninstall = uninstallBody(installSh, "do_uninstall() {", '"nothing to uninstall."');
const ps1Uninstall = uninstallBody(installPs1, "function Uninstall-Veyyon {", '"nothing to uninstall."');

describe("native addon cache path is owned by loader-state.js", () => {
	it("getNativesDir resolves XDG only when $XDG_DATA_HOME/veyyon exists, else ~/.veyyon/natives", () => {
		// This is the contract both uninstallers mirror. If this assertion ever
		// fails, loader-state changed the cache location and BOTH installers below
		// must be updated in the same change, not left resolving a dead path.
		expect(loaderState).toContain('const xdgDataHome = process.env.XDG_DATA_HOME;');
		expect(loaderState).toContain('fs.existsSync(path.join(xdgDataHome, "veyyon"))');
		expect(loaderState).toContain('path.join(xdgDataHome, "veyyon", "natives")');
		expect(loaderState).toContain('path.join(os.homedir(), ".veyyon", "natives")');
	});
});

describe("uninstall reclaims the native addon cache in both installers", () => {
	it("install.sh removes the XDG cache only when $XDG_DATA_HOME/veyyon exists", () => {
		// Guarding on the directory (not merely on the variable being set) is what
		// makes uninstall remove the SAME directory the loader would have written.
		expect(shUninstall).toMatch(/\[ -n "\$\{XDG_DATA_HOME:-\}" \] && \[ -d "\$XDG_DATA_HOME\/veyyon" \]/);
		expect(shUninstall).toContain('natives_cache="$XDG_DATA_HOME/veyyon/natives"');
	});

	it("install.sh falls back to ~/.veyyon/natives, matching os.homedir()", () => {
		expect(shUninstall).toContain('natives_cache="$HOME/.veyyon/natives"');
		expect(shUninstall).toContain('rm -rf "$natives_cache"');
	});

	it("install.ps1 removes the XDG cache only when $XDG_DATA_HOME/veyyon exists", () => {
		expect(ps1Uninstall).toContain('$env:XDG_DATA_HOME -and (Test-Path (Join-Path $env:XDG_DATA_HOME "veyyon"))');
		expect(ps1Uninstall).toContain('Join-Path $env:XDG_DATA_HOME "veyyon\\natives"');
	});

	it("install.ps1 falls back to %USERPROFILE%\\.veyyon\\natives, matching os.homedir() on Windows", () => {
		expect(ps1Uninstall).toContain('Join-Path $env:USERPROFILE ".veyyon\\natives"');
		expect(ps1Uninstall).toContain("Remove-Item -Recurse -Force $nativesCache");
	});

	it("both uninstallers report the reclaimed cache instead of removing it silently", () => {
		// A 150MB reclaim is not a silent side effect: the user must see what was
		// freed, and the printed path is what they check if anything looks wrong.
		expect(shUninstall).toContain('ok "removed native addon cache $natives_cache"');
		expect(ps1Uninstall).toContain('"OK  removed native addon cache $nativesCache"');
	});
});

describe("uninstall never destroys user data under ~/.veyyon", () => {
	it("neither uninstaller recursively removes the whole ~/.veyyon tree", () => {
		// ~/.veyyon holds auth, config, profiles and sessions alongside the cache.
		// Only the `natives` subdirectory is the installer's to reclaim; widening
		// either removal to the parent would silently delete the user's credentials.
		expect(shUninstall).not.toMatch(/rm -rf "\$HOME\/\.veyyon"/);
		expect(shUninstall).not.toMatch(/rm -rf "\$\{?HOME\}?\/\.veyyon"\s*$/m);
		expect(ps1Uninstall).not.toContain('Join-Path $env:USERPROFILE ".veyyon"');
	});

	it("both uninstallers scope the removal to a path ending in the natives cache dir", () => {
		for (const [name, body] of [
			["install.sh", shUninstall],
			["install.ps1", ps1Uninstall],
		] as const) {
			const removals = body.match(/(?:rm -rf "\$natives_cache"|Remove-Item -Recurse -Force \$nativesCache)/g) ?? [];
			expect(removals.length, `${name} should perform exactly one native-cache removal`).toBe(1);
		}
	});
});

describe("uninstall clears addons staged beside the binary", () => {
	it("both uninstallers sweep veyyon_natives.*.node out of the install dir", () => {
		// A compiled binary probes for a sibling addon; leaving one behind means a
		// reinstalled or differently-versioned binary can load a stale addon.
		expect(shUninstall).toContain('for n in "$d"/veyyon_natives.*.node; do');
		expect(ps1Uninstall).toContain('-Filter "veyyon_natives.*.node"');
	});
});

/**
 * The Windows binary install used to download STRAIGHT ONTO the installed
 * `veyyon.exe`, which made every failure destructive: a dropped connection, a
 * missing checksum sidecar, or a mismatch each ran `Remove-Item $OutPath` and
 * left the user with no veyyon at all, having started from a working one. It
 * also cannot work at all while a session is open, because Windows locks a
 * running image.
 *
 * install.sh has staged its download since the concurrent-install fix; this is
 * the Windows half of that contract, plus the leftovers it introduces.
 */
describe("the Windows binary install stages its download", () => {
	it("downloads to a per-process staging path, not onto the installed binary", () => {
		expect(installPs1).toContain('$StagingPath = Join-Path $InstallDir ".$BinName.$PID.download"');
		expect(installPs1).toContain("-OutFile $StagingPath");
		expect(installPs1).not.toContain("-OutFile $OutPath");
	});

	it("discards the staged file on every verification failure, never the install", () => {
		// The whole point: a failed install must not be an uninstall.
		const fn = installPs1.slice(installPs1.indexOf("function Install-Binary {"));
		// Comments explaining the old destructive form are not that form.
		const body = fn
			.slice(0, fn.indexOf("\nfunction "))
			.split("\n")
			.filter(line => !line.trimStart().startsWith("#"))
			.join("\n");
		expect(body).not.toContain("Remove-Item $OutPath");
		expect((body.match(/Remove-Item \$StagingPath -ErrorAction SilentlyContinue/g) ?? []).length).toBeGreaterThanOrEqual(
			4,
		);
	});

	it("moves the previous binary aside rather than overwriting a locked image", () => {
		expect(installPs1).toContain("function Move-StagedBinaryIntoPlace {");
		expect(installPs1).toContain(".$PID.old");
	});

	it("restores the previous binary when the swap itself fails", () => {
		const fn = installPs1.slice(installPs1.indexOf("function Move-StagedBinaryIntoPlace {"));
		const body = fn.slice(0, fn.indexOf("\nfunction "));
		expect(body).toContain("Move-Item -Path $aside -Destination $TargetPath -Force");
		expect(body).toContain("your previous $BinName is untouched");
	});

	it("sweeps moved-aside binaries on the next run instead of failing this one", () => {
		// A `.old` still mapped by a running process cannot be deleted, and
		// failing an otherwise-good install over it would be absurd.
		expect(installPs1).toContain("function Clear-StaleBinaryBackups {");
		expect(installPs1).toContain('Clear-StaleBinaryBackups -Dir $InstallDir -BaseName "$BinName.exe"');
	});

	it("uninstall reclaims the staging and moved-aside files too", () => {
		// They are the installer's own litter; leaving ~150MB of them behind
		// while reporting a clean uninstall is the same bug as the natives cache.
		const fn = installPs1.slice(installPs1.indexOf("function Uninstall-Veyyon {"));
		const body = fn.slice(0, fn.indexOf("\nfunction "));
		expect(body).toContain('-Filter "*.old"');
		expect(body).toContain('-Filter ".$BinName.*.download"');
	});
});

/**
 * Neither uninstaller removed the PATH entry its install added. A user who
 * installed and then removed veyyon kept a PATH entry pointing at a directory
 * veyyon no longer occupies — on POSIX under a comment still claiming an
 * installer put it there.
 *
 * The removal is surgical on both sides: an rc is a file the user also edits by
 * hand, and a Windows user PATH holds entries from every tool on the machine.
 */
describe("uninstall takes back the PATH entry install added", () => {
	it("install.sh and its uninstall agree on the exact line, through one owner", () => {
		// Without a single owner the uninstall has to guess at install's text, and
		// a guess either leaves the line forever or deletes one the user wrote.
		expect(installSh).toContain("path_line_for() {");
		expect(installSh).toContain('line=$(path_line_for "$rc" "$dir")');
		expect(installSh).toContain("remove_path_line_from_rc() {");
	});

	it("install.sh checks every rc a past install could have chosen", () => {
		// A user who changed shells since installing still carries the old
		// shell's line.
		expect(installSh).toContain("rc_candidates() {");
		for (const rc of [".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", "config.fish"]) {
			expect(installSh, `rc_candidates must cover ${rc}`).toContain(rc);
		}
	});

	it("install.sh rewrites the rc in place, so a dotfiles symlink stays a symlink", () => {
		// `mv` would replace a symlink into a dotfiles repo with a regular file
		// and silently detach the user's config from their repo.
		const fn = fnBody(installSh, "remove_path_line_from_rc() {", "\n}\n");
		expect(fn).toContain('cat "$tmp" > "$rc"');
		expect(fn).not.toMatch(/\bmv\b[^\n]*"\$rc"/);
	});

	it("install.sh drops the marker comment only when it sits above our line", () => {
		const fn = fnBody(installSh, "remove_path_line_from_rc() {", "\n}\n");
		expect(fn).toContain('[ "$_pending" = "$PATH_MARKER" ]');
	});

	it("install.ps1 removes the entry from the user PATH", () => {
		expect(installPs1).toContain("function Remove-FromPath {");
		expect(installPs1).toContain("function Get-PathWithoutDir {");
		expect(installPs1).toContain("removed $InstallDir from your PATH");
	});

	it("install.ps1 compares entries the same way the add does", () => {
		// Matching loosely would take an unrelated directory with it; matching
		// strictly by raw string would miss a trailing-backslash variant.
		const fn = installPs1.slice(installPs1.indexOf("function Get-PathWithoutDir {"));
		const body = fn.slice(0, fn.indexOf("\nfunction "));
		expect(body).toContain("$_.TrimEnd('\\') -ine $want");
	});

	it("install.sh reclaims staging files a killed install left behind", () => {
		// The Windows side already sweeps its equivalents.
		expect(installSh).toContain('for stale in "$(install_dir)/.$BIN_NAME".*; do');
	});
});

/**
 * A zero-byte staged file must never become the installed binary.
 *
 * install.sh has refused one since finalize_binary existed. install.ps1 had no
 * such guard: Invoke-WebRequest writes the file before it knows the body is
 * empty, and `-NoVerify` skips the checksum entirely, so an empty asset
 * installed cleanly and the user got a veyyon that could not start — with the
 * previous working binary already moved aside.
 */
describe("neither installer moves an empty staged file into place", () => {
	it("install.sh refuses it in finalize_binary", () => {
		expect(installSh).toContain('[ -s "$tmp" ] || die "the binary staged at $tmp is empty');
	});

	it("install.ps1 refuses it at the same boundary, not at the call site", () => {
		// Putting the check inside the move means every caller inherits it,
		// rather than each remembering to repeat it.
		const fn = installPs1.slice(installPs1.indexOf("function Move-StagedBinaryIntoPlace {"));
		const body = fn.slice(0, fn.indexOf("\nfunction "));
		expect(body).toContain("if (-not $staged -or $staged.Length -eq 0) {");
		expect(body).toContain("is empty - refusing to install");
	});

	it("install.ps1 checks BEFORE the target is moved aside", () => {
		// Moving the working binary aside first and then failing is an uninstall,
		// not a failed install.
		const fn = installPs1.slice(installPs1.indexOf("function Move-StagedBinaryIntoPlace {"));
		const body = fn.slice(0, fn.indexOf("\nfunction "));
		expect(body.indexOf("$staged.Length -eq 0")).toBeLessThan(body.indexOf("Move-Item -Path $TargetPath"));
	});

	it("both name the staged path and the next step in the refusal", () => {
		expect(installSh).toContain('refusing to install; $empty_hint');
		expect(installPs1).toContain("retry or use -Source");
	});
});

/**
 * The closing verdict has to match what actually happened.
 *
 * `rc_candidates | while ...` ran the PATH-line loop in a SUBSHELL, so the
 * `removed` flag set inside it was discarded: an uninstall whose only remaining
 * artifact was the PATH line printed that it had removed the line and then
 * "nothing to uninstall." on the very next line. The completion removals had
 * the same visible defect for a different reason — they never set the flag at
 * all. Both make the installer look like it did nothing when it did.
 */
describe("install.sh reports what it removed, in the shell that tracks it", () => {
	it("the PATH-line loop does not run in a subshell", () => {
		// The specific regression: a pipeline into `while` cannot set `removed`.
		// Comments are stripped first — the one explaining this bug names it.
		const code = installSh
			.split("\n")
			.filter(line => !line.trimStart().startsWith("#"))
			.join("\n");
		expect(code).not.toContain("rc_candidates | while");
		expect(code).toContain("_rc_list=$(rc_candidates)");
		expect(code).toContain("for rc in $_rc_list; do");
	});

	it("the loop pins IFS to a newline so a $HOME with a space still splits", () => {
		// Unquoted expansion is what keeps the loop in this shell; default IFS
		// would then split a path on its spaces, and the loop would try to remove
		// the PATH line from two halves of one filename.
		const from = installSh.indexOf("_rc_list=$(rc_candidates)");
		const loop = installSh.slice(from, installSh.indexOf("for stale in", from));
		expect(loop).toContain("_old_ifs=$IFS");
		expect(loop).toContain("IFS=$_old_ifs");
	});

	it("removing the PATH line counts toward the verdict", () => {
		expect(installSh).toContain('ok "removed the veyyon PATH line from $rc"\n            removed=1');
	});

	it("removing either completion file counts toward the verdict", () => {
		expect(installSh).toContain(`{ ok "removed $sh completion for '$ALIAS_NAME'"; removed=1; }`);
		expect(installSh).toContain(`{ ok "removed $sh completion for '$BIN_NAME'"; removed=1; }`);
	});
});

/**
 * `cat "$tmp" > "$rc"` truncates the rc BEFORE cat runs, so a cat that fails
 * partway (a full disk, an I/O error) leaves the rc empty with the temp file
 * holding the only copy of the user's content. The failure branch deleted that
 * temp, destroying a file the uninstall had just emptied.
 */
describe("a failed rc rewrite never destroys the rc", () => {
	it("the temp file is kept when the rewrite fails", () => {
		const fn = fnBody(installSh, "remove_path_line_from_rc() {", "\n}\n");
		const failure = fn.slice(fn.indexOf("could not rewrite"));
		expect(failure).not.toContain('rm -f "$tmp"');
	});

	it("the warning names the file and the command that restores it", () => {
		// "could not rewrite your .bashrc" with an empty .bashrc and no next step
		// is the worst possible message.
		expect(installSh).toContain('its previous contents are in $tmp');
		expect(installSh).toContain(`restore it with: cp '$tmp' '$rc'`);
	});

	it("the success path still removes the temp", () => {
		// Keeping it there would litter the user's home on every uninstall.
		const fn = fnBody(installSh, "remove_path_line_from_rc() {", "\n}\n");
		expect(fn).toContain('if cat "$tmp" > "$rc"; then\n        rm -f "$tmp"');
	});
});
