/**
 * Real-page browser bench.
 *
 * MiniWoB++ pages are a few hundred characters, so what a model pays to read a real page (a catalogue,
 * an article, a login) never shows there. These tasks run on public pages kept for browser practice
 * (books.toscrape.com, quotes.toscrape.com, the-internet.herokuapp.com, httpbin.org) and Wikipedia.
 * The `easy` set reads a large listing, follows links, logs in, fills and submits a form and waits for
 * content that loads late; the `hard` set needs frames, a second window, dialogs, hover, drag and drop,
 * HTTP authentication, an upload, a postback form, scrolling and more than one page. Each asks for one
 * fact the page shows and is scored by the model's `ANSWER:` line.
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
	/** Text the answer must contain, compared without case, or a pattern it must match. */
	readonly expected: string | RegExp;
	/** Files the episode starts with in its working directory, by name. */
	readonly files?: Readonly<Record<string, string>>;
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

/**
 * Tasks that need more than reading and clicking: a frame, a second window, a JS dialog, a context
 * menu, hover, HTML5 drag and drop, HTTP authentication, a file upload, a control that enables late,
 * a 50×50 table, infinite scroll, a form whose second list is filled by a postback, a count across
 * two pages of a listing, a shadow-root template, and a second article reached through the first.
 * Each answer was established by code against the live page, not by a model.
 */
export const HARD_WEB_TASKS: readonly WebTask[] = [
	{
		id: "iframe-editor",
		url: "https://the-internet.herokuapp.com/iframe",
		instruction: "Report the text inside the rich-text editor's document.",
		expected: "Your content goes here",
	},
	{
		id: "nested-frames",
		url: "https://the-internet.herokuapp.com/nested_frames",
		instruction: "The page is built of nested frames. Report the text of the middle frame.",
		expected: "MIDDLE",
	},
	{
		id: "new-window",
		url: "https://the-internet.herokuapp.com/windows",
		instruction: 'Click "Click Here", which opens a new window, and report the heading of that new window.',
		expected: "New Window",
	},
	{
		id: "js-prompt",
		url: "https://the-internet.herokuapp.com/javascript_alerts",
		instruction: 'Click "Click for JS Prompt", enter veyyon into the prompt and accept it, then report the result line the page shows.',
		expected: "You entered: veyyon",
	},
	{
		id: "context-menu",
		url: "https://the-internet.herokuapp.com/context_menu",
		instruction: "Right-click inside the box and report the message of the alert that appears.",
		expected: "You selected a context menu",
	},
	{
		id: "hover-profile",
		url: "https://the-internet.herokuapp.com/hovers",
		instruction: "Hover over the third user picture and report the name that appears.",
		expected: "user3",
	},
	{
		id: "drag-drop",
		url: "https://the-internet.herokuapp.com/drag_and_drop",
		instruction: "Drag box A onto box B so they swap, then report the letter now shown in the left box.",
		expected: /^[^A-Za-z]*B[^A-Za-z]*$/,
	},
	{
		id: "basic-auth",
		url: "https://the-internet.herokuapp.com/basic_auth",
		instruction: "The page asks for HTTP basic authentication. Sign in as admin with password admin and report the message shown.",
		expected: "Congratulations",
	},
	{
		id: "upload-file",
		url: "https://the-internet.herokuapp.com/upload",
		instruction:
			"Upload the file veyyon-upload.txt from your working directory with the page's form and report the file name the page lists as uploaded.",
		expected: "veyyon-upload.txt",
		files: { "veyyon-upload.txt": "uploaded by the veyyon bench\n" },
	},
	{
		id: "dynamic-controls",
		url: "https://the-internet.herokuapp.com/dynamic_controls",
		instruction: "Enable the disabled text field with its button and report the message shown once it is enabled.",
		expected: "It's enabled!",
	},
	{
		id: "large-table",
		url: "https://the-internet.herokuapp.com/large",
		instruction: "In the large table, report the value in row 50, column 50.",
		expected: "50.50",
	},
	{
		id: "quotes-scroll",
		url: "https://quotes.toscrape.com/scroll",
		instruction: "Quotes load as you scroll. Report the author of the 25th quote.",
		expected: "Jim Henson",
	},
	{
		id: "quotes-search",
		url: "https://quotes.toscrape.com/search.aspx",
		instruction: 'Search for quotes by Albert Einstein with the tag "world" and report the quote the search finds.',
		expected: "process of our thinking",
	},
	{
		id: "books-five-star",
		url: "https://books.toscrape.com/catalogue/category/books/mystery_3/index.html",
		instruction: "How many books in the Mystery category, across all of its pages, have a five-star rating?",
		expected: /^\D*\b5\b\D*$/,
	},
	{
		id: "shadow-default",
		url: "https://the-internet.herokuapp.com/shadowdom",
		instruction:
			"The page's my-paragraph element renders a shadow-root template. Report the default text the template shows when nothing is slotted in.",
		expected: "My default text",
	},
	{
		id: "wiki-two-hop",
		url: "https://en.wikipedia.org/wiki/Web_browser",
		instruction:
			"Find who created the first web browser, open that person's article, and report their date of birth as written there.",
		expected: "8 June 1955",
	},
];

/**
 * Long flows on application pages: a React shop's sign-in, cart and checkout; its sort control; a
 * to-do app driven by typing and keys; and a detail page reached by comparing a listing. Each answer
 * was established by code against the live page.
 */
export const EXPERT_WEB_TASKS: readonly WebTask[] = [
	{
		id: "shop-checkout",
		url: "https://www.saucedemo.com/",
		instruction:
			"Sign in as standard_user with password secret_sauce, add the Sauce Labs Backpack and the Sauce Labs Bike Light to the cart, check out with any name and postal code, and report the order total shown before finishing.",
		expected: "43.18",
	},
	{
		id: "shop-sort",
		url: "https://www.saucedemo.com/",
		instruction:
			"Sign in as standard_user with password secret_sauce, sort the products by price from high to low, and report the name of the first product.",
		expected: "Sauce Labs Fleece Jacket",
	},
	{
		id: "todo-flow",
		url: "https://demo.playwright.dev/todomvc/",
		instruction:
			'Add three todos: "buy milk", "walk dog" and "write report". Mark "walk dog" as completed, show only the active todos, and report the item counter text.',
		expected: "2 items left",
	},
	{
		id: "books-upc",
		url: "https://books.toscrape.com/catalogue/category/books/travel_2/index.html",
		instruction: "Open the most expensive book in the Travel category and report its UPC.",
		expected: "9e60929f521fa280",
	},
];

/** The task sets `--set` names. */
export const WEB_TASK_SETS: Readonly<Record<string, readonly WebTask[]>> = {
	easy: WEB_TASKS,
	hard: HARD_WEB_TASKS,
	expert: EXPERT_WEB_TASKS,
	all: [...WEB_TASKS, ...HARD_WEB_TASKS, ...EXPERT_WEB_TASKS],
};

export const WEB_TASKS_BENCH_FLAGS = {
	valued: {
		model: true,
		cli: true,
		label: true,
		json: true,
		tasks: true,
		set: true,
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
	"         [--label <name>] [--json <out.json>] [--set easy|hard|expert|all, default easy] [--tasks a,b,...]",
	"         [--repeats <n, default 2>] [--jobs <n, default 2>] [--episode-timeout <s, default 240>]",
	"         [--agent-dir <dir with the model's sign-in>] [--work <dir, default runs/web-work>]",
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

/** Whether `answer` holds `expected`: contains the text without case, or matches the pattern. */
export function answerMatches(answer: string, expected: string | RegExp): boolean {
	return typeof expected === "string" ? answer.toLowerCase().includes(expected.toLowerCase()) : expected.test(answer);
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
	const setName = flags.set ?? "easy";
	const set = WEB_TASK_SETS[setName];
	if (!set) {
		console.error(`no web task set ${setName}; the sets are ${Object.keys(WEB_TASK_SETS).join(", ")}`);
		process.exit(2);
	}
	const every = WEB_TASK_SETS.all ?? [];
	const named = flags.tasks ? flags.tasks.split(",").filter(Boolean) : set.map(task => task.id);
	const tasks = named.map(id => every.find(task => task.id === id));
	const unknown = named.filter((_id, index) => tasks[index] === undefined);
	if (unknown.length > 0) {
		console.error(`no web task ${unknown.join(", ")}; the tasks are ${every.map(task => task.id).join(", ")}`);
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
				...(task.files ? { files: task.files } : {}),
			});
			const answer = answerOf(finalText(run.stdout));
			const outcome: WebOutcome = {
				task: task.id,
				repeat,
				answer,
				success: answerMatches(answer, task.expected),
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
