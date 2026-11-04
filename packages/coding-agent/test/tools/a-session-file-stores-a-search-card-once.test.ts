/**
 * WHY THIS SUITE EXISTS:
 *
 * A text or structure search result held its matches twice: the numbered rows the model reads in
 * `content`, and the same rows in the card's gutter in `details.result.displayContent`. A paths-only
 * search held its text twice verbatim, `files` restated the paths `fileMatches` lists, and the
 * wrapper's `meta` was the sub-search's `meta` a second time. The search codec drops each from the
 * written line when the rest of the line rebuilds it, and restores it on load.
 *
 * CLASS: for every card shape the search tool produces (grouped rows under hashline headers, grouped
 * plain rows, one file under its snapshot header, rows with context and elisions, matching paths
 * only, a structure search over a directory and over one file) the session writes the card text at
 * most once and loads the details as the tool returned them, and the card drawn from the written
 * form matches the card drawn from the tool's own result. A result whose content no longer rebuilds
 * the card (a prune, a compact page that sent the full rows to an artifact) keeps its card text on
 * disk, a path list shorter than the tag that would replace it is written as is, and a line written
 * before the codec existed loads unchanged.
 *
 * DOES NOT CATCH: a card shape the search tool starts producing that no row below exercises, which
 * still round-trips exactly (the codec writes whole what it cannot rebuild) but may stop saving
 * space unnoticed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { initTheme, type Theme } from "@veyyon/coding-agent/theme/theme";
// The composition root every host loads before it opens a session, which registers the result codecs.
import "@veyyon/coding-agent/tools/index";
import { emptyUsage } from "@veyyon/catalog/models";
import { SearchTool, type SearchToolDetails, type SearchToolInput } from "@veyyon/coding-agent/tools/search/search";
import type { SearchDisplayFrom } from "@veyyon/coding-agent/tools/search/search-result-codec";
import { searchToolView } from "@veyyon/coding-agent/tools/search/search-view";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";
import { requireTheme } from "../helpers/require-theme";
import { makeToolSession } from "../helpers/tool-session";

/** Each file's matches sit on non-adjacent lines, and one past line 9, so rows elide and pad. */
const FIXTURES: Record<string, string> = {
	"src/components/alpha-widget-panel.ts": [
		'export const alpha = "needle one";',
		"const filler1 = 1;",
		"const filler2 = 2;",
		"const filler3 = 3;",
		'export function alphaNeedle() { console.log("needle two"); }',
		"const filler5 = 5;",
		"const filler6 = 6;",
		"const filler7 = 7;",
		"const filler8 = 8;",
		"const filler9 = 9;",
		"const filler10 = 10;",
		'console.log("needle three");',
	].join("\n"),
	"src/components/beta-widget-panel.ts": [
		"const filler0 = 0;",
		"const filler1 = 1;",
		'console.log("needle four");',
		"const filler3 = 3;",
	].join("\n"),
	"src/services/gamma-service-client.ts": ['export const gamma = "needle five";', "const filler = 0;"].join("\n"),
	// Matches well past the rows a card draws, so the tool keeps only the rows the card can show.
	...Object.fromEntries(
		Array.from({ length: 8 }, (_, file) => [
			`broad/module-${file}.ts`,
			Array.from({ length: 16 }, (_, line) =>
				line % 2 === 0 ? `const needle${line} = ${line};` : `const filler${line} = ${line};`,
			).join("\n"),
		]),
	),
};

/** One file's path, long enough that its one-entry path list is worth a tag. */
const ONE_FILE = "src/components/alpha-widget-panel.ts";

const CONTEXT_SETTINGS = { "search.contextBefore": 1, "search.contextAfter": 1 };

interface Shape {
	name: string;
	input: SearchToolInput;
	settings: Record<string, unknown>;
	hasEditTool: boolean;
	/** The rebuild the written line names, which is what proves the card text was not written. */
	from: SearchDisplayFrom;
}

const SHAPES: Shape[] = [
	{
		name: "grouped rows under hashline headers",
		input: { type: "text", input: "needle", path: "src" },
		settings: {},
		hasEditTool: true,
		from: "rows",
	},
	{
		name: "grouped plain rows",
		input: { type: "text", input: "needle", path: "src" },
		settings: {},
		hasEditTool: false,
		from: "rows",
	},
	{
		name: "one file under its snapshot header",
		input: { type: "text", input: "needle", path: ONE_FILE },
		settings: {},
		hasEditTool: true,
		from: "rows",
	},
	{
		name: "rows with context and elisions",
		input: { type: "text", input: "needle", path: "src" },
		settings: CONTEXT_SETTINGS,
		hasEditTool: true,
		from: "rows",
	},
	{
		name: "matching paths only",
		input: { type: "text", input: "needle", path: "src", paths: true },
		settings: {},
		hasEditTool: true,
		from: "text",
	},
	{
		name: "a structure search over a directory",
		input: { type: "structure", input: "console.log($A)", path: "src" },
		settings: {},
		hasEditTool: true,
		from: "rows",
	},
	{
		name: "a structure search of one file",
		input: { type: "structure", input: "console.log($A)", path: ONE_FILE },
		settings: {},
		hasEditTool: false,
		from: "rows",
	},
	{
		name: "rows past what a card draws",
		input: { type: "text", input: "needle", path: "broad" },
		settings: CONTEXT_SETTINGS,
		hasEditTool: true,
		from: "rowsPrefix",
	},
];

type SearchResult = ToolResultMessage<SearchToolDetails>;

/** The sub-search details as the codec reads and writes them, tags included. */
type WrittenResult = Record<string, unknown> & { displayContent?: string; files?: unknown };

function assistantCalling(ids: readonly string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map(id => ({ type: "toolCall", id, name: "search", arguments: {} })),
		timestamp: 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		stopReason: "toolUse",
		usage: { ...emptyUsage(), input: 1, output: 1, totalTokens: 2 },
	};
}

/** The details of every search result in `file`, keyed by tool call id, as JSON parsed them. */
function writtenDetails(file: string): Map<string, Record<string, unknown> & { result: WrittenResult }> {
	const out = new Map<string, Record<string, unknown> & { result: WrittenResult }>();
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"toolResult"')) continue;
		const entry = JSON.parse(line) as {
			message: ToolResultMessage<Record<string, unknown> & { result: WrittenResult }>;
		};
		if (entry.message.details) out.set(entry.message.toolCallId, entry.message.details);
	}
	return out;
}

function loadedResults(manager: SessionManager): Map<string, SearchResult> {
	const out = new Map<string, SearchResult>();
	for (const entry of manager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			out.set(entry.message.toolCallId, entry.message as SearchResult);
		}
	}
	return out;
}

describe("a session file stores a search card once", () => {
	let theme: Theme;
	let dirOverrides: DirOverridesSnapshot | undefined;
	let root: TempDir;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const dark = await requireTheme("dark");
		theme = dark;
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(() => {
		dirOverrides = captureDirOverrides();
		root = TempDir.createSync("@pi-search-card-once-");
		setAgentDir(root.join("agent"));
		for (const [relative, text] of Object.entries(FIXTURES)) {
			fs.mkdirSync(root.join(relative, ".."), { recursive: true });
			fs.writeFileSync(root.join(relative), `${text}\n`);
		}
	});

	afterEach(async () => {
		if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await root.remove();
	});

	async function search(shape: Shape, id: string): Promise<SearchResult> {
		const session = makeToolSession({
			cwd: root.path(),
			hasEditTool: shape.hasEditTool,
			getSessionFile: () => root.join("tool-session.jsonl"),
			// A compact page only replaces the rows once the full output has an artifact to go to.
			allocateOutputArtifact: async (toolType: string) => ({
				id: `${toolType}-${id}`,
				path: root.join(`${toolType}-${id}.log`),
			}),
			settings: Settings.isolated(shape.settings),
		});
		const result = await new SearchTool(session).execute(id, shape.input);
		const details = result.details;
		if (typeof details?.result !== "object" || !("displayContent" in details.result)) {
			throw new Error(`${shape.name}: the search reported no card text`);
		}
		return {
			role: "toolResult",
			toolCallId: id,
			toolName: "search",
			content: result.content,
			details,
			isError: false,
			timestamp: 2,
		};
	}

	/** Record `results` after one assistant turn that called them, and return the flushed manager. */
	async function record(results: readonly SearchResult[]): Promise<SessionManager> {
		const manager = SessionManager.create(root.path(), root.join("sessions"));
		manager.appendMessage(assistantCalling(results.map(result => result.toolCallId)));
		for (const result of results) manager.appendMessage(result);
		await manager.flush();
		return manager;
	}

	function draw(result: SearchResult, details: unknown, args: SearchToolInput): string {
		const view = searchToolView.renderResult(
			{ content: result.content, details: details as SearchToolDetails },
			{ expanded: true, partial: false },
			args,
		);
		return Bun.stripANSI(drawToolView(view, theme).render(160).join("\n"));
	}

	it("writes no card text or path list for any shape a rebuild reproduces, and loads every result as the tool returned it", async () => {
		const results = await Promise.all(SHAPES.map((shape, index) => search(shape, `call-${index}`)));
		const manager = await record(results);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const reopened = loadedResults(await SessionManager.open(file));
		for (const [index, shape] of SHAPES.entries()) {
			const result = results[index];
			const id = result.toolCallId;
			const onDisk = written.get(id)?.result;
			expect({
				shape: shape.name,
				text: onDisk?.displayContent,
				from: onDisk?.displayContentFrom,
				files: onDisk?.files,
				filesFrom: onDisk?.filesFrom,
			}).toEqual({
				shape: shape.name,
				text: undefined,
				from: shape.from,
				files: undefined,
				filesFrom: "fileMatches",
			});
			expect({ shape: shape.name, details: reopened.get(id)?.details }).toEqual({
				shape: shape.name,
				details: JSON.parse(JSON.stringify(result.details)),
			});
			// A host that reads the written line without the restore draws the same card.
			expect({ shape: shape.name, card: draw(result, written.get(id), shape.input) }).toEqual({
				shape: shape.name,
				card: draw(result, result.details, shape.input),
			});
		}
	});

	it("leaves the result in memory whole when it writes the slim line", async () => {
		const result = await search(SHAPES[0], "call-memory");
		const text = (result.details?.result as WrittenResult | undefined)?.displayContent;
		const manager = await record([result]);
		const loaded = loadedResults(manager).get("call-memory")?.details?.result as WrittenResult | undefined;
		expect(loaded?.displayContent).toBe(text);
	});

	it("writes the full rows of a search its compact page sent to an artifact, and the wrapper meta once", async () => {
		// Enough matching lines across enough files that the rows outgrow the inline budget.
		const row = `export const value = "needle ${"x".repeat(40)}";`;
		fs.mkdirSync(root.join("wide"));
		for (let index = 0; index < 30; index++) {
			fs.writeFileSync(
				root.join(`wide/module-${index}.ts`),
				`${Array.from({ length: 12 }, () => row).join("\n")}\n`,
			);
		}
		const input: SearchToolInput = { type: "text", input: "needle", path: "wide" };
		const result = await search(
			{ name: "compact page", input, settings: {}, hasEditTool: true, from: "rows" },
			"call-wide",
		);
		const manager = await record([result]);
		const file = manager.getSessionFile() as string;
		const onDisk = writtenDetails(file).get("call-wide");
		const original = JSON.parse(JSON.stringify(result.details));

		expect(original.result.truncation?.truncated).toBe(true);
		expect(onDisk?.result.displayContent).toBe(original.result.displayContent);
		expect({ meta: onDisk?.meta, metaFrom: onDisk?.metaFrom }).toEqual({ meta: undefined, metaFrom: "result" });
		expect(loadedResults(await SessionManager.open(file)).get("call-wide")?.details).toEqual(original);
	});

	/**
	 * What a result's content becomes after it is recorded: a prune's notice, rows of another search,
	 * and the same rows under other numbers. Each leaves a rebuild that no longer reproduces the card,
	 * so the text is written whole.
	 */
	const REPLACEMENTS: Array<{ name: string; shape: number; replace: (text: string) => string }> = [
		{ name: "a prune notice", shape: 0, replace: () => "[Output truncated - 120 tokens]" },
		{
			name: "rows of another search",
			shape: 1,
			replace: () => "# other/\n## file.ts\n*1:const other = 'a different match';",
		},
		{
			name: "the same rows renumbered",
			shape: 1,
			replace: text =>
				text.replace(
					/^([* ])(\d+)([:|])/gm,
					(_, mark: string, line: string, sep: string) => `${mark}${Number(line) + 100}${sep}`,
				),
		},
		{ name: "a paths list cut short", shape: 4, replace: text => text.slice(0, text.length / 2) },
		{
			name: "a prune notice over rows past what a card draws",
			shape: 7,
			replace: () => "[Output truncated - 120 tokens]",
		},
	];

	it("writes the card text whole once the result's content no longer rebuilds it", async () => {
		const results = await Promise.all(REPLACEMENTS.map((row, index) => search(SHAPES[row.shape], `swap-${index}`)));
		const manager = await record(results);
		const recorded = loadedResults(manager);
		for (const [index, row] of REPLACEMENTS.entries()) {
			const entry = recorded.get(`swap-${index}`);
			const block = entry?.content[0];
			if (!entry || block?.type !== "text") throw new Error(`${row.name}: recorded result missing`);
			entry.content = [{ type: "text", text: row.replace(block.text) }];
		}
		await manager.rewriteEntries();

		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);
		const reopened = loadedResults(await SessionManager.open(file));
		for (const [index, row] of REPLACEMENTS.entries()) {
			const id = `swap-${index}`;
			const expected = JSON.parse(JSON.stringify(results[index].details)).result.displayContent;
			expect({ row: row.name, written: written.get(id)?.result.displayContent }).toEqual({
				row: row.name,
				written: expected,
			});
			const loaded = reopened.get(id)?.details?.result as WrittenResult | undefined;
			expect({ row: row.name, loaded: loaded?.displayContent }).toEqual({ row: row.name, loaded: expected });
		}
	});

	it("writes a path list shorter than the tag that would replace it as is", async () => {
		fs.writeFileSync(root.join("a.ts"), 'const x = "needle";\n');
		const input: SearchToolInput = { type: "text", input: "needle", path: "a.ts" };
		const result = await search(
			{ name: "short path", input, settings: {}, hasEditTool: true, from: "rows" },
			"call-short",
		);
		const manager = await record([result]);
		const onDisk = writtenDetails(manager.getSessionFile() as string).get("call-short")?.result;
		expect({ files: onDisk?.files, filesFrom: onDisk?.filesFrom }).toEqual({ files: ["a.ts"], filesFrom: undefined });
	});

	it("loads a line written before the codec existed unchanged", async () => {
		const result = await search(SHAPES[0], "call-stale");
		const manager = await record([]);
		const file = manager.getSessionFile() as string;
		// The shape every session holds from before the codec: card text and paths beside the content.
		const staleLine = JSON.stringify({
			type: "message",
			id: "stale-entry",
			parentId: manager.getLeafId(),
			timestamp: new Date(0).toISOString(),
			message: result,
		});
		fs.appendFileSync(file, `${staleLine}\n`);

		const reopened = loadedResults(await SessionManager.open(file)).get("call-stale");
		expect(reopened?.details).toEqual(JSON.parse(JSON.stringify(result.details)));
	});

	it("draws the result's own text for a rebuild tag this version does not know", async () => {
		const result = await search(SHAPES[1], "call-future");
		const details = result.details as SearchToolDetails;
		const { displayContent: _dropped, ...rest } = details.result as WrittenResult;
		const future = { ...details, result: { ...rest, displayContentFrom: "future" } };
		const noDisplay = { ...details, result: rest };
		expect(draw(result, future, SHAPES[1].input)).toEqual(draw(result, noDisplay, SHAPES[1].input));
	});
});
