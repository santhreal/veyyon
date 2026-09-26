/**
 * Real-page browser bench.
 *
 * MiniWoB++ pages are a few hundred characters, so what a model pays to read a real page (a catalogue,
 * an article, a login) never shows there. These tasks run on public pages kept for browser practice
 * (books.toscrape.com, quotes.toscrape.com, the-internet.herokuapp.com, httpbin.org) and one
 * Wikipedia article: reading a large listing, following links, logging in, filling and submitting a
 * form, waiting for content that loads late. Each asks for one fact the page shows and is scored by
 * whether the model's `ANSWER:` line holds it.
 *
 * Each episode runs the veyyon CLI in print mode with only the browser tool (`cli-episode.ts`). Before
 * and after a change, run the same flags with `--cli` pointed at each tree's
 * `packages/coding-agent/src/cli.ts`, at the same time, so both arms meet the same pages and the same
 * provider latency.
 *
 * Deliberately NOT a test: it needs a live model and the network, and the answers hold for the pages
 * as they were when the tasks were written.
 *
 *   bun benches/web-tasks.ts --model google-antigravity/gemini-3.8-flash \
 *     --cli ../before/packages/coding-agent/src/cli.ts --label before --json runs/web-before.json
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { type FlagGrammar, flagCount, parseFlags, requireFlag } from "../engine/flag-grammar";
import { type EpisodeUsage, finalText, runCliEpisode, writeBrowserOverlay } from "./cli-episode";

export interface WebTask {
	readonly id: string;
	readonly url: string;
	readonly instruction: string;
	/** Text the answer must contain, compared without case. */
	readonly expected: string;
}

export const WEB_TASKS: readonly WebTask[] = [
	{
		id: "books-price",
		url: "https://books.toscrape.com/",
		instruction: 'Find the book titled "Sharp Objects" and report its price.',
		expected: "£47.82",
	},
	{
		id: "books-category",
		url: "https://books.toscrape.com/",
		instruction: 'Open the "Poetry" category and report how many books it lists.',
		expected: "19",
	},
	{
		id: "quotes-login-tag",
		url: "https://quotes.toscrape.com/login",
		instruction:
			'Log in (any username and password are accepted), then find the quotes tagged "humor" and report the author of the first one.',
		expected: "Jane Austen",
	},
	{
		id: "internet-login",
		url: "https://the-internet.herokuapp.com/login",
		instruction:
			"Log in with username tomsmith and password SuperSecretPassword! and report the message shown after logging in.",
		expected: "You logged into a secure area",
	},
	{
		id: "internet-table",
		url: "https://the-internet.herokuapp.com/tables",
		instruction: "In Example 1, report the amount due for the person whose last name is Conway.",
		expected: "$50.00",
	},
	{
		id: "httpbin-form",
		url: "https://httpbin.org/forms/post",
		instruction:
			"Order a large pizza with bacon for customer Ada, telephone 555-0100, submit the form, and report the pizza size the server echoes back.",
		expected: "large",
	},
	{
		id: "wikipedia-fact",
		url: "https://en.wikipedia.org/wiki/Web_browser",
		instruction: "According to the article, in what year was the first web browser, WorldWideWeb, created?",
		expected: "1990",
	},
	{
		id: "internet-dynamic",
		url: "https://the-internet.herokuapp.com/dynamic_loading/2",
		instruction: "Start the loading and report the text that appears when it finishes.",
		expected: "Hello World!",
	},
];

export const WEB_TASKS_BENCH_FLAGS = {
	valued: {
		model: true,
		cli: true,
		label: true,
		json: true,
		tasks: true,
		repeats: true,
		jobs: true,
		"episode-timeout": true,
		"agent-dir": true,
		work: true,
	},
	valueless: { help: true },
} as const satisfies FlagGrammar;

const USAGE = [
	"usage: bun benches/web-tasks.ts --model <provider/id> [--cli <tree>/packages/coding-agent/src/cli.ts]",
	"         [--label <name>] [--json <out.json>] [--tasks a,b,...] [--repeats <n, default 2>] [--jobs <n, default 2>]",
	"         [--episode-timeout <s, default 240>] [--agent-dir <dir with the model's sign-in>] [--work <dir, default runs/web-work>]",
].join("\n");

export interface WebOutcome extends EpisodeUsage {
	readonly task: string;
	readonly repeat: number;
	readonly answer: string;
	readonly success: boolean;
	readonly wallMs: number;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
}

function taskPrompt(task: WebTask): string {
	return [
		"Use the browser tool to answer a question about a web page.",
		`Open ${task.url} in a tab named "task".`,
		task.instruction,
		"When you have the answer, reply with one line: ANSWER: <answer>",
	].join("\n");
}

/** The episode's `ANSWER:` line, or nothing when it gave none. */
export function answerOf(text: string): string {
	const line = text
		.split("\n")
		.reverse()
		.find(candidate => /ANSWER:/i.test(candidate));
	return line ? line.slice(line.search(/ANSWER:/i) + "ANSWER:".length).trim() : "";
}

if (import.meta.main) {
	let flags: Record<string, string>;
	let model: string;
	let repeats: number;
	let jobs: number;
	let timeoutSeconds: number;
	try {
		flags = parseFlags(process.argv.slice(2), WEB_TASKS_BENCH_FLAGS);
		if (flags.help !== undefined) {
			console.log(USAGE);
			process.exit(0);
		}
		model = requireFlag(flags, "model", "e.g. --model google-antigravity/gemini-3.8-flash");
		repeats = flagCount(flags, "repeats") ?? 2;
		jobs = flagCount(flags, "jobs") ?? 2;
		timeoutSeconds = flagCount(flags, "episode-timeout") ?? 240;
	} catch (error) {
		console.error(errorMessage(error));
		console.error(USAGE);
		process.exit(2);
	}
	const named = flags.tasks ? flags.tasks.split(",").filter(Boolean) : WEB_TASKS.map(task => task.id);
	const tasks = named.map(id => WEB_TASKS.find(task => task.id === id));
	const unknown = named.filter((_id, index) => tasks[index] === undefined);
	if (unknown.length > 0) {
		console.error(`no web task ${unknown.join(", ")}; the tasks are ${WEB_TASKS.map(task => task.id).join(", ")}`);
		process.exit(2);
	}
	const cli = path.resolve(flags.cli ?? path.join(import.meta.dirname, "../../../packages/coding-agent/src/cli.ts"));
	const label = flags.label ?? "run";
	const work = path.resolve(flags.work ?? path.join("runs", "web-work", label));
	const config = await writeBrowserOverlay(work);
	const agentDir = flags["agent-dir"] ? path.resolve(flags["agent-dir"]) : undefined;
	const queue = (tasks as WebTask[]).flatMap(task => Array.from({ length: repeats }, (_, repeat) => ({ task, repeat })));
	const outcomes: WebOutcome[] = [];
	const worker = async (): Promise<void> => {
		for (let next = queue.shift(); next; next = queue.shift()) {
			const { task, repeat } = next;
			const run = await runCliEpisode({
				cli,
				model,
				prompt: taskPrompt(task),
				work,
				episode: `${task.id}-${repeat}`,
				config,
				timeoutMs: timeoutSeconds * 1000,
				agentDir,
			});
			const answer = answerOf(finalText(run.stdout));
			const outcome: WebOutcome = {
				task: task.id,
				repeat,
				answer,
				success: answer.toLowerCase().includes(task.expected.toLowerCase()),
				wallMs: run.wallMs,
				...run.usage,
				exitCode: run.exitCode,
				timedOut: run.timedOut,
			};
			outcomes.push(outcome);
			console.log(
				`${label}  ${task.id}#${repeat}  ${outcome.success ? "pass" : "FAIL"}  ${outcome.turns} turns  ${outcome.inputTokens + outcome.cacheReadTokens} in  ${Math.round(outcome.wallMs / 1000)} s${outcome.timedOut ? "  timed out" : ""}  ${JSON.stringify(answer.slice(0, 60))}`,
			);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
	outcomes.sort((a, b) => a.task.localeCompare(b.task) || a.repeat - b.repeat);
	const successes = outcomes.filter(outcome => outcome.success).length;
	const sum = (pick: (outcome: WebOutcome) => number): number =>
		outcomes.reduce((total, outcome) => total + pick(outcome), 0);
	console.log(
		`${label}: ${successes}/${outcomes.length} answered, ${(sum(o => o.turns) / outcomes.length).toFixed(2)} turns and ${Math.round(sum(o => o.wallMs) / outcomes.length / 1000)} s per episode, ${sum(o => o.inputTokens + o.cacheReadTokens)} input (${sum(o => o.cacheReadTokens)} cached) and ${sum(o => o.outputTokens)} output tokens`,
	);
	if (flags.json !== undefined) {
		await fs.mkdir(path.dirname(path.resolve(flags.json)), { recursive: true });
		await fs.writeFile(flags.json, `${JSON.stringify({ label, model, cli, repeats, outcomes }, null, 2)}\n`);
	}
}
