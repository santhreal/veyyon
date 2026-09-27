/**
 * MiniWoB++ as a kit suite.
 *
 * MiniWoB++ (Farama Foundation) is a set of small synthetic web tasks: each is a static page that
 * states one instruction ("Enter the date 10/11/2016 and press Submit") and scores the attempt
 * itself in JavaScript. Each trial serves the MiniWoB++ pages on 127.0.0.1 with a script appended
 * that seeds the task, lifts MiniWoB's 10 s episode limit, and posts the raw reward (+1 success,
 * -1 failure) back to the trial's server the first time the page scores an attempt. A trial that
 * never submits scores nothing. The agent sees only the task page.
 *
 * The pages are not in this repository. Put MiniWoB++'s `miniwob/html` directory at
 * `tests/evals/datasets/miniwob/html`, from the repository root:
 *
 *   git clone https://github.com/Farama-Foundation/miniwob-plusplus ../miniwob-plusplus
 *   mkdir -p tests/evals/datasets/miniwob
 *   ln -s "$(cd ../miniwob-plusplus/miniwob/html && pwd)" tests/evals/datasets/miniwob/html
 *
 * The pages' files are part of the suite's provenance, so a run resumed against other pages is
 * refused as another plan.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PreflightVerdict } from "../../engine/contracts";
import { BROWSER_TOOL_SETTINGS, browserHostEnvironment, chromiumPreflight } from "../../engine/kit/browser-host";
import { type Difficulty, type KitTask, kitTask } from "../../engine/kit/catalog";
import { defineSuite } from "../../engine/kit/suite";
import { hostSite, jsonBody, type SiteResponse, text } from "../../engine/kit/web-host";
import { suiteDatasetDir } from "../../engine/package-paths";

/** Form entry in every shape the element actions meet, and one click-only control. */
const FORM_TASKS = [
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

/** Links, tabs, a tree, checkboxes, a list, an inbox. */
const NAVIGATION_TASKS = ["click-link", "click-tab-2", "navigate-tree", "click-checkboxes", "choose-list", "email-inbox"] as const;

/**
 * Long or fiddly tasks: a flight search form with a date picker, a custom calendar, collapsible
 * sections, forwarding a mail described in prose, acting on some posts of a feed, tabs that hide
 * their link, sorting a list by dragging, a slider, a rich-text editor and a terminal.
 */
const WIDGET_TASKS = [
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

const CAPABILITIES: Readonly<Record<string, string>> = {
	"form-entry": "text, password, date and time fields, autocompletes and short form sequences",
	navigation: "links, tabs, trees, checkboxes, lists and a small inbox",
	widgets: "date pickers, calendars, collapsibles, drag and drop, sliders, a rich-text editor and a terminal",
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".png": "image/png",
	".gif": "image/gif",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".json": "application/json",
};

/** Appended to every task page: seed the problem, lift the time limit, report the first score. */
const SETUP_SCRIPT = `<script>
(function () {
	var params = new URLSearchParams(location.search);
	core.EPISODE_MAX_TIME = 3600000;
	var end = core.endEpisode;
	core.endEpisode = function (reward, timeProportional, reason) {
		var first = core.EP_TIMER !== null;
		end.apply(core, arguments);
		if (first) {
			fetch("/reward", { method: "POST", body: JSON.stringify({ reward: WOB_RAW_REWARD_GLOBAL, reason: WOB_REWARD_REASON }) });
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

/** Where the MiniWoB++ pages are: MiniWoB++'s `miniwob/html` directory. */
export function miniwobRoot(): string {
	return suiteDatasetDir("miniwob", "html");
}

interface MiniwobState {
	/** MiniWoB's raw reward for the first submitted attempt, or null when nothing was submitted. */
	readonly reward: number | null;
	readonly reason: string | null;
}

/**
 * A file of the MiniWoB++ pages, as a trial's site serves it. A task page (`miniwob/<task>.html`
 * under `root`) gets the setup script; every other file is served as it is on disk.
 */
export async function serveFile(root: string, pathname: string): Promise<SiteResponse> {
	const file = path.join(root, path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, ""));
	if (!file.startsWith(root)) return text("forbidden", { status: 403 });
	let data: Buffer;
	try {
		data = await fs.readFile(file);
	} catch {
		return text("not found", { status: 404 });
	}
	const extension = path.extname(file);
	const type = CONTENT_TYPES[extension] ?? "application/octet-stream";
	if (extension === ".html" && path.dirname(path.relative(root, file)) === "miniwob") {
		return { headers: { "content-type": type }, body: data.toString("utf8").replace(/<\/body>/i, `${SETUP_SCRIPT}</body>`) };
	}
	return { headers: { "content-type": type }, body: data };
}

function miniwobTask(name: string, capability: string, difficulty: Difficulty): KitTask {
	return kitTask<MiniwobState>({
		id: name,
		title: `MiniWoB++ ${name}`,
		capabilities: [capability],
		difficulty,
		timeBudgetSec: 240,
		async start({ seed }) {
			const root = miniwobRoot();
			let scored: MiniwobState | null = null;
			const site = await hostSite(request => {
				if (request.method === "POST" && request.url.pathname === "/reward") {
					const posted = jsonBody(request) as { reward?: unknown; reason?: unknown } | null;
					if (scored === null && typeof posted?.reward === "number") {
						scored = { reward: posted.reward, reason: typeof posted.reason === "string" ? posted.reason : null };
					}
					return { status: 204 };
				}
				return serveFile(root, request.url.pathname);
			});
			const url = `${site.origin}/miniwob/${name}.html?seed=${seed}`;
			return {
				instruction: [
					"Use the browser tool to complete a task on a web page.",
					`Open ${url} in a tab named "task".`,
					"The page states the task in the box at its top (the element #query). Do what it says in the page.",
					"You get one attempt: the page scores the first time the task is submitted. Do not reload the page.",
					"When you have submitted, reply DONE.",
				].join("\n"),
				// The page scores itself in JavaScript, so no HTTP request can perform the task. This
				// posts the score the page posts on success, which proves the grading path only.
				async solve() {
					await fetch(`${site.origin}/reward`, { method: "POST", body: JSON.stringify({ reward: 1, reason: "scripted" }) });
					return "DONE";
				},
				async finish() {
					await site.close();
					return scored ?? { reward: null, reason: null };
				},
			};
		},
		checks: [
			{
				id: "succeeded",
				description: "the page scored the first submitted attempt a success",
				pass: state => (state.reward ?? 0) > 0,
			},
		],
	});
}

export const MINIWOB_TASKS: readonly KitTask[] = [
	...FORM_TASKS.map(name => miniwobTask(name, "form-entry", "easy")),
	...NAVIGATION_TASKS.map(name => miniwobTask(name, "navigation", "easy")),
	...WIDGET_TASKS.map(name => miniwobTask(name, "widgets", "hard")),
];

async function preflight(): Promise<PreflightVerdict> {
	const root = miniwobRoot();
	const missing: string[] = [];
	for (const task of MINIWOB_TASKS) {
		try {
			await fs.access(path.join(root, "miniwob", `${task.id}.html`));
		} catch {
			missing.push(task.id);
		}
	}
	if (missing.length > 0) {
		return {
			ok: false,
			reason: `the MiniWoB++ pages are not at ${root} (missing ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}); link MiniWoB++'s miniwob/html directory there`,
			missingRequirements: ["miniwob-pages"],
		};
	}
	return await chromiumPreflight();
}

export default defineSuite({
	id: "miniwob",
	version: "1.0.0",
	displayName: "MiniWoB++",
	description: "Small synthetic web tasks from MiniWoB++, each scored by its own page.",
	sourceDir: import.meta.dirname,
	datasetDir: miniwobRoot(),
	capabilities: CAPABILITIES,
	tasks: MINIWOB_TASKS,
	tools: ["browser"],
	settings: BROWSER_TOOL_SETTINGS,
	defaultTimeBudgetSec: 240,
	preflight,
	hostEnvironment: browserHostEnvironment,
});
