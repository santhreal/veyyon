import process from "node:process";

import { $env, isCompiledBinary } from "@veyyon/utils";

interface VeyyonCommand {
	cmd: string;
	args: string[];
	shell: boolean;
}

const DEFAULT_CMD = process.platform === "win32" ? "veyyon.cmd" : "veyyon";
const DEFAULT_SHELL = process.platform === "win32";

export function resolveVeyyonCommand(): VeyyonCommand {
	const envCmd = $env.VEYYON_SUBPROCESS_CMD;
	if (envCmd?.trim()) {
		return { cmd: envCmd, args: [], shell: DEFAULT_SHELL };
	}

	// A compiled binary IS the entry: argv[1] is the embedded bunfs path
	// (`/$bunfs/root/.../cli.js`), not a script the child can run. Forwarding
	// it hands the relaunched process a positional its arg parser reads as the
	// initial prompt, so the old process's entry path surfaced as a user
	// message in the new session's transcript after a profile switch.
	if (isCompiledBinary()) {
		return { cmd: process.execPath, args: [], shell: false };
	}

	const entry = process.argv[1];
	if (entry && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
		return { cmd: process.execPath, args: [entry], shell: false };
	}

	return { cmd: DEFAULT_CMD, args: [], shell: DEFAULT_SHELL };
}
