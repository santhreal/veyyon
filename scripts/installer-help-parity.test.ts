import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Both installers answer `--help`, and both answer it from ONE place.
 *
 * The options used to be documented only in a comment at the top of each script,
 * which is exactly what an install run as `curl … | sh` or `irm … | iex` never
 * shows anyone: `sh install.sh --help` answered "Unknown option: --help" and
 * exited 1. Each script now has a single usage printer, its header points at
 * that printer instead of carrying a second list, and these tests are what keeps
 * the two installers offering the same options under different spellings.
 *
 * The POSIX half is executed for real, because a usage function that is present
 * in the source and broken at runtime is the same defect as no usage at all. The
 * PowerShell half is read as text, since pwsh does not exist on the Linux
 * runners; `scripts/install-tests/functions.test.ps1` runs it on Windows.
 */

const root = path.resolve(import.meta.dir, "..");
const installSh = path.join(root, "scripts/install.sh");
const installPs1 = fs.readFileSync(path.join(root, "scripts/install.ps1"), "utf8");

/** The here-string `-Help` prints, which is the only Windows option list. */
const ps1Usage = ((): string => {
	const from = installPs1.slice(installPs1.indexOf("function Write-Usage {"));
	return from.slice(0, from.indexOf('\n"@'));
})();

/** What `sh install.sh <args>` printed, and what it exited with. */
function runInstaller(args: string[]): { stdout: string; stderr: string; status: number } {
	const run = spawnSync("sh", [installSh, ...args], { encoding: "utf8" });
	return { stdout: run.stdout ?? "", stderr: run.stderr ?? "", status: run.status ?? -1 };
}

/** One line of help text with its wrapping collapsed, so a sentence the usage
 * breaks across two lines can still be matched as the sentence it is. */
function flowed(text: string): string {
	return text.replace(/\s+/g, " ");
}

/**
 * The flags each installer documents, keyed by concept so the two spellings can
 * be compared. A flag missing from one side is a capability the other side's
 * users cannot discover.
 *
 * `--source`/`-Source` is deliberately absent: the installer no longer builds
 * from a checkout, so help that advertised the flag would document a mode that
 * does not exist. Its absence is asserted below rather than left unsaid.
 */
const FLAGS: Array<{ concept: string; posix: string; windows: string }> = [
	{ concept: "prebuilt binary", posix: "--binary", windows: "-Binary" },
	{ concept: "install what this checkout built", posix: "--local", windows: "-Local" },
	{ concept: "pin a version", posix: "--ref", windows: "-Ref" },
	{ concept: "skip checksum verification", posix: "--no-verify", windows: "-NoVerify" },
	{ concept: "remove everything", posix: "--uninstall", windows: "-Uninstall" },
];

describe("both installers can be asked what they do", () => {
	it("sh install.sh --help prints the usage and exits 0", () => {
		const run = runInstaller(["--help"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("veyyon installer");
		expect(run.stdout).toContain("Options:");
		// Nothing was installed on the way: usage is a print and a return.
		expect(run.stdout).not.toContain("Downloading");
	});

	it("-h is the same thing", () => {
		expect(runInstaller(["-h"]).stdout).toBe(runInstaller(["--help"]).stdout);
	});

	/**
	 * The complaint alone leaves the user with no way to find the right spelling,
	 * because the options are not visible anywhere else to someone who piped this
	 * script into a shell. Usage goes to stderr here, not stdout, so a script
	 * capturing stdout still gets nothing on a failed run.
	 */
	it("an unknown option prints the usage too, on stderr, and exits 1", () => {
		const run = runInstaller(["--nope"]);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain("Unknown option: --nope");
		expect(run.stderr).toContain("Options:");
		expect(run.stdout).toBe("");
	});

	it.each(FLAGS)("--help documents $concept as $posix", ({ posix }) => {
		expect(runInstaller(["--help"]).stdout).toContain(posix);
	});

	it("--help names the install directory variable, which nothing else advertises", () => {
		expect(runInstaller(["--help"]).stdout).toContain("VEYYON_INSTALL_DIR");
	});

	/**
	 * The `v` a person leaves off a version is the one behaviour of `--ref` that
	 * is not guessable, so the help has to state it: without this line, a user who
	 * types `--ref 1.0.37` has no reason to believe it will work. Both usages
	 * still make the claim; both wrap it across lines, which is why the text is
	 * matched with its wrapping collapsed rather than as one literal line.
	 */
	it("both usages say a bare version resolves to its published tag", () => {
		expect(flowed(runInstaller(["--help"]).stdout)).toContain("1.0.37 and v1.0.37 are the same release");
		expect(flowed(ps1Usage)).toContain("1.0.37 and v1.0.37 are the same release");
	});

	/**
	 * `--ref` used to imply a source build, so any ref at all was installable.
	 * It now names a PUBLISHED RELEASE TAG and nothing else, and that narrowing
	 * is invisible to a user who reads the old mental model into the flag: the
	 * help has to say which refs work, and where the ones that do not are served
	 * instead.
	 */
	it("both usages scope --ref to a published release tag", () => {
		expect(flowed(runInstaller(["--help"]).stdout)).toContain("Install a specific published release tag");
		expect(flowed(ps1Usage)).toContain("Install a specific published release tag");
	});

	/**
	 * The installer will not build an unreleased ref, so the reader who wants one
	 * has to be handed the checkout they run themselves. install.sh says it in
	 * the `--ref` entry. install.ps1's `-Ref` entry stops at "published release
	 * tag" and carries the pointer only in the refusal a user sees after asking
	 * for a branch, so that is where it is pinned — the two are asserted apart
	 * because they genuinely differ.
	 */
	it("both point a reader who needs an unreleased ref at their own checkout", () => {
		expect(flowed(runInstaller(["--help"]).stdout)).toContain(
			"Branches and commits are not installable: clone the repository and run `bun run setup` in that checkout instead.",
		);
		expect(installPs1).toContain(
			"Only published release tags are installable; for a branch or a commit, $ManualBuild",
		);
		expect(installPs1).toContain(
			'$ManualBuild = "build it from a checkout you own: git clone $RepoUrl && cd veyyon && bun run setup"',
		);
	});

	/**
	 * Help that advertises `--source` documents an install mode that no longer
	 * exists: the flag, its dispatch arm, and every clone it ran were removed.
	 * A user who reads it would ask for a build the installer answers with
	 * "Unknown option".
	 */
	it("neither usage advertises a build-from-checkout flag", () => {
		expect(runInstaller(["--help"]).stdout).not.toContain("--source");
		expect(runInstaller(["--nope"]).stderr).not.toContain("--source");
		expect(ps1Usage).not.toMatch(/-Source\b/);
	});
});

describe("install.ps1 offers the same options under Windows spellings", () => {
	it("takes a -Help switch", () => {
		expect(installPs1).toContain("[switch]$Help");
	});

	it("prints the usage and returns without installing", () => {
		const main = installPs1.slice(installPs1.indexOf("if (-not $env:VEYYON_INSTALL_SOURCED) {"));
		const helpBranch = main.slice(main.indexOf("if ($Help) {"), main.indexOf("if ($Uninstall) {"));
		expect(helpBranch).toContain("Write-Usage");
		expect(helpBranch).toContain("return");
	});

	it.each(FLAGS)("documents $concept as $windows", ({ windows }) => {
		expect(ps1Usage).toContain(windows);
	});

	/**
	 * One owner per script. A header comment that also listed the options would be
	 * the copy that goes stale, and it is the copy nobody running `-Help` sees.
	 */
	it("has exactly one usage printer", () => {
		expect(installPs1.split("function Write-Usage {")).toHaveLength(2);
	});

	it("its header points at the printer rather than repeating the list", () => {
		const header = installPs1.slice(0, installPs1.indexOf("param("));
		expect(header).toContain("Write-Usage");
		// The header may show one example invocation; it must not be a second
		// option table.
		expect(header).not.toContain("-NoVerify");
	});
});

describe("the POSIX header does not carry a second option list either", () => {
	it("points at usage() instead", () => {
		const source = fs.readFileSync(installSh, "utf8");
		const header = source.slice(0, source.indexOf('REPO="santhreal/veyyon"'));
		expect(header).toContain("usage()");
		expect(header).not.toContain("--no-verify");
	});

	it("has exactly one usage printer", () => {
		const source = fs.readFileSync(installSh, "utf8");
		expect(source.split("\nusage() {")).toHaveLength(2);
	});
});
