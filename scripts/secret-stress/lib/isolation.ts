/**
 * A throwaway machine for one `/secret` stress run.
 *
 * WHY THIS EXISTS. Every interesting `/secret` behaviour is a function of three vault files
 * (global, profile, project), a config file, and a vault key -- all of which live under `$HOME`
 * on a developer box. Running the stress scenarios against a real `$HOME` would read that
 * developer's actual credential NAMES into `/secret list` output, write TTLs onto their real
 * entries, and (for the rotation and `rm` scenarios) destroy them. So every run gets its own
 * root and the child process is told, through its environment only, that the root is home.
 *
 * WHY THE ENVIRONMENT IS AN ALLOWLIST AND NOT `{ ...process.env, HOME }`. This repo's own
 * agent sessions export `VEYYON_PROFILE` and `VEYYON_CODING_AGENT_DIR`. Inheriting either one
 * re-points the child at the developer's real profile directory even though `HOME` was
 * overridden, which silently un-isolates the run: the vault under test would be the real one
 * and `/secret rm` would delete a real credential. `XDG_DATA_HOME` and friends do the same
 * thing through `dirs.ts`'s XDG redirect. An allowlist cannot forget a variable that gets
 * added to the product later, so the allowlist is what ships.
 *
 * WHAT THE ALLOWLIST STILL CANNOT DO. It removes every variable, and a model needs none:
 * `ollama`, `llama.cpp` and `lm-studio` are discovered at fixed loopback addresses on every
 * launch, so an "empty" root on a desk running Ollama has a working model. `createIsolatedRoot`
 * closes that separately, for `auth: "none"` only. See the note there.
 *
 * The override applies to the SPAWNED CHILD ONLY. Nothing here mutates `process.env`, so the
 * harness process, the agent running it, and every sibling tool keep the real `$HOME`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { denyHostProviderAccess } from "../../../packages/coding-agent/test/helpers/hermetic-spawn-env";

/** One isolated machine: the directories a run owns and the environment that reaches them. */
export interface IsolatedRoot {
	/** Temp root holding everything this run created. */
	root: string;
	/** `$HOME` for spawned children. */
	home: string;
	/** Cross-profile config root: `$HOME/.veyyon`. Holds the vault key and the global vault. */
	globalConfigRoot: string;
	/** Resolved agent dir, as the CLI itself reports it. Holds the profile vault. */
	agentDir: string;
	/** Working directory children are launched in. `<project>/.veyyon` holds the project vault. */
	project: string;
	/** Scratch space for captures, transcripts and probe files. */
	work: string;
	/** Environment for a spawned child, already scrubbed. */
	env: Record<string, string>;
}

/**
 * Variables a child genuinely needs. Everything else is dropped.
 *
 * `PATH` so `bun` and `sh` resolve, `TERM`/`COLORTERM` so the TUI picks a real terminal profile
 * rather than its dumb-terminal fallback (the fallback would not exercise the render paths this
 * harness is here to break), and the locale trio so column widths are computed the same way a
 * user's terminal computes them.
 */
const INHERITED_ENV_KEYS = ["PATH", "SHELL", "TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;

/** Read the parent environment down to the allowlist. */
function inheritedEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of INHERITED_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

/** Repo root, derived from this file so the harness runs from any cwd. */
export const REPO_ROOT: string = path.resolve(import.meta.dir, "..", "..", "..");

/**
 * The CLI entrypoint every child runs. The real shipped path, not a bundled copy and not an
 * imported function.
 *
 * MUTABLE ON PURPOSE, for exactly one job: the negative control. A harness that has only ever
 * been seen passing is not proof of anything, so `--cli <path>` points the whole run at a
 * DIFFERENT checkout -- normally a `git worktree` pinned to the commit before a fix -- and the
 * same scenarios must then FAIL. Nothing else writes this.
 */
export let CLI_ENTRY: string = path.join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");

/** Point every subsequent child at another checkout's CLI. Throws rather than driving a missing file. */
export function useCliEntry(entry: string): void {
	const resolved = path.resolve(entry);
	if (!fs.existsSync(resolved)) throw new Error(`--cli path does not exist: ${resolved}`);
	CLI_ENTRY = resolved;
}

/**
 * `env` from coreutils, used to launch every child with `-i`.
 *
 * WHY A WRAPPER BINARY INSTEAD OF AN `env` OPTION. `Bun.spawn`'s `env` REPLACES the child's
 * environment, but `PtySession.startArgv`'s MERGES into the parent's -- verified by running
 * `/usr/bin/env` through a PTY with a three-variable map and reading 77 variables back. The two
 * spawners therefore disagree about what "isolated" means, and the PTY one loses: this repo's own
 * agent sessions export `VEYYON_PROFILE` and an ABSOLUTE `VEYYON_CODING_AGENT_DIR` pointing at the
 * developer's real profile, and both reached the child. The first run of this harness stored its
 * test secrets under a `work` profile it never asked for because of exactly that.
 *
 * `env -i` is the one mechanism that is identical for both spawners and cannot inherit anything:
 * the child starts from an empty environment and receives only the assignments listed after it.
 */
export const ENV_BIN: string = Bun.which("env") ?? "/usr/bin/env";

/** Executable plus argv that runs `argv` under exactly `iso.env` (+ `extra`) and nothing else. */
export function isolatedArgv(
	iso: Pick<IsolatedRoot, "env">,
	argv: readonly string[],
	extra: Record<string, string> = {},
): { application: string; args: string[] } {
	const assignments = Object.entries({ ...iso.env, ...extra }).map(([key, value]) => `${key}=${value}`);
	return { application: ENV_BIN, args: ["-i", ...assignments, ...argv] };
}

/** Ask the CLI where it thinks its agent dir is, rather than hardcoding a profile layout. */
async function resolveAgentDir(env: Record<string, string>, cwd: string): Promise<string> {
	const { application, args } = isolatedArgv({ env }, [process.execPath, CLI_ENTRY, "config", "path"]);
	const proc = Bun.spawn([application, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	const resolved = out
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.at(-1);
	if (!resolved || !path.isAbsolute(resolved)) {
		throw new Error(`veyyon config path did not resolve an agent dir (stdout=${out.trim()} stderr=${err.trim()})`);
	}
	return resolved;
}

/**
 * Baseline config every scenario starts from.
 *
 * `setupVersion` is the one that actually matters and the one that is easy to miss: `main.ts`
 * runs the onboarding wizard whenever the STORED `setupVersion` is below `CURRENT_SETUP_VERSION`,
 * regardless of `startup.setupWizard`. A fresh temp home defaults to 0, so without this line every
 * TUI scenario lands on the provider picker and types its `/secret` command into a search box.
 */
const BASE_CONFIG = [
	"setupVersion: 1",
	"startup:",
	"  setupWizard: false",
	"  showSplash: false",
	"  checkUpdate: false",
	"  quiet: true",
	"  updateNotice: false",
	"  autoUpdate: false",
	"",
].join("\n");

/** How a run gets a usable model, if at all. */
export type AuthMode = "link" | "none";

/**
 * Build a fresh isolated machine.
 *
 * Fails loudly when the resolved agent dir is not inside the temp home. That check is the whole
 * safety argument of this file: if it ever passes while pointing at the real profile, every
 * destructive scenario below would run against real credentials.
 *
 * `auth: "link"` symlinks ONE directory from the operator's real config root: `shared-auth`,
 * which is the machine-global provider-login store (`getSharedAuthDir` in `packages/utils`).
 * That is what lets the run use a real model without asking the operator to paste an API key.
 * It is deliberately the only link: the vault key, all three vault files, the config and the
 * session store all resolve from `globalConfigRoot`/`agentDir`/`project`, none of which is
 * linked, so nothing this harness stores, rotates or deletes can reach a real credential.
 * `auth: "none"` skips the link, and every scenario needing a model turn records NOT RUN.
 */
export async function createIsolatedRoot(label: string, auth: AuthMode = "link"): Promise<IsolatedRoot> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `veyyon-secret-stress-${label}-`));
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	const work = path.join(root, "work");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(work, { recursive: true });

	const env: Record<string, string> = {
		...inheritedEnv(),
		HOME: home,
		TERM: process.env.TERM ?? "xterm-256color",
		// The CLI shells out for bash tool calls; keep those children inside the sandbox too.
		TMPDIR: work,
		// Deterministic width regardless of what terminal the operator ran the harness from.
		COLUMNS: "120",
		LINES: "40",
	};
	if (auth === "none") {
		// The allowlist above already keeps every provider credential out, but a credential is not
		// the only way to a model: `ollama`, `llama.cpp` and `lm-studio` are discovered on every
		// launch with no key and no config, at fixed loopback defaults. So "no auth" quietly meant
		// "a full model on any desk running Ollama", and a scenario asserting that the CLI reports
		// no usable model passed on CI and failed there. `denyHostProviderAccess` points those
		// knobs at a port that cannot be listening; it is the same function `hermeticSpawnEnv`
		// uses, imported rather than restated so the two cannot drift.
		//
		// Gated on `auth === "none"` because `"link"` is the operator asking for a real model on
		// purpose (it symlinks their real `shared-auth`), and a local server is a real model.
		denyHostProviderAccess(env);
	}

	const globalConfigRoot = path.join(home, ".veyyon");
	fs.mkdirSync(globalConfigRoot, { recursive: true });
	if (auth === "link") {
		const realHome = os.homedir();
		const realSharedAuth = path.join(realHome, ".veyyon", "shared-auth");
		if (fs.existsSync(realSharedAuth)) fs.symlinkSync(realSharedAuth, path.join(globalConfigRoot, "shared-auth"));
	}

	const agentDir = await resolveAgentDir(env, project);
	if (!agentDir.startsWith(home + path.sep)) {
		throw new Error(
			`isolation failed: agent dir ${agentDir} is outside the temp home ${home}. Refusing to run destructive scenarios.`,
		);
	}
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "config.yml"), BASE_CONFIG, { mode: 0o600 });

	return { root, home, globalConfigRoot, agentDir, project, work, env };
}

/** Absolute vault path for one scope inside an isolated root, mirroring `vaultPathFor`. */
export function vaultPath(iso: IsolatedRoot, scope: "global" | "profile" | "project"): string {
	switch (scope) {
		case "global":
			return path.join(iso.globalConfigRoot, "vault.json");
		case "profile":
			return path.join(iso.agentDir, "vault.json");
		case "project":
			return path.join(iso.project, ".veyyon", "vault.json");
	}
}

/** What a non-terminal child produced. */
export interface PipedResult {
	stdout: string;
	stderr: string;
	/** Both streams joined, which is what most assertions want. */
	text: string;
	exitCode: number;
}

/**
 * Run the CLI in a SECOND process without a terminal.
 *
 * This is the antagonist in the concurrency scenarios: while a TUI holds the vault open, this
 * mutates it from outside and bumps its revision, which is the state the reported crash needs.
 * It is deliberately pipe-backed rather than PTY-backed, because that is what a user does when
 * they run `veyyon -p "/secret rm X"` from another window or a script.
 */
export async function runCliPiped(
	iso: IsolatedRoot,
	argv: readonly string[],
	options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<PipedResult> {
	const { application, args } = isolatedArgv(iso, [process.execPath, CLI_ENTRY, ...argv], options.env);
	const proc = Bun.spawn([application, ...args], {
		cwd: options.cwd ?? iso.project,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	return { stdout, stderr, text: `${stdout}${stderr}`, exitCode };
}

/** Delete a run's root. Skipped by `--keep` so a failure can be poked at afterwards. */
export function destroyIsolatedRoot(iso: IsolatedRoot): void {
	fs.rmSync(iso.root, { recursive: true, force: true });
}
