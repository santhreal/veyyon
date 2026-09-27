/**
 * The Landlock sandbox a local trial runs in.
 *
 * An agent's tools run code with the file access of the user who started the run: browser run code
 * and a shell both read any file that user can. A trial therefore runs under a ruleset that hides the
 * runner's home, the runs directory, the tests of the build it runs and this package, which hold the
 * graders, the fixture sources and every earlier trial's transcript. The build, the runtime, the
 * overlays and the trial's own directories are granted back inside them.
 *
 * Landlock only grants, so a directory that holds a hidden one is granted entry by entry around it.
 * Listing stays open everywhere because module resolution opens every directory above the file that
 * imports. A path outside every hidden directory stays readable.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which } from "@veyyon/utils";

/** Applies a trial's Landlock rules, then runs the agent. */
const LANDLOCK_EXEC = path.join(import.meta.dirname, "landlock-exec.py");

/** Whether trials run under Landlock here, and the launcher's interpreter when they do. */
export type LandlockSandbox =
	| { readonly usable: true; readonly python: string; readonly abi: number }
	| { readonly usable: false; readonly reason: string };

let probed: LandlockSandbox | undefined;

/** Probe once, by running the launcher: a kernel can list Landlock and still refuse it. */
export function landlockSandbox(): LandlockSandbox {
	if (probed) return probed;
	const python = process.platform === "linux" ? $which("python3") : null;
	if (!python) {
		probed = { usable: false, reason: process.platform === "linux" ? "no python3 on PATH" : "Landlock is Linux only" };
		return probed;
	}
	const probe = spawnSync(python, [LANDLOCK_EXEC, "--abi"], { encoding: "utf8" });
	const abi = Number(probe.stdout.trim());
	probed =
		probe.status === 0 && Number.isInteger(abi) && abi > 0
			? { usable: true, python, abi }
			: { usable: false, reason: probe.stderr.trim() || `the Landlock probe exited with ${probe.status}` };
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
	/** Paths the trial changes: its workspace, its home, its credential directory. */
	readonly write: readonly string[];
}

/**
 * Landlock rules for one trial. Every directory can be listed and every file read, except in the
 * hidden directories; `/tmp`, `/dev` and `/proc` are writable, which Chrome needs.
 */
export async function sandboxRules(layout: SandboxLayout): Promise<SandboxRule[]> {
	const grants: SandboxRule[] = [
		{ path: "/", access: "read" },
		{ path: "/tmp", access: "write" },
		{ path: "/dev", access: "write" },
		{ path: "/proc", access: "write" },
		...layout.read.map(entry => ({ path: entry, access: "read" as const })),
		...layout.write.map(entry => ({ path: entry, access: "write" as const })),
	];
	const rules: SandboxRule[] = [{ path: "/", access: "list" }];
	for (const grant of grants) await grantAround(grant, layout.hidden, rules);
	return rules;
}

async function grantAround(grant: SandboxRule, hidden: readonly string[], rules: SandboxRule[]): Promise<void> {
	if (hidden.includes(grant.path)) return;
	if (!hidden.some(entry => isBeneath(entry, grant.path))) {
		rules.push(grant);
		return;
	}
	for (const name of await fs.readdir(grant.path)) {
		await grantAround({ path: path.join(grant.path, name), access: grant.access }, hidden, rules);
	}
}

function isBeneath(entry: string, dir: string): boolean {
	const relative = path.relative(dir, entry);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** The command line that runs `command` under `rules`, or `command` itself when there is no sandbox. */
export function sandboxedLaunch(
	sandbox: LandlockSandbox,
	rules: readonly SandboxRule[],
	command: string,
	args: readonly string[],
): { readonly command: string; readonly args: readonly string[] } {
	if (!sandbox.usable) return { command, args };
	return { command: sandbox.python, args: [LANDLOCK_EXEC, JSON.stringify(rules), "--", command, ...args] };
}
