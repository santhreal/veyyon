/**
 * No file this repository tracks spells out the home directory of the machine it was written on.
 *
 * WHY THIS SUITE EXISTS. Three recording scripts shipped with an author's real home
 * path as a DEFAULT value (`TREES="${COMMIT_PROOF_TREES:-/media/<account>/.../worktrees/...}"`, an
 * `-e VEYYON_TEST_HOST_HOME=/home/<account>` argument, and a `Type "cd /media/<account>/..."` line).
 * This repository is public, so each one published the account name, and each one was also a broken
 * default: nobody else's checkout is at that path, so the script it belonged to could not run
 * anywhere but the one machine. The two defects are the same byte.
 *
 * THE CLASS, not the incident. The failure is a personal absolute path used where a variable, a
 * repository-relative path, or `$HOME` belongs. It reappears every time somebody pastes a working
 * command into a script, a scene, a fixture or a doc, which is a normal thing to do and is why a
 * reviewer catching it once does not close it.
 *
 * HOW IT IS CHECKED, and why there is no account name in this file. The home directory is read at
 * run time, so the assertion is "this tree does not name THIS machine's home" rather than a pinned
 * list of accounts — a list which would itself publish the names it forbids, and would say nothing
 * about the next contributor. It therefore fails in the tree that produced the leak, which is the
 * tree that can fix it, exactly like `stray-output-path.test.ts`. On a CI runner the home is
 * `/home/runner`, so the same assertion asks whether a runner path was committed.
 *
 * `VEYYON_TEST_HOST_HOME` FIRST, and that is the whole difference between this gate working and
 * looking like it works. Every suite here runs inside the test sandbox, whose `HOME` is a tmpfs at
 * `/sandbox/home`: reading `os.homedir()` alone would ask whether the tree names the SANDBOX's
 * home, which nothing ever does, and the gate would pass on a tree full of leaks. Each rung exports
 * the host path it claims to have removed under that variable, which is exactly the string this
 * suite needs. `os.homedir()` remains the fallback for a direct `bun test` outside the sandbox.
 *
 * WHAT IT DOES NOT CATCH. Somebody else's home path (their tree fails, not yours), a personal path
 * that reached a commit but not the working tree (history is not scanned; that is the secret-scan
 * job's range), and a fixture that hardcodes an invented account such as `/home/alice` — those are
 * deliberate test data, they name nobody, and a rule against them would fire on hundreds of honest
 * lines. It also cannot see a path inside a binary asset: a screen recording that shows a home
 * directory is a review question, not a regex.
 */

import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * The suite's own prose names the shape it forbids, and a fixture below has to contain a specimen
 * to prove the matcher works, so this file is the one exemption. Nothing else is exempt: a script
 * that needs a machine-specific path takes it from an environment variable.
 */
const SELF = path.relative(REPO_ROOT, import.meta.filename);

/** Every text file git tracks, so a file is scanned the moment it is added. */
async function trackedTextFiles(): Promise<string[]> {
	const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
	return stdout.split("\0").filter(entry => entry.length > 0 && entry !== SELF);
}

/**
 * The home directory as a path segment. `/home/name` must not match `/home/name-two`, and the
 * trailing-boundary check below is what makes the difference: a prefix match would report an
 * unrelated account whose name starts with the same letters.
 */
function homeOccurrences(text: string, home: string): number[] {
	const lines: number[] = [];
	text.split("\n").forEach((line, index) => {
		let at = line.indexOf(home);
		while (at !== -1) {
			const next = line[at + home.length];
			if (next === undefined || next === "/" || !/[A-Za-z0-9._-]/.test(next)) lines.push(index + 1);
			at = line.indexOf(home, at + 1);
		}
	});
	return lines;
}

describe("no tracked file names the home directory of the machine it was written on", () => {
	const home = process.env.VEYYON_TEST_HOST_HOME ?? os.homedir();

	it("recognizes the shape in each place it has appeared", () => {
		const specimen = [
			`TREES="\${COMMIT_PROOF_TREES:-${home}/worktrees/.commit-proof}"`,
			`  -e VEYYON_TEST_HOST_HOME=${home} \\`,
			`Type "cd ${home}/veyyon && bun run dev"`,
		].join("\n");

		expect(homeOccurrences(specimen, home)).toEqual([1, 2, 3]);
	});

	it("does not fire on a longer account name that merely starts the same way", () => {
		expect(homeOccurrences(`${home}-backup/tree`, home)).toEqual([]);
	});

	it("does not fire on the variable or the tilde that belong there instead", () => {
		// biome-ignore-start lint/suspicious/noTemplateCurlyInString: the `${...}` are SHELL parameter
		// expansions quoted from the recorder scripts -- `$HOME` and a `:-` default -- which is the
		// exact spelling this gate wants in place of a literal home. A JS template literal here would
		// interpolate them away and the row would stop asserting anything.
		const correct = [
			'-e "VEYYON_TEST_HOST_HOME=${HOME}"',
			'TREES="${COMMIT_PROOF_TREES:-${REPO_ROOT}/.trees}"',
			"cd ~/veyyon",
		].join("\n");
		// biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of the quoted shell specimens

		expect(homeOccurrences(correct, home)).toEqual([]);
	});

	it("finds no occurrence in any tracked text file", async () => {
		const offenders: string[] = [];
		for (const file of await trackedTextFiles()) {
			let bytes: Buffer;
			try {
				bytes = await fs.readFile(path.join(REPO_ROOT, file));
			} catch {
				continue; // A tracked path missing from the working tree is another suite's contract.
			}
			if (bytes.subarray(0, 8192).includes(0)) continue; // Binary: a recording is a review question.
			for (const line of homeOccurrences(bytes.toString("utf8"), home)) offenders.push(`${file}:${line}`);
		}

		expect(
			offenders,
			`These tracked lines spell out this machine's home directory (${home}). A public repository ` +
				"publishes the account, and the path is a default no other checkout has, so the script or tape " +
				"cannot run anywhere else either. Use $HOME, a repository-relative path from the script's own " +
				`location, or an environment variable with a portable default:\n  ${offenders.join("\n  ")}`,
		).toEqual([]);
	});
});
