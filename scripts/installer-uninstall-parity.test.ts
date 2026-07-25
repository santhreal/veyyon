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
