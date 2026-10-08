/**
 * WHY: the terminal session tree and the HTML export's tree each formatted a tool call with their
 * own switch. The two drifted: the export's cases named `find` and `ls`, which no registered tool is
 * called, so most calls fell through to raw JSON cut by a UTF-16 slice, the terminal cut the same
 * JSON differently, and a newline in an `op` or `action` argument broke the tree row in both. Both
 * trees now print `formatToolCallLabel` from `@veyyon/utils/tool-call-label`.
 *
 * CLASS: a tool the agent can call whose tree label is missing, spans lines, grows without bound,
 * or leaks the home directory; and a tree that stops printing the shared label.
 *
 * - The set of labelled tool names is pinned to the registry by exact equality, read at run time
 *   from `BUILTIN_TOOLS`, `HIDDEN_TOOLS` and `VIBE_TOOL_NAMES`. A new tool with no label, or a label
 *   left for a retired tool, turns this red.
 * - Every labelled tool is driven with one hostile argument record that fills every key any labeler
 *   reads with multi-line text far past every budget, and a home-directory path containing line
 *   separators. The label must be one line, bounded per free-text part, and home-shortened.
 * - The terminal tree is rendered for every labelled tool and must contain the shared label
 *   verbatim, so a tree that reintroduces its own formatter fails.
 * - One HTML export holding a call to every labelled tool is written by `exportFromFile` and its
 *   inline scripts (the tool-views bundle and the viewer) are run against a linkedom document. The
 *   export's tree must print the same labels, in order, so the export cannot drift from the terminal.
 *
 * GAP: the export runs under linkedom with the two CDN scripts (`marked`, `highlight.js`) and
 * `scrollIntoView` stubbed, not in a browser engine. A path is never cut, so a long path still
 * produces a long label.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import type { AgentMessage } from "@veyyon/agent-core";
import { emptyUsage } from "@veyyon/catalog/models";
import { exportFromFile } from "@veyyon/coding-agent/export/html";
import { TreeSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/tree-selector";
import * as themeModule from "@veyyon/coding-agent/theme/theme";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@veyyon/coding-agent/tools";
import { VIBE_TOOL_NAMES } from "@veyyon/coding-agent/tools/agent/vibe";
import { shortenPath } from "@veyyon/coding-agent/tools/core/render-utils";
import type { SessionEntry, SessionTreeNode } from "@veyyon/kernel/session/session-entries";
import { removeWithRetries } from "@veyyon/utils";
import { formatToolCallLabel, LABELLED_TOOL_NAMES, TOOL_CALL_LABEL_LIMITS } from "@veyyon/utils/tool-call-label";
import { parseHTML } from "linkedom";

/** Wire names a transcript may record that no registry lists: `apply_patch` is the edit tool's alias. */
const ALIASES = ["apply_patch"];

const HOME = "/home/tester";
const shortenTestHome = (p: string): string => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);

/** Every line-breaking or tab character: anything `\s` matches except the plain space. */
const NON_SPACE_WHITESPACE = /[^\S ]/;

const FILLER = `${"x".repeat(300)}\n\t\u2028\v\r${"x".repeat(300)}`;
const HOSTILE_PATH = `${HOME}/proj/a\nb\u2028c\td\ve.ts`;

/** Every key any labeler reads, each filled past its budget. */
const HOSTILE_ARGS: Record<string, unknown> = {
	path: HOSTILE_PATH,
	file_path: HOSTILE_PATH,
	folder_path: HOSTILE_PATH,
	program: HOSTILE_PATH,
	file: HOSTILE_PATH,
	paths: [HOSTILE_PATH, HOSTILE_PATH],
	sel: FILLER,
	command: FILLER,
	url: FILLER,
	objective: FILLER,
	memory: FILLER,
	symbol: FILLER,
	query: FILLER,
	report: FILLER,
	reason: FILLER,
	message: FILLER,
	prompt: FILLER,
	goal: FILLER,
	title: FILLER,
	input: FILLER,
	question: FILLER,
	action: FILLER,
	name: FILLER,
	op: FILLER,
	to: FILLER,
	application: FILLER,
	id: FILLER,
	tool: FILLER,
	type: FILLER,
	host: FILLER,
	agent: FILLER,
	session: FILLER,
	cli: FILLER,
	repo: FILLER,
	language: FILLER,
	list: true,
	pullNumber: 7,
	cancel: [FILLER, FILLER],
	poll: [FILLER],
	sessions: [FILLER, FILLER],
	questions: [{ question: FILLER }, { question: FILLER }],
	cells: [{ language: FILLER, title: FILLER, code: FILLER }, {}],
	items: [{ content: FILLER }, { content: FILLER }],
	tasks: [{ description: FILLER, id: FILLER }, {}],
	ops: [{ op: FILLER, task: FILLER }, {}],
	result: { error: FILLER },
};

const LONGEST_BUDGET = Math.max(...Object.values(TOOL_CALL_LABEL_LIMITS));

function longestRun(label: string, char: string): number {
	let longest = 0;
	let run = 0;
	for (const c of label) {
		run = c === char ? run + 1 : 0;
		longest = Math.max(longest, run);
	}
	return longest;
}

function expectOneBoundedLine(label: string): void {
	expect(label).not.toMatch(NON_SPACE_WHITESPACE);
	expect(longestRun(label, "x")).toBeLessThanOrEqual(LONGEST_BUDGET);
}

let counter = 0;
function node(message: AgentMessage, parentId: string | null): SessionTreeNode {
	const entry: SessionEntry = {
		type: "message",
		id: `entry-${counter++}`,
		parentId,
		timestamp: new Date(0).toISOString(),
		message,
	};
	return { entry, children: [] };
}

function renderToolCallTree(toolName: string, args: Record<string, unknown>): string {
	const callId = `call-${counter++}`;
	const root = node({ role: "user", content: "run tool", timestamp: 1 }, null);
	const assistant = node(
		{
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }],
			api: "openai",
			provider: "openai",
			model: "test-model",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 2,
		},
		root.entry.id,
	);
	const result = node(
		{
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 3,
		},
		assistant.entry.id,
	);
	root.children.push(assistant);
	assistant.children.push(result);
	const selector = new TreeSelectorComponent(
		[root],
		result.entry.id,
		() => {},
		() => {},
	);
	return Bun.stripANSI(selector.render(400).join("\n"));
}

/** A session file whose only branch calls each named tool once with `args`, each call answered. */
function sessionWithCalls(names: readonly string[], args: Record<string, unknown>): string {
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-08-05T00:00:00.000Z", cwd: "/repo" }),
		JSON.stringify({
			type: "message",
			id: "u",
			parentId: null,
			timestamp: "2026-08-05T00:00:01.000Z",
			message: { role: "user", content: "go", timestamp: 1 },
		}),
	];
	let parentId = "u";
	names.forEach((name, i) => {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `a${i}`,
				parentId,
				timestamp: "2026-08-05T00:00:02.000Z",
				message: {
					role: "assistant",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "example",
					stopReason: "toolUse",
					timestamp: 2,
					usage: emptyUsage(),
					content: [{ type: "toolCall", id: `c${i}`, name, arguments: args }],
				},
			}),
			JSON.stringify({
				type: "message",
				id: `r${i}`,
				parentId: `a${i}`,
				timestamp: "2026-08-05T00:00:03.000Z",
				message: { role: "toolResult", toolCallId: `c${i}`, toolName: name, content: "ok", timestamp: 3 },
			}),
		);
		parentId = `r${i}`;
	});
	return `${lines.join("\n")}\n`;
}

/**
 * The tool labels an exported file's tree prints, in tree order.
 *
 * Runs every inline script of the export against a linkedom document. The two CDN scripts are not
 * fetched, so `marked` and `hljs` are stubbed, and linkedom has no layout, so `scrollIntoView` is.
 */
async function exportedTreeLabels(htmlPath: string): Promise<string[]> {
	const { window, document } = parseHTML(await fs.readFile(htmlPath, "utf8"));
	const context = vm.createContext(window);
	Object.assign(context, {
		globalThis: context,
		window: context,
		marked: { use() {}, parse: (s: string) => s },
		hljs: { highlight: (s: string) => ({ value: s }), getLanguage: () => null },
	});
	Object.defineProperty(context, "location", { value: { search: "", hash: "", href: "file:///export.html" } });
	window.HTMLElement.prototype.scrollIntoView = () => {};
	for (const script of document.querySelectorAll("script")) {
		if (script.getAttribute("src") || script.getAttribute("type") === "application/json") continue;
		vm.runInContext(script.textContent ?? "", context);
	}
	return [...document.querySelectorAll(".tree-role-tool")].map(node => node.textContent ?? "");
}

describe("a tool call reads as one bounded line in every session tree", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	let scratch: string | undefined;
	afterAll(async () => {
		if (scratch) await removeWithRetries(scratch);
	});

	it("labels exactly the tools the registry lists, plus recorded aliases", () => {
		const registered = new Set([
			...Object.keys(BUILTIN_TOOLS),
			...Object.keys(HIDDEN_TOOLS),
			...VIBE_TOOL_NAMES,
			...ALIASES,
		]);
		expect([...LABELLED_TOOL_NAMES]).toEqual([...registered].sort());
	});

	for (const name of LABELLED_TOOL_NAMES) {
		it(`${name}: hostile arguments print one bounded, home-shortened line`, () => {
			const label = formatToolCallLabel(name, HOSTILE_ARGS, shortenTestHome);
			expect(label.startsWith(`[${name}`)).toBe(true);
			expect(label.endsWith("]")).toBe(true);
			expectOneBoundedLine(label);
			expect(label).not.toContain(HOME);
		});

		it(`${name}: the terminal tree prints the shared label`, () => {
			const args = { path: "src/app.ts", command: "git status", op: "list", query: "needle" };
			const label = formatToolCallLabel(name, args, shortenPath);
			expect(renderToolCallTree(name, args)).toContain(label);
		});
	}

	it("a tool with no label prints one bounded line of its arguments, whatever its name", () => {
		const label = formatToolCallLabel("mcp__srv\n\t__tool", HOSTILE_ARGS, shortenTestHome);
		expectOneBoundedLine(label);
		expect(label.startsWith("[mcp__srv __tool: ")).toBe(true);
		expect(label.length).toBeLessThanOrEqual("[mcp__srv __tool: ]".length + TOOL_CALL_LABEL_LIMITS.ARGS);
	});

	it("arguments that are not an object print the digest rather than throwing", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		for (const args of [null, undefined, 42, "raw\nstring", [1, 2], cyclic]) {
			expectOneBoundedLine(formatToolCallLabel("read", args, shortenTestHome));
			expectOneBoundedLine(formatToolCallLabel("unknown_tool", args, shortenTestHome));
		}
	});

	it("the HTML export's tree prints the same label as the terminal for every tool", async () => {
		scratch = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-tree-labels-"));
		const names = [...LABELLED_TOOL_NAMES, "mcp__srv__tool"];
		const sessionFile = path.join(scratch, "main.jsonl");
		await fs.writeFile(sessionFile, sessionWithCalls(names, HOSTILE_ARGS));
		const htmlPath = path.join(scratch, "main.html");
		await exportFromFile(sessionFile, { outputPath: htmlPath });
		expect(await exportedTreeLabels(htmlPath)).toEqual(
			names.map(name => formatToolCallLabel(name, HOSTILE_ARGS, shortenTestHome)),
		);
	});
});
