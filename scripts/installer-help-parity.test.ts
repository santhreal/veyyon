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

/** What `sh install.sh <args>` printed, and what it exited with. */
function runInstaller(args: string[]): { stdout: string; stderr: string; status: number } {
	const run = spawnSync("sh", [installSh, ...args], { encoding: "utf8" });
	return { stdout: run.stdout ?? "", stderr: run.stderr ?? "", status: run.status ?? -1 };
}

/**
 * The flags each installer documents, keyed by concept so the two spellings can
 * be compared. A flag missing from one side is a capability the other side's
 * users cannot discover.
 */
const FLAGS: Array<{ concept: string; posix: string; windows: string }> = [
	{ concept: "prebuilt binary", posix: "--binary", windows: "-Binary" },
	{ concept: "build from a checkout", posix: "--source", windows: "-Source" },
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
	 * types `--ref 1.0.37` has no reason to believe it will work.
	 */
	it("--help says a bare version resolves to its published tag", () => {
		const help = runInstaller(["--help"]).stdout;
		expect(help).toContain("1.0.37 and v1.0.37 are the same release");
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
		const usage = installPs1.slice(installPs1.indexOf("function Write-Usage {"));
		expect(usage.slice(0, usage.indexOf('\n"@'))).toContain(windows);
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
