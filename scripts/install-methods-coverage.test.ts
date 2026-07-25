import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

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
	return new TextDecoder()
		.decode(out.stdout)
		.split("\n")
		.filter(line => line.length > 0);
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
			const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
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
		expect(runCi).toContain('installer_env sh "$ROOT_DIR/scripts/install.sh" --local');
		expect(runCi).toContain('installer_env sh "$ROOT_DIR/scripts/install.sh" --uninstall');
	});

	it("isolates every directory the installer writes to", () => {
		// Without all four, the gate edits the developer's or the runner's real
		// dotfiles and completion directories.
		for (const variable of ["HOME=", "XDG_DATA_HOME=", "XDG_CONFIG_HOME=", "VEYYON_INSTALL_DIR="]) {
			expect(runCi, `installer_env must set ${variable}`).toContain(variable);
		}
	});

	it("runs with a minimal PATH so the host's own veyyon cannot change the result", () => {
		// An installed veyyon earlier on the runner's PATH shadows the sandbox
		// copy, which makes doctor's output depend on the machine.
		expect(runCi).toContain('env PATH="/usr/bin:/bin"');
	});

	it("asserts the real files, not the installer's exit code", () => {
		// An install that exits 0 having placed nothing would pass an exit-code
		// check. Each of these is a file a user would go looking for.
		expect(runCi).toContain('expect_exists "$INSTALLER_BIN/veyyon"');
		expect(runCi).toContain('expect_exists "$INSTALLER_BIN/vey"');
		expect(runCi).toContain('expect_exists "$INSTALLER_HOME/.local/share/bash-completion/completions/veyyon"');
		expect(runCi).toContain('expect_exists "$INSTALLER_HOME/.local/share/zsh/site-functions/_veyyon"');
		expect(runCi).toContain('expect_exists "$INSTALLER_HOME/.config/fish/completions/veyyon.fish"');
	});

	it("checks the alias is a symlink and the binary is executable", () => {
		expect(runCi).toContain('[ -x "$INSTALLER_BIN/veyyon" ]');
		expect(runCi).toContain('[ -L "$INSTALLER_BIN/vey" ]');
	});

	it("checks the PATH line and its marker landed in the rc", () => {
		expect(runCi).toContain('grep -Fqx "export PATH=\\"$INSTALLER_BIN:\\$PATH\\"" "$INSTALLER_HOME/.bashrc"');
		expect(runCi).toContain('grep -Fqx "# added by the veyyon installer" "$INSTALLER_HOME/.bashrc"');
	});

	it("reinstalls once more and proves the rc line is not duplicated", () => {
		// Re-running the installer is the single most common user action after
		// the first install, and appending the line again on every run is the
		// obvious way to get it wrong.
		expect(runCi).toContain('path_lines="$(grep -Fxc');
		expect(runCi).toContain('[ "$path_lines" = "1" ]');
	});

	it("proves uninstall reclaims every file it wrote", () => {
		expect(runCi).toContain('expect_absent "$INSTALLER_BIN/veyyon"');
		expect(runCi).toContain('expect_absent "$INSTALLER_HOME/.local/share/bash-completion/completions/vey"');
		expect(runCi).toContain('expect_absent "$INSTALLER_HOME/.config/fish/completions/vey.fish"');
		expect(runCi).toContain('uninstall left the PATH line in .bashrc');
	});

	it("proves uninstall leaves the user's own rc content alone", () => {
		// "Removes everything it added, and only what it added" is the documented
		// contract; the second half is the one that costs a user their config.
		expect(runCi).toContain("echo \"alias ll='ls -la'\" >> \"$INSTALLER_HOME/.bashrc\"");
		expect(runCi).toContain("uninstall removed the user's own .bashrc content");
	});

	it("proves the install directory is empty afterwards, staging files included", () => {
		expect(runCi).toContain('leftovers="$(ls -A "$INSTALLER_BIN" 2>/dev/null || true)"');
		expect(runCi).toContain("uninstall left files behind");
	});
});
