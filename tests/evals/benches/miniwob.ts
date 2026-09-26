/**
 * MiniWoB++ browser bench.
 *
 * MiniWoB++ (Farama Foundation) is a set of small synthetic web tasks, each a static page that states
 * one instruction ("Enter the date 10/11/2016 and press Submit") and scores the attempt itself in
 * JavaScript. A subset heavy on form entry measures what the browser tool's element actions do for a
 * real model: text fields, passwords, a login, native date and time inputs, an autocomplete, a search
 * box, and one click-only task as a control. Each episode is a handful of tool calls, so a full run
 * costs a few hundred thousand tokens at most.
 *
 * Each episode runs the veyyon CLI in print mode, with only the browser tool (`cli-episode.ts`), against
 * one task page served here with a script appended that seeds the task, lifts MiniWoB's 10 s episode
 * limit, and posts the raw reward (+1 success, -1 failure) back to this server the first time the page
 * scores an attempt. An episode that never submits scores nothing. The model sees only the task page.
 *
 * Before and after a change, run the same flags with `--cli` pointed at each tree's
 * `packages/coding-agent/src/cli.ts`: same tasks, seeds, prompt and model, so the two reports differ
 * by the tree and by the model's sampling.
 *
 * Deliberately NOT a test: it needs a live model and the MiniWoB++ pages
 * (`git clone https://github.com/Farama-Foundation/miniwob-plusplus`).
 *
 *   bun benches/miniwob.ts --miniwob ../miniwob-plusplus/miniwob/html --model google-antigravity/gemini-3.8-flash \
 *     --cli ../before/packages/coding-agent/src/cli.ts --label before --json runs/miniwob-before.json
 */

import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { type FlagGrammar, flagCount, parseFlags, requireFlag } from "../engine/flag-grammar";
import { type EpisodeUsage, runCliEpisode, writeBrowserOverlay } from "./cli-episode";

/** Form entry in every shape the element actions meet, and one click-only control. */
export const DEFAULT_TASKS = [
	"enter-text",
	"enter-text-2",
	"enter-password",
	"login-user",
	"login-user-popup",
	"enter-date",
	"enter-time",
	"form-sequence-2",
	"use-autocomplete",
	"search-engine",
	"text-transform",
	"click-button",
] as const;

/** Tasks outside the default set that shaped none of the tool's changes: links, tabs, a tree, checkboxes, a list, an inbox. */
export const HELDOUT_TASKS = [
	"click-link",
	"click-tab-2",
	"navigate-tree",
	"click-checkboxes",
	"choose-list",
	"email-inbox",
] as const;

/**
 * Long or fiddly tasks: a flight search form with a date picker, a custom calendar, collapsible
 * sections, forwarding a mail described in prose, acting on some posts of a feed, tabs that hide
 * their link, sorting a list by dragging, a slider, a rich-text editor and a terminal.
 */
export const HARD_TASKS = [
	"book-flight",
	"choose-date",
	"click-collapsible-2",
	"email-inbox-forward-nl",
	"social-media-some",
	"click-tab-2-hard",
	"drag-items",
	"use-slider",
	"text-editor",
	"terminal",
] as const;

/** The task sets `--set` names. */
export const MINIWOB_SETS: Readonly<Record<string, readonly string[]>> = {
	default: DEFAULT_TASKS,
	heldout: HELDOUT_TASKS,
	hard: HARD_TASKS,
};

export const MINIWOB_BENCH_FLAGS = {
	valued: {
		miniwob: true,
		model: true,
		cli: true,
		label: true,
		json: true,
		tasks: true,
		set: true,
		seeds: true,
		jobs: true,
		"episode-timeout": true,
		"agent-dir": true,
		work: true,
	},
	valueless: { help: true },
} as const satisfies FlagGrammar;

const USAGE = [
	"usage: bun benches/miniwob.ts --miniwob <miniwob-plusplus/miniwob/html> --model <provider/id>",
	"         [--cli <tree>/packages/coding-agent/src/cli.ts] [--label <name>] [--json <out.json>]",
	"         [--set default|heldout|hard] [--tasks a,b,...] [--seeds <n, default 3>] [--jobs <n, default 2>] [--episode-timeout <s, default 240>]",
	"         [--agent-dir <dir with the model's sign-in>] [--work <dir for episode cwds, default runs/miniwob-work>]",
].join("\n");

export interface EpisodeOutcome extends EpisodeUsage {
	readonly task: string;
	readonly seed: number;
	/** MiniWoB's raw reward for the first submitted attempt; undefined when nothing was submitted. */
	readonly reward: number | undefined;
	readonly reason: string | undefined;
	readonly success: boolean;
	readonly wallMs: number;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
}

/** Appended to every task page: seed the problem, lift the time limit, report the first score. */
function setupScript(): string {
	return `<script>
(function () {
	var params = new URLSearchParams(location.search);
	var episode = params.get("episode");
	core.EPISODE_MAX_TIME = 3600000;
	var end = core.endEpisode;
	core.endEpisode = function (reward, timeProportional, reason) {
		var first = core.EP_TIMER !== null;
		end.apply(core, arguments);
		if (first) {
			fetch("/reward", { method: "POST", body: JSON.stringify({ episode: episode, reward: WOB_RAW_REWARD_GLOBAL, reason: WOB_REWARD_REASON }) });
		}
	};
	window.addEventListener("load", function () {
		setTimeout(function () {
			Math.seedrandom(params.get("seed"));
			core.startEpisodeReal();
		}, 0);
	});
})();
</script>`;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".png": "image/png",
	".gif": "image/gif",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".json": "application/json",
};

interface RewardServer {
	readonly port: number;
	readonly rewards: Map<string, { reward: number; reason: string | undefined }>;
	close(): Promise<void>;
}

async function startServer(root: string): Promise<RewardServer> {
	const rewards = new Map<string, { reward: number; reason: string | undefined }>();
	const server = http.createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.method === "POST" && url.pathname === "/reward") {
			let body = "";
			for await (const chunk of request) body += chunk;
			try {
				const posted = JSON.parse(body) as { episode: string; reward: number; reason: string | null };
				if (!rewards.has(posted.episode)) {
					rewards.set(posted.episode, { reward: posted.reward, reason: posted.reason ?? undefined });
				}
			} catch {
				response.statusCode = 400;
			}
			response.end();
			return;
		}
		const file = path.join(root, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ""));
		if (!file.startsWith(root)) {
			response.statusCode = 403;
			response.end();
			return;
		}
		try {
			let data: Buffer | string = await fs.readFile(file);
			const ext = path.extname(file);
			if (ext === ".html" && file.includes(`${path.sep}miniwob${path.sep}`)) {
				data = data.toString("utf8").replace(/<\/body>/i, `${setupScript()}</body>`);
			}
			response.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
			response.end(data);
		} catch {
			response.statusCode = 404;
			response.end();
		}
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	return {
		port: (server.address() as AddressInfo).port,
		rewards,
		close: async () => {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		},
	};
}

function episodePrompt(url: string): string {
	return [
		"Use the browser tool to complete a task on a web page.",
		`Open ${url} in a tab named "task".`,
		"The page states the task in the box at its top (the element #query). Do what it says in the page.",
		"You get one attempt: the page scores the first time the task is submitted. Do not reload the page.",
		"When you have submitted, reply DONE.",
	].join("\n");
}

interface EpisodeOptions {
	readonly cli: string;
	readonly model: string;
	readonly port: number;
	readonly work: string;
	/** The overlay from `writeBrowserOverlay`: it turns the browser tool on. */
	readonly config: string;
	readonly timeoutMs: number;
	readonly agentDir: string | undefined;
	readonly rewards: RewardServer["rewards"];
}

async function runEpisode(task: string, seed: number, options: EpisodeOptions): Promise<EpisodeOutcome> {
	const episode = `${task}-${seed}`;
	const url = `http://127.0.0.1:${options.port}/miniwob/${task}.html?seed=${seed}&episode=${encodeURIComponent(episode)}`;
	const run = await runCliEpisode({ ...options, episode, prompt: episodePrompt(url) });
	const scored = options.rewards.get(episode);
	return {
		task,
		seed,
		reward: scored?.reward,
		reason: scored?.reason,
		success: (scored?.reward ?? 0) > 0,
		wallMs: run.wallMs,
		...run.usage,
		exitCode: run.exitCode,
		timedOut: run.timedOut,
	};
}

export interface MiniwobSummary {
	readonly episodes: number;
	readonly successes: number;
	readonly submitted: number;
	readonly successRate: number;
	readonly meanToolCalls: number;
	readonly meanWallMs: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly byTask: Record<string, { successes: number; episodes: number }>;
}

export function summarizeMiniwob(outcomes: readonly EpisodeOutcome[]): MiniwobSummary {
	const byTask: Record<string, { successes: number; episodes: number }> = {};
	let successes = 0;
	let submitted = 0;
	let toolCalls = 0;
	let wallMs = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	for (const outcome of outcomes) {
		const row = (byTask[outcome.task] ??= { successes: 0, episodes: 0 });
		row.episodes++;
		if (outcome.success) {
			row.successes++;
			successes++;
		}
		if (outcome.reward !== undefined) submitted++;
		toolCalls += outcome.toolCalls;
		wallMs += outcome.wallMs;
		inputTokens += outcome.inputTokens;
		outputTokens += outcome.outputTokens;
	}
	const n = Math.max(1, outcomes.length);
	return {
		episodes: outcomes.length,
		successes,
		submitted,
		successRate: Number((successes / n).toFixed(3)),
		meanToolCalls: Number((toolCalls / n).toFixed(2)),
		meanWallMs: Math.round(wallMs / n),
		inputTokens,
		outputTokens,
		byTask,
	};
}

if (import.meta.main) {
	let flags: Record<string, string>;
	let seeds: number;
	let jobs: number;
	let timeoutSeconds: number;
	let miniwob: string;
	let model: string;
	try {
		flags = parseFlags(process.argv.slice(2), MINIWOB_BENCH_FLAGS);
		if (flags.help !== undefined) {
			console.log(USAGE);
			process.exit(0);
		}
		miniwob = path.resolve(requireFlag(flags, "miniwob", "e.g. --miniwob ../miniwob-plusplus/miniwob/html"));
		model = requireFlag(flags, "model", "e.g. --model google-antigravity/gemini-3.8-flash");
		seeds = flagCount(flags, "seeds") ?? 3;
		jobs = flagCount(flags, "jobs") ?? 2;
		timeoutSeconds = flagCount(flags, "episode-timeout") ?? 240;
	} catch (error) {
		console.error(errorMessage(error));
		console.error(USAGE);
		process.exit(2);
	}
	const setName = flags.set ?? "default";
	const set = MINIWOB_SETS[setName];
	if (!set) {
		console.error(`no MiniWoB set ${setName}; the sets are ${Object.keys(MINIWOB_SETS).join(", ")}`);
		process.exit(2);
	}
	const tasks = flags.tasks ? flags.tasks.split(",").filter(Boolean) : [...set];
	for (const task of tasks) {
		try {
			await fs.access(path.join(miniwob, "miniwob", `${task}.html`));
		} catch {
			console.error(`no MiniWoB++ task ${task} under ${miniwob}/miniwob`);
			process.exit(2);
		}
	}
	const cli = path.resolve(flags.cli ?? path.join(import.meta.dirname, "../../../packages/coding-agent/src/cli.ts"));
	const label = flags.label ?? "run";
	const server = await startServer(miniwob);
	const work = path.resolve(flags.work ?? path.join("runs", "miniwob-work", label));
	const config = await writeBrowserOverlay(work);
	const options: EpisodeOptions = {
		cli,
		model,
		port: server.port,
		work,
		config,
		timeoutMs: timeoutSeconds * 1000,
		agentDir: flags["agent-dir"] ? path.resolve(flags["agent-dir"]) : undefined,
		rewards: server.rewards,
	};
	const queue = tasks.flatMap(task => Array.from({ length: seeds }, (_, seed) => ({ task, seed })));
	const outcomes: EpisodeOutcome[] = [];
	const worker = async (): Promise<void> => {
		for (let next = queue.shift(); next; next = queue.shift()) {
			const outcome = await runEpisode(next.task, next.seed, options);
			outcomes.push(outcome);
			console.log(
				`${label}  ${outcome.task}#${outcome.seed}  ${outcome.success ? "pass" : "FAIL"}  reward ${outcome.reward ?? "none"}  ${outcome.toolCalls} calls  ${Math.round(outcome.wallMs / 1000)} s${outcome.timedOut ? "  timed out" : ""}`,
			);
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
	} finally {
		await server.close();
	}
	outcomes.sort((a, b) => a.task.localeCompare(b.task) || a.seed - b.seed);
	const summary = summarizeMiniwob(outcomes);
	console.log(
		`${label}: ${summary.successes}/${summary.episodes} succeeded (${summary.submitted} submitted), ${summary.meanToolCalls} tool calls and ${Math.round(summary.meanWallMs / 1000)} s per episode, ${summary.inputTokens} input and ${summary.outputTokens} output tokens`,
	);
	if (flags.json !== undefined) {
		await fs.mkdir(path.dirname(path.resolve(flags.json)), { recursive: true });
		await fs.writeFile(
			flags.json,
			`${JSON.stringify({ label, model, cli, tasks, seeds, summary, outcomes }, null, 2)}\n`,
		);
	}
}
