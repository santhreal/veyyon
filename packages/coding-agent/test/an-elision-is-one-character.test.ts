/**
 * WHY THIS SUITE EXISTS.
 *
 * An elision is a mark that says text was left out, and the product had two
 * spellings of it. Rows drawn a few lines apart disagreed: the session tree cut
 * a bash command with three ASCII periods while the row above it cut a path
 * with `…`, the update CLI reported four steps as `Downloading...` while the
 * loader beside it said `Loading...`, the thinking display elided a fenced code
 * block with `...` while the diff renderer normalised the same mark to `…`, and
 * three command loaders each kept 60 UTF-16 code units and then appended three
 * periods, which is 63 columns of a 60-column budget.
 *
 * THE CLASS. An elision on a displayed row is one `…`. The cut that produced it
 * is measured in CELLS through `truncateToWidth`, because the row's budget is
 * columns of a terminal; the mark is one character wide, so a 60-cell budget
 * yields 60 cells rather than 63.
 *
 * THE BOUNDARY, and there are five registers this rule does NOT reach:
 *
 * - A RECOGNISER. `modes/components/diff.ts`, `edit/diff.ts` and
 *   `tools/render-utils.ts` read a diff gap row out of a transcript or a patch
 *   somebody else wrote, so they accept both spellings and display one. The
 *   ASCII→Unicode normaliser in `packages/utils/src/prompt.ts` has three
 *   periods as its lookup KEY for the same reason.
 * - Text written for the MODEL: the `modelOut` half of a search result, a
 *   scraper's first-line note, the truncation sentinel in a memory bank, the
 *   surface excerpt in a rule prompt. The model reads bytes, not columns.
 * - USAGE GRAMMAR. `<command...>`, `<task...>`, `<keyword...>` and
 *   `plugin install <source> ...` state that an argument repeats. That is
 *   syntax quoted in a help row, not a cut, and it is not mechanically
 *   separable from a row, so each one is named below.
 * - A SHAPE quoted back in an error: `#...#` around a secret placeholder,
 *   `q=SELECT ...` in a sqlite refusal, `bunx @smithery/cli run ...` in a
 *   registry note, a `A...B` git range.
 * - A CHARACTER cap. `truncate(text, n)` counts code units by contract, and
 *   the forty-odd call sites that want a character bound keep it; only the ones
 *   whose result is a ROW moved to cells.
 *
 * WHAT IT DOES NOT CATCH. Three things, named rather than implied.
 *
 * The sweep reads string literals, so a mark assembled at run time from
 * variables is invisible to it. The three command loaders now route through
 * `descriptionFromBody`, and the sweep would catch one of them re-adding an
 * ASCII mark, but not one re-deriving the cut in code units and marking it with
 * a correct `…` — that is a duplication defect, and this suite pins the owner's
 * behaviour rather than the absence of a second copy.
 *
 * A substitution inside a template literal is read as one opaque hole
 * ({@link HOLE}), so a mark whose periods span a hole is not seen.
 *
 * And a row that elides when it did not need to, or fails to when it should:
 * the rule is about spelling and unit, not about judgement.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import { emptyUsage } from "@veyyon/catalog/models";
import { renderDashboardLines } from "@veyyon/coding-agent/autoresearch/dashboard";
import type { AutoresearchRuntime, ExperimentState } from "@veyyon/coding-agent/autoresearch/types";
import { renderDiff } from "@veyyon/coding-agent/modes/components/diff";
import { emptyRow, emptyRowIn } from "@veyyon/coding-agent/modes/components/search-band";
import { TreeSelectorComponent } from "@veyyon/coding-agent/modes/components/tree-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { theme } from "@veyyon/coding-agent/modes/theme/theme-binding";
import type { SessionEntry, SessionTreeNode } from "@veyyon/coding-agent/session/session-entries";
import { descriptionFromBody } from "@veyyon/coding-agent/utils/command-description";
import { visibleWidth } from "@veyyon/tui";
import { HOLE, scanSource, sources } from "./helpers/source-literals";
import { useFullColor } from "./helpers/theme-assertions";

/** The four trees that draw rows. Each prefix keys its files so they cannot collide. */
const ROOTS: ReadonlyArray<{ prefix: string; dir: string }> = [
	{ prefix: "", dir: path.resolve(import.meta.dir, "../src") },
	{ prefix: "tui/", dir: path.resolve(import.meta.dir, "../../tui/src") },
	{ prefix: "utils/", dir: path.resolve(import.meta.dir, "../../utils/src") },
	{ prefix: "tool-render/", dir: path.resolve(import.meta.dir, "../../tool-render/src") },
];

/** Characters that make a following `...` spread, rest or call syntax rather than a mark. */
const SYNTAX_BEFORE = ["[", "(", "{", "<", ":", "=", ",", "|", "&", "?"] as const;

/**
 * Strings holding three ASCII periods for a reason, keyed by file, with the
 * exact strings pinned.
 *
 * Keyed by file AND by string: `tools/text-search.ts` and `modes/components/diff.ts`
 * each draw real rows as well as the exempt one, so excusing a whole file would
 * excuse the next offender in the two surfaces that carry both.
 */
const EXEMPT: Record<string, { why: string; strings: readonly string[] }> = {
	"cli/plugin-cli.ts": {
		why: "Usage grammar: the trailing `...` says the argument repeats.",
		strings: [
			`Usage: ${HOLE} plugin install <source>[features] ...`,
			`Usage: ${HOLE} plugin uninstall <package> ...`,
			`Usage: ${HOLE} plugin ${HOLE} <plugin> ...`,
		],
	},
	"edit/diff.ts": {
		why: "A recogniser: the patch parser accepts a gap row a model wrote in either spelling.",
		strings: ["..."],
	},
	"extensibility/custom-commands/bundled/review/index.ts": {
		why: "A git revision range, `base...head`, passed to git rather than shown.",
		strings: [`${HOLE}...${HOLE}`],
	},
	"mcp/smithery-registry.ts": {
		why: "A shell command quoted in a note about how a server runs.",
		strings: ["Runs through Smithery CLI at runtime (`bunx @smithery/cli run ...`)."],
	},
	"memories/index.ts": {
		why: "The truncation sentinel inside memory text the model reads, not a row.",
		strings: [`${HOLE}\n\n...[truncated]...\n\n${HOLE}`],
	},
	"modes/components/diff.ts": {
		why: "A recogniser: a gap row from an older transcript is accepted and displayed as one `…`.",
		strings: ["..."],
	},
	"modes/controllers/command-controller.ts": {
		why: "Usage grammar for `/memory`, where `mm ...` takes the rest of the line.",
		strings: ["Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild|mm ...>"],
	},
	"modes/controllers/mcp-command-controller.ts": {
		why: "Usage grammar: `<command...>` and `<keyword...>` consume the rest of the line.",
		strings: [
			"Usage: /mcp add <name> [http|sse] [url <url>] [token <token>] [run <command...>]",
			"Usage: /mcp smithery-search <keyword...> [<limit 1-100>] [semantic]",
			"write `run <command...>`, which takes the whole rest of the line",
			"Use either `url <url>` or `run <command...>`, not both.",
		],
	},
	"modes/controllers/omfg-rule.ts": {
		why: "A prompt line listing surfaces for the model, not a row on screen.",
		strings: [`- ... ${HOLE}`],
	},
	"modes/controllers/todo-command-controller.ts": {
		why: "Usage grammar: `<task...>` takes the rest of the line.",
		strings: [
			"  /todo append [<phase>] <task...>   Append a task; phase fuzzy-matched or auto-created",
			"Usage: /todo append [<phase>] <task...>",
		],
	},
	"secrets/placeholder.ts": {
		why: "The placeholder's own syntax, `#NAME#`, quoted in the refusal that explains it.",
		strings: ["The name appears inside #...# in text the model reads, so it has to be unambiguous there."],
	},
	"slash-commands/builtin-declarations.ts": {
		why: "Usage grammar in the declared argument shapes for /todo and /mcp.",
		strings: [
			"[<phase>] <task...>",
			"<name> [http|sse] [url <url>] [token <token>] [run <command...>]",
			"<keyword...> [<limit 1-100>] [semantic]",
		],
	},
	"slash-commands/helpers/mcp.ts": {
		why: "The same usage grammar, in the non-interactive half of /mcp.",
		strings: [
			"Usage: /mcp add <name> [http|sse] [url <url>] [token <token>] [run <command...>]",
			"Usage: /mcp smithery-search <keyword...> [<limit 1-100>] [semantic]",
			"write `run <command...>`, which takes the whole rest of the line",
			`Provide \`url <url>\` or \`run <command...>\` for non-interactive add.\n${HOLE}`,
			"Use either `url <url>` or `run <command...>`, not both.",
			"  /mcp add <name> run <command...>                        Add a stdio server",
			"  /mcp smithery-search <keyword...> [<limit>] [semantic]  Search Smithery registry",
		],
	},
	"slash-commands/helpers/todo.ts": {
		why: "The same usage grammar, in the non-interactive half of /todo.",
		strings: ["  /todo append [<phase>] <task...>   Append a task", "Usage: /todo append [<phase>] <task...>"],
	},
	"tools/render-utils.ts": {
		why: "A recogniser: the shared diff segmenter accepts a gap row in either spelling.",
		strings: ["..."],
	},
	"tools/sqlite-reader.ts": {
		why: "A SQL shape quoted back in four refusals that tell the caller which form to use.",
		strings: [
			"SQLite 'where' clause must not contain comments or statement terminators; use '?q=SELECT ...' for raw SQL",
			"SQLite 'where' clause must not contain LIMIT/OFFSET/UNION/INTERSECT/EXCEPT/ATTACH/DETACH/PRAGMA; use '?q=SELECT ...' for raw SQL",
			"SQLite query parameters require a table selector or q=SELECT...",
			"SQLite where clause changed the expected pagination parameters; use q=SELECT ... for raw SQL",
		],
	},
	"tools/text-search.ts": {
		why: "The model's half of a search result: the gap between non-adjacent lines, in bytes. The display half beside it draws `│…`.",
		strings: ["..."],
	},
	"web/scrapers/docs-rs.ts": {
		why: "A scraped first line cut for the model at 200 characters.",
		strings: ["..."],
	},
	"utils/prompt.ts": {
		why: "The lookup KEY of the ASCII→Unicode normaliser: three periods is what it maps FROM.",
		strings: ["..."],
	},
};

/**
 * Whether a literal body holds three periods used as an elision MARK.
 *
 * Only the mechanically decidable forms are excluded here — a longer run of
 * periods, a spread or call adjacency, a path or glob, a GraphQL inline
 * fragment. A literal that is a SHAPE rather than a row is named in
 * {@link EXEMPT} with its reason, so a new one fails the sweep instead of being
 * absorbed by a filter nobody can read.
 */
export function marksAnElision(body: string): boolean {
	for (let at = body.indexOf("..."); at !== -1; at = body.indexOf("...", at + 3)) {
		const after = body.slice(at + 3);
		const before = body.slice(0, at).trimEnd();
		// Four or more periods in a row is not an ellipsis: `.${base}.${id}.tmp`.
		if (before.endsWith(".") || after.startsWith(".")) continue;
		if (SYNTAX_BEFORE.some(character => before.endsWith(character))) continue;
		if (before === "" && /^\s*[\])}]/.test(after)) continue;
		// A path or a glob: `.../cli/x.ts`, `./...`.
		if (before.endsWith("/") || after.startsWith("/")) continue;
		// A GraphQL inline fragment: `... on FileMatch`.
		if (after.startsWith(" on ")) continue;
		return true;
	}
	return false;
}

/** `<file>` → the marking strings it holds, deduplicated, over every tree. */
function sweep(): Map<string, string[]> {
	const hits = new Map<string, string[]>();
	for (const { prefix, dir } of ROOTS) {
		for (const file of sources(dir)) {
			const relative = prefix + path.relative(dir, file).split(path.sep).join("/");
			for (const { body } of scanSource(fs.readFileSync(file, "utf8")).literals) {
				if (!body.includes("...") || !marksAnElision(body)) continue;
				const bucket = hits.get(relative) ?? [];
				if (!bucket.includes(body)) bucket.push(body);
				hits.set(relative, bucket);
			}
		}
	}
	return hits;
}

/** `<file>: <string>` for every marking string no exemption covers. */
function offenders(): string[] {
	const found: string[] = [];
	for (const [file, strings] of sweep()) {
		const allowed = EXEMPT[file]?.strings ?? [];
		for (const body of strings) if (!allowed.includes(body)) found.push(`${file}: ${JSON.stringify(body)}`);
	}
	return found.sort();
}

function experimentState(): ExperimentState {
	return {
		results: [],
		bestMetric: null,
		bestDirection: "higher",
		metricName: "accuracy",
		metricUnit: "%",
		secondaryMetrics: [],
		name: null,
		goal: null,
		currentSegment: 0,
		maxExperiments: null,
		breadth: 1,
		confidence: null,
		scopePaths: [],
		offLimits: [],
		constraints: [],
		notes: "",
		branch: null,
		baselineCommit: null,
		sessionId: null,
	};
}

/** A runtime whose experiment log is empty and whose mode is off: the dashboard's empty state. */
function idleRuntime(): AutoresearchRuntime {
	return {
		autoresearchMode: false,
		autoResumeArmed: false,
		dashboardExpanded: false,
		lastAutoResumePendingRunNumber: null,
		lastRunDuration: null,
		lastRunAsi: null,
		lastRunArtifactDir: null,
		lastRunNumber: null,
		lastRunSummary: null,
		runningExperiment: null,
		state: experimentState(),
		goal: null,
		pendingSwarm: null,
	};
}

let nodeCounter = 0;

function messageNode(message: AgentMessage, parentId: string | null): SessionTreeNode {
	const id = `entry-${nodeCounter++}`;
	const entry: SessionEntry = { type: "message", id, parentId, timestamp: new Date().toISOString(), message };
	return { entry, children: [] };
}

/** The session tree's row for one bash call, stripped of colour. */
function bashPreview(command: string): string {
	const callId = `call-${nodeCounter++}`;
	const root = messageNode({ role: "user", content: "run it", timestamp: 1 }, null);
	const assistant = messageNode(
		{
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command } }],
			api: "openai",
			provider: "openai",
			model: "test-model",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 2,
		},
		root.entry.id,
	);
	const result = messageNode(
		{
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
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
		assistant.entry.id,
		() => {},
		() => {},
	);
	const rendered = Bun.stripANSI(selector.render(400).join("\n"));
	const row = rendered.split("\n").find(line => line.includes("[bash: ")) ?? "";
	const start = row.indexOf("[bash: ") + "[bash: ".length;
	return row.slice(start, row.lastIndexOf("]"));
}

beforeAll(async () => {
	await initTheme(false);
});

describe("an elision is one character", () => {
	// The empty-row arm below compares painted bytes, which `theme.fg` returns
	// unchanged unless the policy is full.
	useFullColor();

	/**
	 * The scan reads four real trees and reaches, in two of them, a file this
	 * change edited. A walk that found nothing — a moved directory, a renamed
	 * package — would satisfy the rule below while checking nothing, which is how
	 * a source sweep dies quietly.
	 */
	it("reads every tree that draws rows", () => {
		const [agent = [], tui = [], utils = [], toolRender = []] = ROOTS.map(root => sources(root.dir));

		expect(agent.length).toBeGreaterThan(1200);
		expect(tui.length).toBeGreaterThan(30);
		expect(utils.length).toBeGreaterThan(60);
		expect(toolRender.length).toBeGreaterThan(3);
		expect(agent.some(file => file.endsWith(path.join("components", "tree-selector.ts")))).toBe(true);
		expect(tui.some(file => file.endsWith(path.join("components", "loader.ts")))).toBe(true);
		expect(sweep().size).toBeGreaterThan(10);
	});

	/**
	 * The rule. A failure names the file and the exact string; the fix is one `…`
	 * on a row, and a named exemption with a reason on anything that is not one.
	 */
	it("spells every elision with one character", () => {
		expect(
			offenders(),
			"this string marks an elision with three ASCII periods. A displayed row gets one `…`, cut in cells; anything else gets a named exemption",
		).toEqual([]);
	});

	/**
	 * The other direction, string by string. An exemption whose string has been
	 * reworded or deleted would silently excuse whatever appears in its place, and
	 * the files that also draw real rows are exactly where that would land.
	 */
	it("keeps every exemption earning its place", () => {
		const hits = sweep();
		const stale: string[] = [];
		for (const [file, { strings }] of Object.entries(EXEMPT)) {
			const found = hits.get(file) ?? [];
			for (const body of strings) if (!found.includes(body)) stale.push(`${file}: ${JSON.stringify(body)}`);
		}
		expect(stale, "this exemption no longer matches any string in its file — delete it or update it").toEqual([]);
		expect(Object.keys(EXEMPT).length).toBe(19);
		expect(Object.values(EXEMPT).reduce((total, entry) => total + entry.strings.length, 0)).toBe(37);
	});

	/**
	 * The classifier, on the shapes it has to tell apart. `<task...>` is in the
	 * TRUE column on purpose: usage grammar reads exactly like a row, so the
	 * table above carries it by name rather than a filter guessing at it.
	 */
	it("tells a mark apart from the syntax that looks like one", () => {
		const cases: ReadonlyArray<{ body: string; marks: boolean }> = [
			{ body: "Loading...", marks: true },
			{ body: "Loading…", marks: false },
			{ body: "Rewriting the plan... (40 lines of code)", marks: true },
			{ body: "<task...>", marks: true },
			{ body: `${HOLE}...${HOLE}`, marks: true },
			{ body: "[...items]", marks: false },
			{ body: "Extract<...>", marks: false },
			{ body: "satisfies Record<..., true>", marks: false },
			{ body: "providedContextFiles ? ... : ...", marks: false },
			{ body: `.${HOLE}.${HOLE}.tmp`, marks: false },
			{ body: "....tmp", marks: false },
			{ body: ".../cli/completion-refresh.ts", marks: false },
			{ body: "./...", marks: false },
			{ body: "__typename\n\t\t... on FileMatch {", marks: false },
			{ body: "no periods here", marks: false },
		];
		const wrong = cases.filter(one => marksAnElision(one.body) !== one.marks).map(one => one.body);
		expect(wrong).toEqual([]);
	});

	/**
	 * The scanner, on the two things a line-oriented scan gets wrong: a doc
	 * comment describing the defect, and a `//` that is part of a URL.
	 */
	it("reads literals rather than lines", () => {
		const source = [
			'// a comment saying "Loading..."',
			"/** and a fence marker `...` */",
			'const u = "http://x/y";',
		].join("\n");
		expect(scanSource(source).literals.map(one => one.body)).toEqual(["http://x/y"]);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${x} is source text the scanner reads, not an interpolation here
		const template = scanSource('const s = "a" + `b${x}c`;');
		expect(template.literals.map(one => one.body)).toEqual(["a", `b${HOLE}c`]);
		expect(template.literals.map(one => one.holes)).toEqual([[], ["x"]]);
		expect(scanSource('const re = /["\']/; const s = "kept...";').literals.map(one => one.body)).toEqual(["kept..."]);
	});

	/**
	 * The command-description owner. Three loaders kept 60 code units and then
	 * appended three periods; the cut is in cells and the mark is inside the
	 * budget, so a description of wide glyphs occupies the same 60 columns as one
	 * of ASCII rather than twice as many.
	 */
	it("cuts a command description to the columns a palette row gives it", () => {
		const ascii = descriptionFromBody(`${"long instruction ".repeat(20)}\nsecond line`);
		expect(visibleWidth(ascii)).toBeLessThanOrEqual(60);
		expect(visibleWidth(ascii)).toBeGreaterThan(50);
		expect(ascii.endsWith("…")).toBe(true);
		expect(ascii).not.toContain("...");

		const wide = descriptionFromBody("日本語のテスト文字列".repeat(10));
		expect(visibleWidth(wide)).toBeLessThanOrEqual(60);
		expect(visibleWidth(wide)).toBeGreaterThan(50);
		expect(wide.endsWith("…")).toBe(true);

		expect(descriptionFromBody("short one")).toBe("short one");
		expect(descriptionFromBody("\n\n   \nfirst real line\nsecond")).toBe("first real line");
		expect(descriptionFromBody("")).toBe("");
		expect(descriptionFromBody("\n\n   \n")).toBe("");
	});

	/**
	 * The recogniser side of the boundary. A gap row reaches the renderer in
	 * three spellings — blank from the current writer, `...` from an older
	 * transcript, `…` from a re-render — and all three display as one mark.
	 */
	it("shows every spelling of a diff gap as one mark", () => {
		const rendered = ["", "...", "…"].map(gap => Bun.stripANSI(renderDiff([" 1|first", gap, " 9|last"].join("\n"))));

		expect(new Set(rendered).size).toBe(1);
		expect(rendered[0]).toContain("…");
		expect(rendered[0]).not.toContain("...");
	});

	/**
	 * A renderer handed a theme gets the closed class's voice, not a choice of
	 * weight: the autoresearch dashboard's empty state is byte-identical to the
	 * row every filtering card draws.
	 */
	it("gives a dashboard the same empty row as a card", () => {
		// Both sides of an equality against `emptyRow` move together when the owner
		// changes weight, so the weight is stated here too: two spaces of indent and
		// `muted`, which is what a fact about a list is painted in.
		const expected = theme.fg("muted", "  No experiments logged yet.");

		expect(renderDashboardLines(idleRuntime(), 80, theme, 8)).toEqual([expected]);
		expect(emptyRowIn(theme, "No experiments logged yet.")).toBe(expected);
		expect(emptyRow("No experiments logged yet.")).toBe(expected);
	});

	/**
	 * The session tree's bash row. The old cut kept 50 code units and hand-marked
	 * the cut, so a command of wide glyphs drew a hundred columns into a card that
	 * had fifty, and the mark disagreed with the `[edit: …]` row above it.
	 */
	it("cuts a bash preview in columns", () => {
		const ascii = bashPreview(`echo ${"very-long-argument ".repeat(10)}`);
		expect(visibleWidth(ascii)).toBeLessThanOrEqual(50);
		expect(visibleWidth(ascii)).toBeGreaterThan(40);
		expect(ascii.endsWith("…")).toBe(true);
		expect(ascii).not.toContain("...");

		const wide = bashPreview("日本語のテスト文字列".repeat(10));
		expect(visibleWidth(wide)).toBeLessThanOrEqual(50);
		expect(wide.endsWith("…")).toBe(true);

		expect(bashPreview("echo one\necho two")).toBe("echo one echo two");
	});
});
