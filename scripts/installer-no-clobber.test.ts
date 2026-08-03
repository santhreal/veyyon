import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The installer may never destroy a file it did not create.
 *
 * Both installers wrote the `vey` alias unconditionally: POSIX used `ln -sf`,
 * which unlinks whatever sits at the path first, and Windows used `Set-Content`,
 * which overwrites. A user with their own `vey` script or shim in the install
 * directory lost it silently and unrecoverably — no prompt, no warning, no
 * backup, on a command they only ran to install a CLI.
 *
 * The rule now: only replace something this installer could itself have put
 * there (a link/shim already pointing at our binary, or a dangling link with
 * nothing to lose). Anything else is the user's and is reported, not removed.
 *
 * Behavioral coverage lives in scripts/install-tests/functions.test.sh (POSIX,
 * runs locally); this suite holds the cross-platform contract, since pwsh is not
 * available on the Linux dev host.
 */

const repoRoot = path.resolve(import.meta.dir, "..");
const installSh = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");
const installPs1 = fs.readFileSync(path.join(repoRoot, "scripts", "install.ps1"), "utf8");

/** The alias-writing function body from each installer. */
function fnBody(body: string, start: string, end: string): string {
	const from = body.indexOf(start);
	expect(from, `missing ${start}`).toBeGreaterThan(-1);
	const to = body.indexOf(end, from);
	expect(to, `missing terminator after ${start}`).toBeGreaterThan(from);
	return body.slice(from, to);
}

const shLinkAlias = fnBody(installSh, "link_alias() {", "\n}\n");
const ps1InstallAlias = fnBody(installPs1, "function Install-Alias {", "\n}\n");

describe("the alias is never written over a file the installer did not create", () => {
	it("install.sh no longer force-links over the alias path", () => {
		// `ln -sf` is the destructive form: it unlinks the existing path first.
		// The only remaining forced link is the dangling-symlink repair, which
		// cannot lose data.
		// Comments explaining WHY `ln -sf` was wrong are not uses of it, so count
		// only executable lines.
		const code = shLinkAlias
			.split("\n")
			.filter(l => !l.trimStart().startsWith("#"))
			.join("\n");
		const forced = code.match(/ln -sf/g) ?? [];
		expect(forced.length, "ln -sf may only remain for the dangling-link repair").toBe(1);
		expect(code).toContain("ln -s ");
	});

	it("install.sh replaces only a link that already points at our binary", () => {
		expect(shLinkAlias).toContain('[ "$(readlink "$link" 2>/dev/null)" = "$target" ]');
	});

	it("install.ps1 rewrites only a shim with its exact forwarding command", () => {
		expect(ps1InstallAlias).toContain("Test-AliasBodyForTarget -Body $existing -Target $Target");
		expect(ps1InstallAlias).toContain("already points at $BinName");
	});

	it("both report the collision instead of silently skipping it", () => {
		// Law 10: declining to create the alias changes what the user gets, so it
		// must be visible, not a quiet no-op.
		expect(shLinkAlias).toContain("left '$ALIAS_NAME' alone");
		expect(ps1InstallAlias).toContain("left '$AliasName' alone");
	});

	it("both tell the user how to launch in the meantime", () => {
		// A warning that only says "cannot do it" leaves the user stuck; the binary
		// name still works and the message has to say so.
		expect(shLinkAlias).toContain("launch with '$BIN_NAME'");
		expect(ps1InstallAlias).toContain("launch with '$BinName'");
	});

	it("neither deletes or backs up the conflicting file", () => {
		// The fix is to leave it alone. Moving it aside would be another surprise
		// mutation of a directory the user owns.
		for (const [name, body] of [
			["install.sh", shLinkAlias],
			["install.ps1", ps1InstallAlias],
		] as const) {
			expect(body, `${name} must not remove the conflicting alias`).not.toMatch(/\brm -rf\b/);
			expect(body, `${name} must not rename the conflicting alias`).not.toMatch(/\.bak\b/);
		}
	});
});

describe("declining the alias also declines its completion file", () => {
	// The no-clobber rule has a second half. link_alias refusing to create `vey`
	// did nothing to stop install_completions, which wrote `completions/vey`
	// regardless — a file describing OUR subcommands under THEIR command name,
	// written straight over the completion script their tool shipped. install.ps1
	// has no counterpart only because Windows installs no completions.
	it("install.sh gates the alias completion on the recorded verdict", () => {
		expect(installSh).toContain("ALIAS_IS_OURS=0");
		expect(installSh).toContain('&& [ "$ALIAS_IS_OURS" = 1 ]; then');
	});

	it("link_alias is the only thing that decides, and sets it on every exit", () => {
		// ONE PLACE: link_alias is the only code that inspects and writes the
		// alias, so it owns the answer. install_completions and doctor read it.
		// Re-deriving it needed `readlink`, which doctor cannot depend on — doctor
		// exists to diagnose a broken PATH, and on a broken PATH that fork fails
		// and the alias silently reads as "not ours".
		const fn = fnBody(installSh, "link_alias() {", "\n}\n");
		// One reset at entry plus one claim per path that ends with the alias
		// pointing at our binary: kept, repaired, created.
		expect(fn.match(/ALIAS_IS_OURS=0/g) ?? []).toHaveLength(1);
		expect(fn.match(/ALIAS_IS_OURS=1/g) ?? []).toHaveLength(3);
		const doctorFn = fnBody(installSh, "doctor() {", "\n}\n");
		expect(doctorFn).not.toContain("readlink");
	});

	it("install.ps1 decides the same way before its shadow check", () => {
		expect(installPs1).toContain("function Test-AliasPointsAtUs {");
		expect(installPs1).toContain("if (Test-AliasPointsAtUs -BinPath $Command) {");
	});

	it("doctor says the alias is not ours instead of calling it a shadow", () => {
		// Reporting that the user's own `vey` "shadows the copy just installed"
		// and telling them to remove it is false: no `vey` was installed at all.
		expect(installSh).toContain("is not ours — launch with '$BIN_NAME'");
		expect(installPs1).toContain("is not ours - launch with '$BinName'");
	});

	it("uninstall removes the alias completion only when it can prove it wrote it", () => {
		/**
		 * CONTRACT: uninstall deletes `completions/vey` only when that file is
		 * ours, and reports leaving it when it is not. Without the gate,
		 * uninstalling veyyon deletes the completion file of a `vey` the install
		 * was careful never to touch on the way in.
		 *
		 * The previous form pinned `cmp -s "$out/$name" "$out/$alias_name"`, the
		 * byte-compare that used to serve as the signature. That spelling is gone,
		 * and it was the weaker of the two checks. Byte equality is a coincidence,
		 * not ownership: it answers "not ours" for an alias completion we wrote and
		 * later regenerated at a different version, stranding the file forever, and
		 * it answers "ours" for a stranger's file that happens to match ours. It
		 * also required `$out/$name` to still exist, so a binary completion already
		 * removed by hand orphaned the alias completion permanently.
		 *
		 * `completion_artifact_is_ours` decides on the durable receipt instead, and
		 * falls back to the shell-specific Veyyon registration so completions
		 * written before receipts existed are still reclaimed. Asserting the gate
		 * AND the absence of any byte-compare keeps the weaker signature from
		 * quietly returning.
		 */
		expect(installSh).toContain('completion_artifact_is_ours "$out/$alias_name" "$sh"');
		expect(installSh).toContain("left $sh completion for '$ALIAS_NAME' alone");
		expect(installSh).not.toContain("cmp -s");
	});
});

/**
 * Declining to CREATE the alias was only half the rule.
 *
 * Both installers already refuse to overwrite a `vey` the user owns, and refuse
 * to write a completion file under that name. But the completion script written
 * under our OWN name BINDS the alias too — `complete -F _veyyon veyyon vey`,
 * `#compdef veyyon vey`, `complete -c vey -w veyyon`, and a PowerShell
 * registration naming both — so every shell applied our completions to the
 * user's `vey` regardless of which files were copied. Their tool completed our
 * subcommands.
 *
 * `veyyon completions <shell> --no-alias` drops the binding at the source, and
 * each installer passes it exactly when the alias is not its own.
 */
describe("an alias the installer does not own is not completed either", () => {
	it("install.sh asks for --no-alias off the recorded ownership verdict", () => {
		expect(installSh).toContain('[ "$ALIAS_IS_OURS" = 1 ] || alias_flag="--no-alias"');
		expect(installSh).toContain('"$bin" completions "$sh" $alias_flag');
	});

	it("install.ps1 records the same verdict in one place and reads it", () => {
		// Re-deriving ownership at the completion step is how the two answers
		// drift; link_alias/Install-Alias is the only code that inspects the shim.
		expect(installPs1).toContain("$Script:AliasIsOurs = $false");
		expect(installPs1).toContain("$generated = & $BinPath completions powershell --no-alias 2>$null");
	});

	it("install.ps1 claims ownership only on the paths that wrote the shim", () => {
		const fn = installPs1.slice(installPs1.indexOf("function Install-Alias {"));
		const body = fn.slice(0, fn.indexOf("\n}\n"));
		// Reset at entry, set on "already ours" and on a fresh write, and never
		// set on the branch that leaves a foreign shim alone.
		expect((body.match(/\$Script:AliasIsOurs = \$true/g) ?? []).length).toBe(2);
		// The foreign branch returns immediately; nothing between the message and
		// that return may claim ownership.
		const from = body.indexOf("was not created by this installer");
		const foreign = body.slice(from, body.indexOf("return", from));
		expect(foreign).not.toContain("$Script:AliasIsOurs = $true");
	});

	it("install.ps1 decides the alias before it writes completions", () => {
		// Reading the verdict before Install-Alias has run would read the initial
		// false and drop the alias binding on every install.
		for (const [alias, completions] of [
			["Install-Alias -Target $shim", "Install-Completions -BinPath $shim"],
			["Install-Alias -Target $OutPath", "Install-Completions -BinPath $OutPath"],
		] as const) {
			expect(installPs1.indexOf(alias)).toBeGreaterThan(-1);
			expect(installPs1.indexOf(alias)).toBeLessThan(installPs1.indexOf(completions));
		}
	});
});

/**
 * The other half, found by driving the real installer: both uninstallers
 * deleted `vey` unconditionally, so uninstalling veyyon destroyed a `vey` the
 * user already had — the very command the install had just refused to touch and
 * told them to keep using.
 */
describe("uninstall does not delete an alias the install refused to create", () => {
	it("install.sh removes the alias only when it points at our binary", () => {
		expect(installSh).toContain("alias_in_dir_is_ours() {");
		expect(installSh).toContain('[ "$(readlink "$_d/$ALIAS_NAME" 2>/dev/null)" = "$_d/$BIN_NAME" ]');
		expect(installSh).toContain('ok "left $d/$ALIAS_NAME alone (not created by this installer)"');
	});

	it("install.sh removes the binary only when it can prove it installed it", () => {
		/**
		 * CONTRACT: uninstall reclaims a `veyyon` this installer put in place, and
		 * leaves a `veyyon` it did not create alone, announcing which it chose.
		 *
		 * The previous form asserted the opposite, under the title "still removes
		 * the binary unconditionally", reasoning that `veyyon` is our name and
		 * leaving one behind is a failed uninstall. That was wrong on this suite's
		 * own premise: the installer may never destroy a file it did not create,
		 * and `finalize_binary` already REFUSES to overwrite a foreign `veyyon` on
		 * the way in. An unconditional delete on the way out meant install left the
		 * user's file alone and uninstall destroyed it, which is the data loss this
		 * file exists to prevent, reached by a longer route.
		 *
		 * It also pinned the pre-receipt spelling of the removal line, which now
		 * clears the ownership sidecar with `remove_owner_receipt`. Leaving that
		 * receipt behind would make the next unrelated file to take the name read
		 * as installer-owned, so the sweep is part of the contract, not tidiness.
		 *
		 * Both arms are pinned so neither can be dropped silently. The behavioural
		 * proof runs in scripts/installer-legacy-bun-uninstall.test.ts, which
		 * drives the real script and checks a foreign binary survives byte-for-byte
		 * while an owned one is reclaimed.
		 */
		expect(installSh).toContain(
			'rm -f "$d/$BIN_NAME" && { remove_owner_receipt "$d/$BIN_NAME"; ok "removed $d/$BIN_NAME"; removed=1; }',
		);
		expect(installSh).toContain('ok "left $d/$BIN_NAME alone (not created by this installer)"');
		expect(installSh).toContain("binary_artifact_is_ours() {");
	});

	it("install.ps1 applies the same gate to the vey.cmd shim", () => {
		expect(installPs1).toContain("function Test-AliasShimIsOurs {");
		expect(installPs1).toContain("if (Test-AliasShimIsOurs -ShimPath $aliasShim -BinDir $InstallDir) {");
		expect(installPs1).toContain("left $aliasShim alone (not created by this installer)");
	});

	it("install.ps1 recognizes both shapes of shim it writes", () => {
		// A binary install forwards to veyyon.exe, a source install to
		// veyyon.cmd. Matching only one would orphan the other on PATH forever.
		const fn = installPs1.slice(installPs1.indexOf("function Test-AliasShimIsOurs {"));
		const body = fn.slice(0, fn.indexOf("\nfunction "));
		expect(body).toContain('"$BinName.exe"');
		expect(body).toContain('"$BinName.cmd"');
	});

	it("install.ps1 matches an exact forwarding line, not a path substring", () => {
		// A shim written by an older installer can have a different header and
		// the same forwarding line. A user's script that only mentions our path
		// must not become installer-owned.
		const helper = fnBody(installPs1, "function Test-AliasBodyForTarget {", "\n}\n");
		expect(helper).toContain("$line.Trim() -ieq $forward");
		expect(helper).not.toContain(".Contains(");
		const fn = installPs1.slice(installPs1.indexOf("function Test-AliasShimIsOurs {"));
		const body = fn.slice(0, fn.indexOf("\nfunction "));
		expect(body).toContain("Test-AliasBodyForTarget -Body $body -Target $target");
	});
});

/**
 * The closing "Next steps" block was pasted into all three install modes and
 * hardcoded the alias, so an install that had just printed "left 'vey' alone,
 * launch with 'veyyon'" immediately told the user to run `vey` — which runs
 * their tool, not veyyon. Contradicting your own warning two lines later is how
 * a user concludes the warning did not matter.
 */
describe("the closing advice names a command that is actually ours", () => {
	it("one owner decides the launch command", () => {
		expect(installSh).toContain("launch_command() {");
		expect(installSh).toContain(
			`if [ "$ALIAS_IS_OURS" = 1 ]; then printf '%s' "$ALIAS_NAME"; else printf '%s' "$BIN_NAME"; fi`,
		);
	});

	it("every install mode prints the same block, from one place", () => {
		// Three pasted copies meant a change to the advice had to be made three
		// times or the modes disagreed about what to tell the user.
		expect(installSh).toContain("print_next_steps() {");
		expect((installSh.match(/^ {4}print_next_steps$/gm) ?? []).length).toBe(3);
		expect(installSh).not.toContain('say "  1. Launch in any repository: $ALIAS_NAME"');
	});
});

/**
 * A receipt that vouches for a path is a clobber waiting to happen.
 *
 * The sidecar both installers write beside an artifact used to hold one constant
 * line, so it said "this installer owns whatever is at this path". Delete the
 * installed binary by hand and the sidecar stayed; the next unrelated file to
 * take that name inherited the ownership, and the installer would overwrite it
 * while uninstall deleted it. That is precisely the data loss this file exists to
 * prevent, reached through the ownership record instead of through the alias.
 *
 * POSIX behaviour runs for real in scripts/install-tests/functions.test.sh and
 * end to end in scripts/installer-environment-matrix.test.ts. This is the
 * cross-platform half: pwsh does not exist on the Linux dev host, so the only way
 * to keep install.ps1 from drifting back to a path-only receipt between Windows
 * CI runs is to read the rule out of its source.
 */
describe("the ownership receipt identifies the file, on both platforms", () => {
	it("both installers record an identity rather than a constant", () => {
		expect(installSh).toContain("veyyon-installer-v2");
		expect(installPs1).toContain("veyyon-installer-v2");
		// The identity is derived from the artifact, so the writer must compute it
		// at write time instead of emitting a fixed body.
		expect(installSh).toContain('_owner_identity=$(artifact_identity "$1") || return 1');
		expect(installPs1).toContain("$identity = Get-ArtifactIdentity $Path");
	});

	it("both refuse to write a receipt they cannot back with an identity", () => {
		// A receipt recording nothing would be the old format under the new name,
		// and would reopen the hole for that artifact permanently. Fail closed.
		const shMark = fnBody(installSh, "mark_artifact_owned() {", "\n}\n");
		expect(shMark).toContain("|| return 1");
		const ps1Mark = fnBody(installPs1, "function Set-ArtifactOwned {", "\n}\n");
		expect(ps1Mark).toContain("its SHA256 identity could not be computed");
	});

	it("both accept a receipt only while the artifact still matches it", () => {
		const shCheck = fnBody(installSh, "artifact_has_owner_receipt() {", "\n}\n");
		expect(shCheck).toContain('_receipt_actual=$(artifact_identity "$1")');
		expect(shCheck).toContain('[ "$_receipt_recorded" = "$_receipt_actual" ]');
		const ps1Check = fnBody(installPs1, "function Test-ArtifactHasOwnerReceipt {", "\n}\n");
		expect(ps1Check).toContain("$actual = Get-ArtifactIdentity $Path");
		expect(ps1Check).toContain("return $recorded -eq $actual");
	});

	it("a receipt that cannot match outranks the structural evidence beside it", () => {
		// `vey` and `vey.cmd` survive any replacement of the binary next to them,
		// so an installer that fell through to them on a mismatch would hand a
		// stranger's file straight back and the identity check would buy nothing.
		expect(installSh).toContain('owner_receipt_identity "$_binary_path" >/dev/null 2>&1 && return 1');
		expect(installPs1).toContain("if (Get-OwnerReceiptIdentity $Path) { return $false }");
	});

	it("neither installer still treats the pre-identity body as ownership", () => {
		// The exact shape that was wrong, so it cannot come back by copy-paste. The
		// v1 body is still READ, by the helper that explains a refusal, so this
		// pins the two decision points rather than the string.
		const shCheck = fnBody(installSh, "artifact_has_owner_receipt() {", "\n}\n");
		expect(shCheck).not.toContain("veyyon-installer-v1");
		const ps1Check = fnBody(installPs1, "function Test-ArtifactHasOwnerReceipt {", "\n}\n");
		expect(ps1Check).not.toContain("veyyon-installer-v1");
	});

	it("both explain a refusal instead of calling every unowned file foreign", () => {
		// "not created by this installer" sends a user hunting for a second veyyon
		// that does not exist when the real answer is that their binary changed, or
		// that no sha256 tool is available to check. An undecidable question still
		// resolves to NO; it just says which question it could not answer.
		expect(installSh).toContain("binary_refusal_reason() {");
		expect(installSh).toContain('die "refusing to replace $dest because $(binary_refusal_reason "$dest")');
		expect(installPs1).toContain("function Get-BinaryRefusalReason {");
		expect(installPs1).toContain(
			'throw "refusing to replace $TargetPath because $(Get-BinaryRefusalReason $TargetPath)',
		);
	});

	it("a symlink is identified by its target, not by what the target holds", () => {
		// `--source` links at a git checkout that changes on every `git pull`,
		// which is how a source install updates. Hashing through the link would
		// mark every source install foreign the first time it advanced.
		const shIdentity = fnBody(installSh, "artifact_identity() {", "\n}\n");
		expect(shIdentity).toContain('_identity_target=$(readlink "$_identity_path" 2>/dev/null)');
		expect(shIdentity).toContain("printf 'link sha256:%s'");
		const ps1Identity = fnBody(installPs1, "function Get-ArtifactIdentity {", "\n}\n");
		expect(ps1Identity).toContain("if ($item.LinkType)");
		expect(ps1Identity).toContain('return "link sha256:$hash"');
	});
});
