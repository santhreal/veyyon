/**
 * The Landlock sandbox a local trial runs in.
 *
 * An agent's tools run code with the file access of the user who started the run: browser run code
 * and a shell both read any file that user can. A trial therefore runs under a ruleset that hides the
 * runner's home, the runs directory, the tests of the build it runs, this package, and the git
 * history of the checkout and the build, which hold the graders, the fixture sources and every
 * earlier trial's transcript. It also hides every user's home, the system temp directories and
 * mounted media, since a trial has a home and a TMPDIR of its own and reads nothing else a user
 * keeps. The build, the runtime, the overlays and the trial's own directories are granted back
 * inside them.
 *
 * Landlock only grants, so a directory that holds a hidden one is granted entry by entry around it.
 * A symbolic link among those entries gets no grant: a grant attaches to the link's target, and a
 * target outside the hidden directories is granted where it is. Listing stays open everywhere
 * because module resolution opens every directory above the file that imports, so a trial can
 * read the names in a hidden directory but not its files. Landlock does not govern connecting to a
 * Unix socket.
 */

import { spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, hasFsCode } from "@veyyon/utils";

/** Applies a trial's Landlock rules, then runs the agent. */
const LANDLOCK_EXEC = path.join(import.meta.dirname, "landlock-exec.py");

/**
 * Whether trials run under Landlock here, and the launcher's interpreter. A Linux host without
 * Landlock still has the interpreter, and runs the launcher without rules to reap what a trial left.
 */
export type LandlockSandbox =
	| { readonly usable: true; readonly python: string; readonly abi: number }
	| { readonly usable: false; readonly reason: string; readonly python: string | null };

let probed: LandlockSandbox | undefined;

/** Probe once, by running the launcher: a kernel can list Landlock and still refuse it. */
export function landlockSandbox(): LandlockSandbox {
	if (probed) return probed;
	const python = process.platform === "linux" ? $which("python3") : null;
	if (!python) {
		probed = {
			usable: false,
			reason: process.platform === "linux" ? "no python3 on PATH" : "Landlock is Linux only",
			python: null,
		};
		return probed;
	}
	const probe = spawnSync(python, [LANDLOCK_EXEC, "--abi"], { encoding: "utf8" });
	const abi = Number(probe.stdout.trim());
	probed =
		probe.status === 0 && Number.isInteger(abi) && abi > 0
			? { usable: true, python, abi }
			: { usable: false, reason: probe.stderr.trim() || `the Landlock probe exited with ${probe.status}`, python };
	return probed;
}

/** A Landlock grant beneath `path`: list directories, also read and run files, or also change them. */
export interface SandboxRule {
	readonly path: string;
	readonly access: "list" | "read" | "write";
}

/** What one trial may reach. */
export interface SandboxLayout {
	/** Directories whose files the trial cannot open, except beneath a grant below. */
	readonly hidden: readonly string[];
	/** Paths the trial reads and runs: the build, the runtime, the overlays. */
	readonly read: readonly string[];
	/** Paths the trial changes: its scratch directory, which holds its workspace, home and temp. */
	readonly write: readonly string[];
}

/**
 * What no trial reads, besides what its run hides: every user's home, the system temp directories
 * and mounted media.
 */
export function hostDataDirectories(): string[] {
	const candidates = ["/home", "/root", "/mnt", "/media", "/run/media", "/tmp", "/var/tmp", os.tmpdir(), os.homedir()];
	return [...new Set(candidates.map(entry => path.resolve(entry)))];
}

/**
 * Landlock rules for one trial. Every directory can be listed and every file read, except in the
 * hidden directories and `hostDataDirectories()`. `/dev` and `/proc` are writable, which Chrome
 * needs (`/dev/shm` among them).
 */
export async function sandboxRules(layout: SandboxLayout): Promise<SandboxRule[]> {
	const hidden = [...layout.hidden, ...hostDataDirectories()];
	const grants: SandboxRule[] = [
		{ path: "/", access: "read" },
		{ path: "/dev", access: "write" },
		{ path: "/proc", access: "write" },
		...layout.read.map(entry => ({ path: entry, access: "read" as const })),
		...layout.write.map(entry => ({ path: entry, access: "write" as const })),
	];
	const rules: SandboxRule[] = [{ path: "/", access: "list" }];
	for (const grant of grants) await grantAround(grant, hidden, rules);
	return rules;
}

async function grantAround(grant: SandboxRule, hidden: readonly string[], rules: SandboxRule[]): Promise<void> {
	if (hidden.includes(grant.path)) return;
	if (!hidden.some(entry => isBeneath(entry, grant.path))) {
		rules.push(grant);
		return;
	}
	let entries: Dirent[];
	try {
		entries = await fs.readdir(grant.path, { withFileTypes: true });
	} catch (error) {
		// A file holds nothing beneath it, hidden or not: a build that is an executable is granted
		// whole. A directory that cannot be listed is granted nothing.
		if (hasFsCode(error, "ENOTDIR")) rules.push(grant);
		return;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		await grantAround({ path: path.join(grant.path, entry.name), access: grant.access }, hidden, rules);
	}
}

function isBeneath(entry: string, dir: string): boolean {
	const relative = path.relative(dir, entry);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The command line that runs `command` under `rules` through the launcher, which also reaps every
 * process the command leaves. Without Landlock the launcher runs with no rules; without an
 * interpreter (every host but Linux) `command` runs itself.
 */
export function sandboxedLaunch(
	sandbox: LandlockSandbox,
	rules: readonly SandboxRule[],
	command: string,
	args: readonly string[],
): { readonly command: string; readonly args: readonly string[] } {
	if (!sandbox.python) return { command, args };
	const ruleset = sandbox.usable ? JSON.stringify(rules) : "--no-rules";
	return { command: sandbox.python, args: [LANDLOCK_EXEC, ruleset, "--", command, ...args] };
}
