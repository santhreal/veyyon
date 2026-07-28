import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { existingOnly, readIfPresent } from "./check-doc-links";

/**
 * Locks the release gate to the install methods veyyon actually ships, and locks
 * the npm topology out for good.
 *
 * veyyon is distributed GitHub-only through two channels: the prebuilt binary
 * (`curl | sh`) and a source checkout (`install.sh --source`). It is not on npm
 * or bun and never will be — the workspace pins its own packages with
 * `workspace:*` and `catalog:` protocols, which resolve only inside a checkout,
 * so a registry install could not work even if one were published.
 *
 * `scripts/install-tests/run-ci.sh` used to pack every workspace package, write
 * bun `overrides` pointing each dep at a tarball, `bun add` the set, and smoke
 * the result — reproducing a published npm topology no user could ever install
 * through. That simulation was pure cost: its hand-kept package lists drifted
 * from the real manifests twice and silently gated EVERY release (BACKLOG
 * ARGOT-1 / PREPACK-1), because `install_methods` is a hard dependency of
 * `release_binary`. It is gone, along with the publish orchestration that
 * existed only to serve it.
 *
 * These tests fail if any of it comes back, and if the gate stops covering
 * either real channel.
 */

const repoRoot = path.resolve(import.meta.dir, "..");
const runCiPath = path.join(repoRoot, "scripts", "install-tests", "run-ci.sh");
const runCi = fs.readFileSync(runCiPath, "utf8");
/**
 * The end-to-end assertions themselves, which run-ci.sh now sources.
 *
 * They moved out of run-ci.sh so `published-release-e2e.sh` could drive the same
 * contract against the release a user downloads, rather than a second copy that
 * drifts. The checks below follow them: what matters is that the gate still makes
 * them, not which file the lines sit in.
 */
const installerE2e = fs.readFileSync(
	path.join(repoRoot, "scripts", "install-tests", "installer-e2e-lib.sh"),
	"utf8",
);

/** Files that existed only to build or publish the npm/tarball topology. */
const removedNpmMachinery = [
	"scripts/ci-release-publish.ts",
	"scripts/fix-dts-extensions.ts",
	"scripts/fix-dts-extensions.test.ts",
	"scripts/install-tests/tarball.dockerfile",
	"packages/natives/scripts/gen-npm-packages.ts",
	"packages/natives/test/npm-packages.test.ts",
];

/**
 * Every tracked markdown file, repo-relative. Walks git's own file list so
 * node_modules, build output, and untracked scratch files can never make the
 * check pass or fail by accident.
 */
function markdownFiles(root: string): string[] {
	const out = Bun.spawnSync(["git", "ls-files", "*.md"], { cwd: root });
	expect(out.exitCode, "git ls-files must succeed").toBe(0);
	// `existingOnly`: git lists the INDEX, which still contains a doc deleted in
	// the working tree but not yet committed. Reading one killed this test with a
	// raw ENOENT naming that file — an error about tree state, in a test about
	// install instructions. A deleted doc also cannot tell a user to install
	// anything, so skipping it is the correct answer and not a workaround.
	return existingOnly(
		root,
		new TextDecoder()
			.decode(out.stdout)
			.split("\n")
			.filter(line => line.length > 0),
	);
}

describe("the release gate covers both shipped install channels", () => {
	it("smokes the prebuilt binary a curl | sh install puts on PATH", () => {
		expect(runCi).toContain("Binary install smoke");
		expect(runCi).toContain("cp packages/coding-agent/dist/vey");
		expect(runCi).toContain('smoke_cli "$BINARY_DIR/veyyon"');
	});

	it("smokes the committed source launcher install.sh --source symlinks onto PATH", () => {
		// `bun link` alone does not exercise the launcher, so a broken launcher
		// could pass the gate and still break every source install.
		expect(runCi).toContain("packages/coding-agent/scripts/veyyon");
		expect(runCi).toContain('smoke_cli "$LAUNCHER"');
	});

	it("fails loudly when the source launcher is missing rather than skipping it", () => {
		// Law 10: a missing launcher must fail the gate, never silently reduce
		// coverage to the binary channel.
		expect(runCi).toContain("source launcher missing or not executable");
	});

	it("runs the installer helper unit tests before the build-heavy smokes", () => {
		const helpers = runCi.indexOf("functions.test.sh");
		const build = runCi.indexOf("bun --cwd=packages/natives run build");
		expect(helpers).toBeGreaterThan(-1);
		expect(build).toBeGreaterThan(helpers);
	});
});

describe("the npm/tarball topology stays deleted", () => {
	it("the gate packs no tarballs and writes no bun overrides", () => {
		for (const banned of ["bun pm pack", "pkg.overrides", "find_tarball", "_tgz", "for pkg in "]) {
			expect(runCi, `run-ci.sh must not reintroduce \`${banned}\``).not.toContain(banned);
		}
	});

	it("the gate no longer imports the publish orchestration", () => {
		expect(runCi).not.toContain("ci-release-publish");
		expect(runCi).not.toContain("applyPublishBin");
		expect(runCi).not.toContain("prepareNativeCorePackage");
		expect(runCi).not.toContain("gen:npm");
	});

	it("every file that existed only to publish to npm is gone", () => {
		for (const rel of removedNpmMachinery) {
			expect(fs.existsSync(path.join(repoRoot, rel)), `${rel} should not exist`).toBe(false);
		}
	});

	it("no manifest still offers an npm-packaging script", () => {
		const natives = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "packages", "natives", "package.json"), "utf8"),
		) as { scripts?: Record<string, string> };
		expect(natives.scripts?.["gen:npm"]).toBeUndefined();
	});

	it("the podman runner no longer builds a tarball image", () => {
		const podman = fs.readFileSync(path.join(repoRoot, "scripts", "install-tests", "run-podman.sh"), "utf8");
		expect(podman).not.toContain("tarball.dockerfile");
		// The two real channels keep their images.
		expect(podman).toContain("binary.dockerfile");
		expect(podman).toContain("source.dockerfile");
	});

	it("no document tells a user to install a veyyon package from a registry", () => {
		// Five docs carried `bun add @veyyon/...` / `npm install @veyyon/...`.
		// Every one of those commands fails at resolution: nothing is published,
		// and the packages depend on each other through `workspace:*`/`catalog:`,
		// which resolve only inside a checkout. A documented install method that
		// cannot work is worse than none — the user blames their own setup.
		const offenders: string[] = [];
		for (const rel of markdownFiles(repoRoot)) {
			// The changelog is a historical record; rewriting it would falsify it.
			if (rel.endsWith("CHANGELOG.md")) continue;
			// `existingOnly` above filters the index listing, but the tree can still change between that
			// filter and this read (a parallel checkout, a rebase, a generator run). `readIfPresent` skips
			// only a file that has since been DELETED -- which cannot document an install method -- and still
			// throws on anything else, so a permissions problem cannot quietly shrink this scan.
			const text = readIfPresent(path.join(repoRoot, rel));
			if (text === undefined) continue;
			for (const [i, line] of text.split("\n").entries()) {
				if (/^\s*(?:npm|bun|pnpm|yarn)\s+(?:i|add|install)\s+@veyyon\//.test(line)) {
					offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
				}
			}
		}
		expect(offenders, "these commands cannot resolve; document the checkout + `bun link` path").toEqual([]);
	});

	it("the SDK guide documents the checkout path that does work", () => {
		// Removing the false instruction is only half the fix; the reader still
		// needs a working one, and it lives in exactly one place.
		const sdk = fs.readFileSync(path.join(repoRoot, "docs", "sdk.md"), "utf8");
		expect(sdk).toContain("bun --cwd=packages/coding-agent link");
		expect(sdk).toContain("bun link @veyyon/coding-agent");
		expect(sdk).toContain("are not on npm");
	});

	it("neither installer carries a registry package name to uninstall", () => {
		// Both ended uninstall with `bun remove -g @veyyon/coding-agent`. Nothing
		// was ever published under that name, so the step could never remove
		// anything; all it did was keep a registry package name alive in the one
		// place a reader looks to learn how veyyon is distributed.
		for (const [name, body] of [
			["install.sh", fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8")],
			["install.ps1", fs.readFileSync(path.join(repoRoot, "scripts", "install.ps1"), "utf8")],
		] as const) {
			expect(body, `${name} must not name a registry package`).not.toContain("@veyyon/coding-agent");
			expect(body, `${name} must not uninstall a global registry package`).not.toContain("bun remove -g");
		}
	});

	it("npm appears in the gate only where it is being denied", () => {
		// A stray `npm` mention would signal the topology creeping back; the only
		// allowed use is prose explaining why there is no registry channel.
		for (const line of runCi.split("\n")) {
			if (!/\bnpm\b/.test(line)) continue;
			expect(line.trimStart().startsWith("#"), `unexpected npm usage: ${line.trim()}`).toBe(true);
		}
	});
});

/**
 * The two smokes above run the ARTIFACTS each channel produces. Neither runs
 * install.sh, so everything the installer does around the binary — the alias,
 * the completions, the shell rc edit, the doctor self-check, and reclaiming all
 * of it on uninstall — was covered only by unit tests of the individual
 * functions. A user does not run those functions; they run the script.
 *
 * This is the dogfood half of the gate: the real script, driven end to end
 * against a sandboxed HOME with no network. These tests keep it from being
 * quietly weakened back into an exit-code check.
 */
describe("the gate runs the installer itself, not only what it installs", () => {
	it("drives install.sh end to end against a sandboxed HOME", () => {
		expect(runCi).toContain('section "Installer end-to-end (--local install, then --uninstall)"');
		expect(runCi).toContain('installer_end_to_end "$WORK_DIR" --local');
		expect(installerE2e).toContain('installer_env sh "$install_sh" "$@"');
		expect(installerE2e).toContain('installer_env sh "$install_sh" --uninstall');
	});

	/**
	 * Both callers, so neither can quietly stop running the contract. The
	 * published-release script is the one that would go unnoticed: it runs on
	 * fewer commits and is the install users actually get.
	 */
	it("drives the same contract against the published release", () => {
		const published = fs.readFileSync(
			path.join(repoRoot, "scripts", "install-tests", "published-release-e2e.sh"),
			"utf8",
		);
		expect(published).toContain("installer-e2e-lib.sh");
		// No mode argument: the default IS the published-release download.
		expect(published).toContain('installer_end_to_end "$WORK_DIR"');
		// The call itself, not the file: `--local` is named in the header, which
		// explains what this script exists to cover that run-ci.sh does not.
		expect(published.split("\n").filter(line => /^installer_\w+ .*--local/.test(line))).toEqual([]);
	});

	it("isolates every directory the installer writes to", () => {
		// Without all four, the gate edits the developer's or the runner's real
		// dotfiles and completion directories.
		for (const variable of ["HOME=", "XDG_DATA_HOME=", "XDG_CONFIG_HOME=", "VEYYON_INSTALL_DIR="]) {
			expect(installerE2e, `installer_env must set ${variable}`).toContain(variable);
		}
	});

	it("runs with a minimal PATH so the host's own veyyon cannot change the result", () => {
		// An installed veyyon earlier on the runner's PATH shadows the sandbox
		// copy, which makes doctor's output depend on the machine. `/usr/local/bin`
		// is on it because the published-release mode needs curl, and nothing else.
		expect(installerE2e).toContain('env PATH="/usr/local/bin:/usr/bin:/bin"');
	});

	it("asserts the real files, not the installer's exit code", () => {
		// An install that exits 0 having placed nothing would pass an exit-code
		// check. Each of these is a file a user would go looking for.
		expect(installerE2e).toContain('expect_exists "$installer_bin/veyyon"');
		expect(installerE2e).toContain('expect_exists "$installer_bin/vey"');
		expect(installerE2e).toContain('expect_exists "$installer_home/.local/share/bash-completion/completions/veyyon"');
		expect(installerE2e).toContain('expect_exists "$installer_home/.local/share/zsh/site-functions/_veyyon"');
		expect(installerE2e).toContain('expect_exists "$installer_home/.config/fish/completions/veyyon.fish"');
	});

	it("checks the alias is a symlink and the binary is executable", () => {
		expect(installerE2e).toContain('[ -x "$installer_bin/veyyon" ]');
		expect(installerE2e).toContain('[ -L "$installer_bin/vey" ]');
	});

	/**
	 * The rc assertion matches the bytes `path_line_for` writes, single quotes included.
	 *
	 * The directory is SINGLE-quoted and `$PATH` is not, which is the shape
	 * `scripts/install.sh` produces and the shape its uninstall recognises its own
	 * line by. It was double-quoted once, and a directory whose name contains `$`
	 * then expanded when the rc was sourced: the user got `command not found` in a
	 * shell whose rc plainly named the right directory. This test asserted the old
	 * double-quoted form and so failed every run after the fix landed, which is the
	 * hazard of pinning a script's text rather than its behaviour. Both spellings
	 * are checked now: the one the gate greps for, and the fact that the installer
	 * builds it through the one owner rather than spelling it inline.
	 */
	it("checks the PATH line and its marker landed in the rc", () => {
		// `String.raw`, because the assertion is about backslashes: written as an
		// ordinary literal the escapes are read twice, once by TypeScript and once
		// by the reader, and the two disagree.
		expect(installerE2e).toContain(String.raw`local path_line="export PATH='$installer_bin':\"\$PATH\""`);
		expect(installerE2e).toContain('grep -Fqx "$path_line" "$rc"');
		// The rc is DISCOVERED by its marker rather than named: bash reads
		// `.bashrc` on Linux and `.bash_profile` on macOS, and pinning one spelling
		// failed every macOS run about an install that had done the right thing.
		expect(installerE2e).toContain('grep -Fqx "# added by the veyyon installer" "$candidate"');
		expect(installerE2e).toContain("the PATH line is in more than one rc");
	});

	/** And the installer really writes that shape, so the gate is not pinned to a fiction. */
	it("pins the same quoting the installer's one PATH-line owner produces", () => {
		const installer = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf-8");

		expect(installer).toContain(`*) printf 'export PATH=%s:"$PATH"' "$(shell_single_quote "$2")" ;;`);
		// The pre-fix spelling survives in ONE place only: the uninstall's list of
		// lines an older install may have left behind. Anywhere else it is the bug.
		expect(installer).toContain(`*) printf 'export PATH="%s:$PATH"\\n' "$2" ;;`);
	});

	it("reinstalls once more and proves the rc line is not duplicated", () => {
		// Re-running the installer is the single most common user action after
		// the first install, and appending the line again on every run is the
		// obvious way to get it wrong.
		expect(installerE2e).toContain('path_lines="$(grep -Fxc');
		expect(installerE2e).toContain('[ "$path_lines" = "1" ]');
	});

	it("proves uninstall reclaims every file it wrote", () => {
		expect(installerE2e).toContain('expect_absent "$installer_bin/veyyon"');
		expect(installerE2e).toContain('expect_absent "$installer_home/.local/share/bash-completion/completions/vey"');
		expect(installerE2e).toContain('expect_absent "$installer_home/.config/fish/completions/vey.fish"');
		expect(installerE2e).toContain('uninstall left the PATH line in $rc');
	});

	it("proves uninstall leaves the user's own rc content alone", () => {
		// "Removes everything it added, and only what it added" is the documented
		// contract; the second half is the one that costs a user their config.
		expect(installerE2e).toContain('echo "alias ll=\'ls -la\'" >> "$rc"');
		expect(installerE2e).toContain("uninstall removed the user's own rc content");
	});

	it("proves the install directory is empty afterwards, staging files included", () => {
		expect(installerE2e).toContain('leftovers="$(ls -A "$installer_bin" 2>/dev/null || true)"');
		expect(installerE2e).toContain("uninstall left files behind");
	});
});
