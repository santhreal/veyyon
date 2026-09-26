/**
 * One bench episode: the veyyon CLI in print mode with only the browser tool, run to completion or
 * a deadline.
 *
 * Every episode runs with an empty home of its own, so a host's context files (`~/.veyyon/AGENTS.md`
 * and the like) stay out of the measured prompt and no episode inherits another's state, and with a
 * config overlay that turns the browser tool on, which is off by default. The JSON event stream is
 * kept as `events.jsonl` in the episode's working directory: it is the only record of where the
 * episode's turns, tokens and tool results went.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

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
	/** A directory holding the model's sign-in; the host's own when absent. */
	readonly agentDir: string | undefined;
}

export interface CliEpisodeRun {
	readonly stdout: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly wallMs: number;
	readonly usage: EpisodeUsage;
}

export async function runCliEpisode(options: CliEpisodeOptions): Promise<CliEpisodeRun> {
	const cwd = path.join(options.work, options.episode);
	const home = path.join(options.work, ".homes", options.episode);
	for (const dir of [cwd, home]) {
		await fs.rm(dir, { recursive: true, force: true });
		await fs.mkdir(dir, { recursive: true });
	}
	const started = Date.now();
	const child = spawn(
		process.execPath,
		[
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
		],
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
	child.stderr.resume();
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
	return { stdout, exitCode, timedOut, wallMs: Date.now() - started, usage: readUsage(stdout) };
}
