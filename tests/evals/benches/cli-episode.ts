/**
 * One bench episode: the veyyon CLI in print mode with only the browser tool, run to completion or
 * a deadline.
 *
 * Every episode runs with an empty home of its own, so a host's context files (`~/.veyyon/AGENTS.md`
 * and the like) stay out of the measured prompt and no episode inherits another's state, and with a
 * config overlay that turns the browser tool on, which is off by default. The JSON event stream is
 * kept as `events.jsonl` in the episode's working directory: it is the only record of where the
 * episode's turns, tokens and tool results went. The CLI's stderr is kept beside it as `stderr.txt`.
 *
 * Browser run code has Node's full file access. Where the kernel has Landlock, each episode runs under
 * {@link sandboxRules}: the files in the invoking user's home, in the bench's work directory and in
 * the tests of both trees are unreadable to it, so it cannot open a task's expected answer or an
 * earlier episode's transcript. Elsewhere {@link sandboxNotice} says that it can.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@veyyon/utils";

/** Applies an episode's Landlock rules, then runs the CLI. */
const LANDLOCK_EXEC = path.join(import.meta.dirname, "landlock-exec.py");

/** What the print mode's JSON event lines report, summed over every assistant message. */
export interface EpisodeUsage {
	/** Assistant messages, each one a request that re-sent the whole conversation. */
	turns: number;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
}

interface AssistantEvent {
	type?: string;
	message?: {
		role?: string;
		content?: Array<{ type?: string; text?: string }>;
		usage?: { input?: number; output?: number; cacheRead?: number };
	};
}

function* assistantMessages(lines: string): Generator<NonNullable<AssistantEvent["message"]>> {
	for (const line of lines.split("\n")) {
		if (!line.startsWith("{")) continue;
		let event: AssistantEvent;
		try {
			event = JSON.parse(line);
		} catch {
			// A line the CLI printed that is not an event, such as a warning.
			continue;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") yield event.message;
	}
}

export function readUsage(lines: string): EpisodeUsage {
	const usage: EpisodeUsage = { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
	for (const message of assistantMessages(lines)) {
		usage.turns++;
		usage.toolCalls += message.content?.filter(block => block.type === "toolCall").length ?? 0;
		usage.inputTokens += message.usage?.input ?? 0;
		usage.outputTokens += message.usage?.output ?? 0;
		usage.cacheReadTokens += message.usage?.cacheRead ?? 0;
	}
	return usage;
}

/** The text of the last assistant message that said anything: the episode's answer. */
export function finalText(lines: string): string {
	let text = "";
	for (const message of assistantMessages(lines)) {
		const said = (message.content ?? [])
			.filter(block => block.type === "text")
			.map(block => block.text ?? "")
			.join("");
		if (said.trim()) text = said;
	}
	return text;
}

/** Write the overlay that turns the browser tool on into `work`, and return its path. */
export async function writeBrowserOverlay(work: string): Promise<string> {
	const config = path.join(work, "browser-enabled.yml");
	await fs.mkdir(work, { recursive: true });
	await fs.writeFile(config, "browser:\n  enabled: true\n");
	return config;
}

export interface CliEpisodeOptions {
	/** The tree's `packages/coding-agent/src/cli.ts`. */
	readonly cli: string;
	readonly model: string;
	readonly prompt: string;
	/** The bench's work directory; the episode's cwd and home are made fresh under it. */
	readonly work: string;
	readonly episode: string;
	/** The overlay from {@link writeBrowserOverlay}. */
	readonly config: string;
	readonly timeoutMs: number;
	/** A directory holding the model's sign-in; without one the episode has only its empty home. */
	readonly agentDir: string | undefined;
	/** Files written into the episode's working directory before it starts, by name. */
	readonly files?: Readonly<Record<string, string>>;
}

export interface CliEpisodeRun {
	readonly stdout: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly wallMs: number;
	readonly usage: EpisodeUsage;
}

/** Whether episodes run under Landlock here, and the launcher's interpreter when they do. */
export type EpisodeSandbox =
	| { readonly usable: true; readonly python: string; readonly abi: number }
	| { readonly usable: false; readonly reason: string };

let probed: EpisodeSandbox | undefined;

/** Probe once, by running the launcher: a kernel can list Landlock and still refuse it. */
export function episodeSandbox(): EpisodeSandbox {
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

/** One line for a bench's log that says whether its episodes can read the bench's answers. */
export function sandboxNotice(): string {
	const sandbox = episodeSandbox();
	return sandbox.usable
		? `episodes run under Landlock ABI ${sandbox.abi}: the files in the home, the work directory and the tests are unreadable to them`
		: `episodes are not sandboxed (${sandbox.reason}): run code can read the tasks' expected answers`;
}

/** A Landlock grant beneath `path`: list directories, also read and run files, or also change them. */
export interface SandboxRule {
	readonly path: string;
	readonly access: "list" | "read" | "write";
}

/**
 * Landlock rules for one episode. Every directory can be listed, and every file read, but the files
 * in the invoking user's home, in the bench's work directory and in the `tests` of the episode's tree
 * and of this runner, which hold the tasks' expected answers; the tree, the runtime, the config
 * overlay and the sign-in are granted back inside them. Only the episode's own directory and home, the
 * sign-in, `/tmp`, `/dev` and `/proc` are writable. Landlock only grants, so a directory that holds a
 * hidden one is granted entry by entry around it. Listing stays open everywhere because module
 * resolution opens every directory above the file that imports. A results file written outside the
 * home and outside `work` stays readable.
 */
export async function sandboxRules(options: CliEpisodeOptions, cwd: string, home: string): Promise<SandboxRule[]> {
	const tree = path.resolve(options.cli, "../../../..");
	const hidden = [os.homedir(), options.work, path.join(tree, "tests"), path.resolve(import.meta.dirname, "../..")];
	const grants: SandboxRule[] = [
		{ path: "/", access: "read" },
		{ path: "/tmp", access: "write" },
		{ path: "/dev", access: "write" },
		{ path: "/proc", access: "write" },
		{ path: tree, access: "read" },
		{ path: path.dirname(process.execPath), access: "read" },
		{ path: options.config, access: "read" },
		{ path: cwd, access: "write" },
		{ path: home, access: "write" },
		...(options.agentDir ? [{ path: options.agentDir, access: "write" as const }] : []),
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
	for (const name of await fs.readdir(grant.path)) {
		await grantAround({ path: path.join(grant.path, name), access: grant.access }, hidden, rules);
	}
}

function isBeneath(entry: string, dir: string): boolean {
	const relative = path.relative(dir, entry);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function runCliEpisode(options: CliEpisodeOptions): Promise<CliEpisodeRun> {
	const cwd = path.join(options.work, options.episode);
	const home = path.join(options.work, ".homes", options.episode);
	for (const dir of [cwd, home]) {
		await fs.rm(dir, { recursive: true, force: true });
		await fs.mkdir(dir, { recursive: true });
	}
	for (const [name, content] of Object.entries(options.files ?? {})) {
		await fs.writeFile(path.join(cwd, name), content);
	}
	const sandbox = episodeSandbox();
	const launch: { readonly command: string; readonly prefix: readonly string[] } = sandbox.usable
		? {
				command: sandbox.python,
				prefix: [LANDLOCK_EXEC, JSON.stringify(await sandboxRules(options, cwd, home)), "--", process.execPath],
			}
		: { command: process.execPath, prefix: [] };
	const started = Date.now();
	const args = [
		options.cli,
		"-p",
		"--mode",
		"json",
		"--no-session",
		"--model",
		options.model,
		"--tools",
		"browser",
		"--approval-mode",
		"yolo",
		"--config",
		options.config,
		options.prompt,
	];
	const child = spawn(
		launch.command,
		[...launch.prefix, ...args],
		{
			cwd,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				...(options.agentDir ? { VEYYON_CODING_AGENT_DIR: options.agentDir } : {}),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", chunk => {
		stdout += chunk;
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
	}, options.timeoutMs);
	const exited = Promise.withResolvers<number | null>();
	child.on("close", code => exited.resolve(code));
	const exitCode = await exited.promise;
	clearTimeout(timer);
	await fs.writeFile(path.join(cwd, "events.jsonl"), stdout);
	await fs.writeFile(path.join(cwd, "stderr.txt"), stderr);
	return { stdout, exitCode, timedOut, wallMs: Date.now() - started, usage: readUsage(stdout) };
}
