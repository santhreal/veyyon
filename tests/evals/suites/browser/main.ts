/**
 * The browser suite: tasks performed with the browser tool against web applications this suite
 * starts on 127.0.0.1 for each trial.
 *
 * Every application is local and seeded, so a task's data differ between repeats and not between
 * the arms of one comparison, and nothing depends on a public site that changes or goes away. Each
 * task is graded by what the application recorded (the order placed, the setting saved, the message
 * sent) and by the agent's final answer, never by what a page looked like.
 */

import { BROWSER_TOOL_SETTINGS, browserHostEnvironment, chromiumPreflight } from "../../engine/kit/browser-host";
import type { KitTask } from "../../engine/kit/catalog";
import { defineSuite } from "../../engine/kit/suite";
import { ANALYTICS_TASKS } from "./apps/analytics/tasks";
import { BANK_TASKS } from "./apps/bank/tasks";
import { HELPDESK_TASKS } from "./apps/helpdesk/tasks";
import { KANBAN_TASKS } from "./apps/kanban/tasks";
import { MAIL_TASKS } from "./apps/mail/tasks";
import { SHEET_TASKS } from "./apps/sheet/tasks";
import { SHOP_TASKS } from "./apps/shop/tasks";
import { TRAVEL_TASKS } from "./apps/travel/tasks";
import { WORKFLOW_TASKS } from "./apps/workflows/tasks";

/** What a task can exercise; the run report breaks pass rates down by these. */
export const BROWSER_CAPABILITIES: Readonly<Record<string, string>> = {
	forms: "filling and submitting forms, including server-side validation errors",
	overlays: "dialogs, popovers and banners that cover the page until dismissed",
	"search-filter": "finding records through search, filters, sorting and pagination",
	"multi-page": "work spread over several pages or steps",
	auth: "signing in, sessions and second factors",
	reading: "extracting facts from pages, including collapsed or secondary content",
	reasoning: "deciding the right action from several facts: totals, rules, constraints",
	virtualized: "long lists that render only the rows in view",
	"drag-drop": "moving items by dragging",
	"shadow-dom": "controls inside shadow roots",
	iframes: "content in frames, including frames of another origin",
	"multi-tab": "work across two applications or tabs",
	dialogs: "native alert, confirm and prompt dialogs",
	uploads: "attaching files from the workspace",
	downloads: "files the application generates",
	canvas: "content drawn on a canvas rather than in the DOM",
	keyboard: "keyboard shortcuts and keyboard-driven widgets",
	"inline-edit": "editing in place: double-click editors and contenteditable",
	injection: "page text that tries to redirect the agent",
	timing: "content that appears after a delay or changes over time",
	"date-picker": "custom date and time widgets",
	workflow: "one job carried across applications, each step using what another found",
};

/** Every task of the suite, application by application. */
export const BROWSER_TASKS: readonly KitTask[] = [
	...SHOP_TASKS,
	...MAIL_TASKS,
	...BANK_TASKS,
	...KANBAN_TASKS,
	...SHEET_TASKS,
	...TRAVEL_TASKS,
	...HELPDESK_TASKS,
	...ANALYTICS_TASKS,
	...WORKFLOW_TASKS,
];

export default defineSuite({
	id: "browser",
	version: "1.1.0",
	displayName: "Browser",
	description: "Hard web tasks on seeded local applications, graded by the state the applications record.",
	sourceDir: import.meta.dirname,
	capabilities: BROWSER_CAPABILITIES,
	tasks: BROWSER_TASKS,
	tools: ["browser"],
	settings: BROWSER_TOOL_SETTINGS,
	defaultTimeBudgetSec: 600,
	// A hard task takes tens of turns and up to a few million tokens, a workflow several times that;
	// the ladders reach past it, and the seconds reach the longest time budget, so the last column
	// counts every pass.
	budgets: {
		turns: [10, 20, 40, 80, 160],
		tokens: [250_000, 500_000, 1_000_000, 2_000_000, 4_000_000, 8_000_000],
		seconds: [60, 120, 300, 600, 900, 1200],
	},
	preflight: chromiumPreflight,
	hostEnvironment: browserHostEnvironment,
});
