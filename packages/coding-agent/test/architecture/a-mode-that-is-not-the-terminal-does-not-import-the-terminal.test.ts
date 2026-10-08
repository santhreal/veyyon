/**
 * WHY THIS SUITE EXISTS. `src/modes/` used to be one flat directory holding the
 * interactive TUI, the print runtime, the RPC server and the ACP agent side by
 * side, so nothing said which modules a headless run loads. The terminal
 * implementation now lives under `modes/terminal/`, and the peer modes —
 * `print-mode.ts`, `rpc/`, `acp/` — sit beside it rather than under it.
 *
 * The defect class this closes: a peer mode, or the keyword parsing the session
 * itself calls, importing a terminal module for one helper. That single import
 * pulls `@veyyon/tui` into a headless run, which is the coupling the whole
 * decoupling removes, and it is invisible in a diff that only adds one line.
 *
 * The peer set is read from the directory at run time, so a fourth non-terminal
 * mode is covered the day it lands, and a module dropped loose at the root has
 * to be classified here before this suite goes green again.
 *
 * What it does NOT catch: a peer mode reaching the terminal through a package
 * subpath of some third package that re-exports it, and a terminal module that
 * imports a peer mode (which is allowed — `modes/index.ts` dispatches).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { importSpecifiers, isDirectory, repoPath, repoRelative, typeScriptFiles } from "./helpers/module-graph";

const MODES = repoPath("packages/coding-agent/src/modes");
const MODES_PREFIX = "packages/coding-agent/src/modes/";

/**
 * Directories under `modes/` that are not the terminal, with what each one is.
 * `terminal` is excluded on purpose: it is the subject, not a peer.
 */
const PEER_DIRECTORIES: Readonly<Record<string, string>> = {
	acp: "the Agent Client Protocol server, driven by an editor",
	keywords: "magic-keyword parsing, called from the session on every prompt",
	rpc: "the JSON-RPC runtime, driven by a client over a socket",
};

/** Loose modules at the root of `modes/`, with what each one is. */
const ROOT_MODULES: Readonly<Record<string, string>> = {
	"index.ts": "the mode barrel; it names the interactive mode to dispatch to it",
	"loop-limit.ts": "the turn-loop ceiling, read by the slash-command registry",
	"print-mode.ts": "the non-interactive print runtime",
	"print-mode.test.ts": "the print runtime's own suite",
	"retry-display.ts": "retry wording, read by the session and by task progress",
	"runtime-init.ts": "runtime construction shared by the print and RPC modes",
	"setup-version.ts": "onboarding version bookkeeping, read by the launch card",
};

/** A specifier that lands inside `modes/terminal/`, however it is spelled. */
function reachesTerminal(specifier: string): boolean {
	if (specifier.startsWith("@veyyon/coding-agent/modes/terminal")) return true;
	return /(^|\/)terminal\//.test(specifier) && !specifier.startsWith("@veyyon/tui");
}

function directEntries(): string[] {
	return fs.readdirSync(MODES, { withFileTypes: true }).map(entry => entry.name);
}

describe("a mode that is not the terminal does not import the terminal", () => {
	test("the modes directory holds exactly the recorded peers beside the terminal", () => {
		const entries = directEntries();
		const directories = entries.filter(name => isDirectory(`${MODES}/${name}`)).sort();
		const files = entries.filter(name => !isDirectory(`${MODES}/${name}`)).sort();
		expect(directories).toEqual(["terminal", ...Object.keys(PEER_DIRECTORIES)].sort());
		expect(files).toEqual(Object.keys(ROOT_MODULES).sort());
	});

	test("no peer directory imports anything under modes/terminal", () => {
		const violations: string[] = [];
		for (const peer of Object.keys(PEER_DIRECTORIES)) {
			for (const file of typeScriptFiles(`${MODES}/${peer}`)) {
				for (const specifier of importSpecifiers(file)) {
					if (reachesTerminal(specifier)) violations.push(`${repoRelative(file)} -> ${specifier}`);
				}
			}
		}
		expect(violations.sort()).toEqual([]);
	});

	test("no peer directory imports the terminal UI library", () => {
		const violations: string[] = [];
		for (const peer of Object.keys(PEER_DIRECTORIES)) {
			for (const file of typeScriptFiles(`${MODES}/${peer}`)) {
				for (const specifier of importSpecifiers(file)) {
					if (specifier === "@veyyon/tui" || specifier.startsWith("@veyyon/tui/")) {
						violations.push(`${repoRelative(file)} -> ${specifier}`);
					}
				}
			}
		}
		expect(violations.sort()).toEqual([]);
	});

	test("only the barrel names the terminal from the root of modes", () => {
		const reaching: string[] = [];
		for (const name of Object.keys(ROOT_MODULES)) {
			if (!name.endsWith(".ts")) continue;
			const file = `${MODES}/${name}`;
			if (importSpecifiers(file).some(reachesTerminal)) reaching.push(name);
		}
		// The barrel dispatches to the interactive mode, so it is the one module
		// at this level allowed to name it.
		expect(reaching.sort()).toEqual(["index.ts"]);
	});

	test("the terminal tree is where the interactive mode and its components live", () => {
		const terminal = typeScriptFiles(`${MODES}/terminal`).map(repoRelative);
		expect(terminal).toContain(`${MODES_PREFIX}terminal/interactive-mode.ts`);
		expect(terminal).toContain(`${MODES_PREFIX}terminal/components/index.ts`);
		expect(terminal).toContain(`${MODES_PREFIX}terminal/controllers/input-controller.ts`);
		// And nothing of the sort is left at the old flat locations.
		const flat = typeScriptFiles(MODES)
			.map(repoRelative)
			.filter(
				path => path.startsWith(`${MODES_PREFIX}components/`) || path.startsWith(`${MODES_PREFIX}controllers/`),
			);
		expect(flat).toEqual([]);
	});
});
