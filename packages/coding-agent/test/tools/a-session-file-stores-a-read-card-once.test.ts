/**
 * WHY THIS SUITE EXISTS:
 *
 * A read result held the file twice: the numbered rows the model reads in `content`, and the same
 * rows without their numbers in `details.displayContent.text` for the card. Every session file wrote
 * both. The read codec drops the card text from the written line when the result's own text rebuilds
 * it, restores it on load, and settles a result the session records into the same rebuilt form.
 *
 * CLASS: for every display shape the read tool produces (a hashline window, a range, line-number
 * mode, plain mode, a raw selector, a structural summary, a multi-range read, a read cut at its
 * limit, and a multi-range read and a structural summary in plain mode, so that each rebuild covers
 * a card numbered by a stored list) the session writes the card text at most once, holds the
 * details it recorded and loads the details it wrote byte-for-byte as the tool returned them, and
 * the card drawn from the written, recorded or loaded form matches the card drawn from the tool's
 * own result. A result whose content no longer rebuilds the card after it was recorded (a prune,
 * other rows, renumbered rows, a shorter copy) keeps its card text on disk, and so does a card text
 * shorter than the tag that would replace it. A line written before the codec existed loads
 * unchanged. Every result codec the package ships has a suite: the sweep fails when one is added
 * until it has one. The edit codec's is `a-session-file-stores-an-edit-snapshot-once`, the search
 * codec's `a-session-file-stores-a-search-card-once`, the eval codec's
 * `a-session-file-stores-an-eval-cell-output-once` and the job codec's
 * `a-session-file-stores-a-job-result-once`. A tool's results are stored by one codec: registering
 * the shipped set again is a no-op, and a second codec for a tool that has one is refused. The
 * memory a read card holds once it is recorded or loaded is bounded by
 * `a-read-holds-no-card-text-until-it-is-drawn`.
 *
 * DOES NOT CATCH: a display shape the read tool starts producing that no row below exercises, which
 * still round-trips exactly (the codec writes whole what it cannot rebuild) but may stop saving
 * space unnoticed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { getThemeByName, initTheme, type Theme } from "@veyyon/coding-agent/theme/theme";
import { ReadTool, type ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";
import type { ReadDisplayContent } from "@veyyon/coding-agent/tools/fs/read-display";
import { readToolView } from "@veyyon/coding-agent/tools/fs/read-view";
import { BUILTIN_RESULT_CODECS } from "@veyyon/coding-agent/tools/index";
import type { ToolResultCodec } from "@veyyon/kernel/registry/tool-result-codec";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { registerToolResultCodecs } from "@veyyon/kernel/session/tool-result-codecs";
import { setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";
import { makeToolSession } from "../helpers/tool-session";

const FIXTURE = `${[
	"export function alpha(value: string): string {",
	"\tconst clean = value.trim();",
	"\tconst label = clean || 'alpha';",
	"\treturn label.toUpperCase();",
	"}",
	"",
	"export const answer = 42;",
	"",
	"export function beta(): number {",
	"\tconst one = 1;",
	"\tconst two = 2;",
	"\treturn one + two;",
	"}",
	"",
	"export const gamma = 'gamma';",
].join("\n")}\n`;

/** Pins the outermost-only collector so the summary elides the two function bodies. */
const SUMMARY_SETTINGS = {
	"read.summarize.enabled": true,
	"read.summarize.minTotalLines": 0,
	"read.summarize.unfoldUntil": 0,
	"read.summarize.unfoldLimit": 0,
};

interface Shape {
	name: string;
	selector: string;
	settings: Record<string, unknown>;
	hasEditTool: boolean;
	/** The rebuild the written line names, which is what proves the text was not written. */
	from: NonNullable<ReadDisplayContent["from"]>;
}

const SHAPES: Shape[] = [
	{ name: "hashline window", selector: "", settings: {}, hasEditTool: true, from: "rows" },
	{ name: "hashline range", selector: ":3-6", settings: {}, hasEditTool: true, from: "rows" },
	{ name: "multi-range", selector: ":1-2,9-10", settings: {}, hasEditTool: true, from: "rows" },
	{ name: "cut at its limit", selector: "", settings: { "read.defaultLimit": 4 }, hasEditTool: true, from: "rows" },
	{ name: "structural summary", selector: "", settings: SUMMARY_SETTINGS, hasEditTool: true, from: "rows" },
	{ name: "line-number mode", selector: "", settings: { readLineNumbers: true }, hasEditTool: false, from: "rows" },
	{ name: "plain mode", selector: "", settings: {}, hasEditTool: false, from: "prefix" },
	{ name: "raw selector", selector: ":raw", settings: {}, hasEditTool: true, from: "prefix" },
	{ name: "plain multi-range", selector: ":1-2,9-10", settings: {}, hasEditTool: false, from: "prefix" },
	{ name: "plain structural summary", selector: "", settings: SUMMARY_SETTINGS, hasEditTool: false, from: "prefix" },
];

function assistantCalling(ids: readonly string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map(id => ({ type: "toolCall", id, name: "read", arguments: { path: "fixture.ts" } })),
		timestamp: 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		stopReason: "toolUse",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** The details of every read result in `lines`, keyed by tool call id, as JSON parsed them. */
function writtenDetails(file: string): Map<string, ReadToolDetails> {
	const out = new Map<string, ReadToolDetails>();
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"toolResult"')) continue;
		const entry = JSON.parse(line) as { message: ToolResultMessage<ReadToolDetails> };
		if (entry.message.details) out.set(entry.message.toolCallId, entry.message.details);
	}
	return out;
}

function loadedResults(manager: SessionManager): Map<string, ToolResultMessage<ReadToolDetails>> {
	const out = new Map<string, ToolResultMessage<ReadToolDetails>>();
	for (const entry of manager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			out.set(entry.message.toolCallId, entry.message as ToolResultMessage<ReadToolDetails>);
		}
	}
	return out;
}

describe("a session file stores a read card once", () => {
	let theme: Theme;
	let dirOverrides: DirOverridesSnapshot | undefined;
	let root: TempDir;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("dark theme missing");
		theme = dark;
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(() => {
		dirOverrides = captureDirOverrides();
		root = TempDir.createSync("@pi-read-card-once-");
		setAgentDir(root.join("agent"));
		fs.writeFileSync(root.join("fixture.ts"), FIXTURE);
	});

	afterEach(async () => {
		if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await root.remove();
	});

	async function readShape(shape: Shape, id: string): Promise<ToolResultMessage<ReadToolDetails>> {
		const session = makeToolSession({
			cwd: root.path(),
			hasEditTool: shape.hasEditTool,
			getSessionFile: () => root.join("tool-session.jsonl"),
			getArtifactsDir: () => root.join("artifacts"),
			settings: Settings.isolated(shape.settings),
		});
		const result = await new ReadTool(session).execute(id, { path: `${root.join("fixture.ts")}${shape.selector}` });
		const details = result.details as ReadToolDetails | undefined;
		if (details?.displayContent?.text === undefined) throw new Error(`${shape.name}: the read reported no card text`);
		return {
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: result.content,
			details,
			isError: false,
			timestamp: 2,
		};
	}

	/** Record `results` after one assistant turn that called them, and return the flushed manager. */
	async function record(results: readonly ToolResultMessage<ReadToolDetails>[]): Promise<SessionManager> {
		const manager = SessionManager.create(root.path(), root.join("sessions"));
		manager.appendMessage(assistantCalling(results.map(result => result.toolCallId)));
		for (const result of results) manager.appendMessage(result);
		await manager.flush();
		return manager;
	}

	function draw(result: ToolResultMessage<ReadToolDetails>, details: ReadToolDetails): string {
		const view = readToolView.renderResult(
			{ content: result.content, details },
			{ expanded: true, partial: false },
			{ path: "fixture.ts" },
		);
		return Bun.stripANSI(drawToolView(view, theme).render(160).join("\n"));
	}

	it("is one of the five codecs the package ships, each with a suite, so a new one fails here until it has one", () => {
		expect(BUILTIN_RESULT_CODECS.map(codec => codec.toolName)).toEqual(["read", "search", "eval", "job", "edit"]);
	});

	it("stores each tool's results by one codec, refusing a second codec for a tool that has one", () => {
		registerToolResultCodecs(BUILTIN_RESULT_CODECS);
		for (const codec of BUILTIN_RESULT_CODECS) {
			const rival: ToolResultCodec = { toolName: codec.toolName, slim: details => details, restore() {} };
			expect(() => registerToolResultCodecs([rival])).toThrow(`tool "${codec.toolName}" already has a result codec`);
		}
	});

	it("writes no card text for any shape a rebuild reproduces, and loads every result as the tool returned it", async () => {
		const results = await Promise.all(SHAPES.map((shape, index) => readShape(shape, `call-${index}`)));
		// The shapes cover a card numbered by a stored list under each rebuild, so dropping or misplacing
		// the list is seen for both.
		const numberedUnder = new Set(
			SHAPES.filter((_, index) => results[index].details?.displayContent?.lineNumbers !== undefined).map(
				shape => shape.from,
			),
		);
		expect([...numberedUnder].sort()).toEqual(["prefix", "rows"]);
		const manager = await record(results);
		const file = manager.getSessionFile() as string;
		const written = writtenDetails(file);

		const reopened = loadedResults(await SessionManager.open(file));
		for (const [index, shape] of SHAPES.entries()) {
			const result = results[index];
			const id = result.toolCallId;
			const onDisk = written.get(id)?.displayContent;
			expect({ shape: shape.name, text: onDisk?.text, from: onDisk?.from }).toEqual({
				shape: shape.name,
				text: undefined,
				from: shape.from,
			});
			// Byte-for-byte after the round trip the tool result took: JSON, then the load.
			expect({ shape: shape.name, details: reopened.get(id)?.details }).toEqual({
				shape: shape.name,
				details: JSON.parse(JSON.stringify(result.details)),
			});
			// A host that reads the written line without the restore draws the same card.
			const slim = written.get(id) as ReadToolDetails;
			expect({ shape: shape.name, card: draw(result, slim) }).toEqual({
				shape: shape.name,
				card: draw(result, result.details as ReadToolDetails),
			});
		}
	});

	it("reads back in memory the card the tool returned for every shape, after it writes the slim line", async () => {
		const results = await Promise.all(SHAPES.map((shape, index) => readShape(shape, `memory-${index}`)));
		// Recording settles each result's details in place, so what the tool returned is copied first.
		const returned = results.map(result => JSON.parse(JSON.stringify(result.details)) as ReadToolDetails);
		const cards = results.map((result, index) => draw(result, returned[index]));
		const recorded = loadedResults(await record(results));
		for (const [index, shape] of SHAPES.entries()) {
			const held = recorded.get(`memory-${index}`);
			if (held?.details === undefined) throw new Error(`${shape.name}: recorded result missing`);
			expect({ shape: shape.name, details: JSON.parse(JSON.stringify(held.details)) }).toEqual({
				shape: shape.name,
				details: returned[index],
			});
			expect({ shape: shape.name, card: draw(held, held.details) }).toEqual({
				shape: shape.name,
				card: cards[index],
			});
		}
	});

	/**
	 * What a result's content becomes after it is recorded: a prune's notice, rows of another read, the
	 * same rows under other numbers, and a shorter copy of plain text. Each one leaves a rebuild that no
	 * longer reproduces the card, so the text is written whole.
	 */
	const REPLACEMENTS: Array<{ name: string; shape: number; replace: (text: string) => string }> = [
		{ name: "a prune notice", shape: 0, replace: () => "[Output truncated - 120 tokens]" },
		{
			name: "rows of another file",
			shape: 0,
			replace: () => "[other.ts#0000]\n1:export const other = 'a different file entirely';",
		},
		{
			name: "the same rows renumbered",
			shape: 0,
			replace: text =>
				text.replace(/^(\d+)([:|])/gm, (_, line: string, sep: string) => `${Number(line) + 100}${sep}`),
		},
		{ name: "a shorter copy of plain text", shape: 6, replace: text => text.slice(0, text.length / 2) },
	];

	it("writes the card text whole once the result's content no longer rebuilds it", async () => {
		const results = await Promise.all(
			REPLACEMENTS.map((row, index) => readShape(SHAPES[row.shape], `swap-${index}`)),
		);
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
			const expected = JSON.parse(JSON.stringify(results[index].details?.displayContent));
			expect({ row: row.name, written: written.get(id)?.displayContent }).toEqual({
				row: row.name,
				written: expected,
			});
			expect({ row: row.name, loaded: reopened.get(id)?.details?.displayContent }).toEqual({
				row: row.name,
				loaded: expected,
			});
		}
	});

	it("writes a card text shorter than the tag that would replace it as is", async () => {
		fs.writeFileSync(root.join("fixture.ts"), "x\n");
		const result = await readShape(SHAPES[0], "call-short");
		const manager = await record([result]);
		const onDisk = writtenDetails(manager.getSessionFile() as string).get("call-short")?.displayContent;
		expect(onDisk).toEqual(JSON.parse(JSON.stringify(result.details?.displayContent)));
	});

	it("loads a line written before the codec existed unchanged", async () => {
		const result = await readShape(SHAPES[0], "call-stale");
		const manager = await record([]);
		const file = manager.getSessionFile() as string;
		// The shape every session holds from before the codec: card text written beside the content.
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
		const result = await readShape(SHAPES[0], "call-future");
		const future = {
			...result.details,
			displayContent: { startLine: 1, from: "future" },
		} as unknown as ReadToolDetails;
		const noDisplay = { ...result.details, displayContent: undefined } as ReadToolDetails;
		expect(draw(result, future)).toEqual(draw(result, noDisplay));
	});
});
