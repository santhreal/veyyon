/**
 * WHY. The `/tree` card painted a fixed twenty-plus-row box whatever the session
 * held, so a nine-entry tree sat above eleven blank rows and read as a list that
 * failed to load the rest. Three more defects rode along in the same rows: the
 * active-path bullet existed only on active rows and shoved their text two cells
 * right of their own siblings, so the content column was ragged; nothing
 * distinguished the CURRENT LEAF from the rest of the path, which is the one
 * position a navigator exists to show; and the filter mode was named on a body
 * row at the far end of the card, only while it was NOT `default`, so the one
 * view that hides entries without saying so was the view that said nothing.
 *
 * Two more lived in the row's text. The kind was spelled into it (`user: `,
 * `[bash]: `, `[read: path]`), so the entry text of each row started wherever
 * the previous word's length left it and no two rows could be compared down the
 * card. And six entry types the row builder had no case for — a mode change, a
 * title change, a tier change, a session header, an injected-rules record and an
 * MCP selection — passed the DEFAULT filter and painted a row with nothing on
 * it, selectable and jumpable, saying neither what it was nor that it existed.
 *
 * THE CLASS THIS CLOSES. A row column whose width depends on the row's state
 * (leaf, on-path, off-path) or on its content, a card height that ignores its
 * content, a narrowing control whose effect is not named on screen, and an entry
 * a row cannot describe. The filter sweep is driven from the `treeFilterMode`
 * setting's declared values at run time, so a sixth mode added to the setting
 * turns this suite red until it is reachable from `ctrl+O` and named in the
 * header. The blank-row assertion goes through the row builder's fallback with
 * an entry type that is in no union, so an entry kind a package merges in later
 * is covered by the same invariant rather than by a list that would go stale.
 *
 * WHAT IT DOES NOT CATCH. Colour: the rail tints accent on the active path and
 * dim off it, the kind column carries a tone per kind, and the assertions here
 * read glyphs and columns, not SGR. It also says nothing about the rail's own
 * shape under `├─`/`└─`, which is pinned by the #2298 and #2325 suites, nor
 * about who mounts the card.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import { INTERACTION_SETTINGS } from "@veyyon/coding-agent/config/settings-domains/interaction";
import {
	TREE_FILTER_MODES,
	TreeSelectorComponent,
} from "@veyyon/coding-agent/modes/terminal/components/selectors/tree-selector";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@veyyon/kernel/session/session-entries";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../../helpers/stdout-geometry";

const WIDTH = 110;
const ROWS = 40;
/** Fixed wall clock, so an age cell is arithmetic rather than a race with the minute. */
const NOW = Date.parse("2025-03-04T12:00:00.000Z");

let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: ROWS });
	setSystemTime(new Date(NOW));
});

afterEach(() => {
	geometry.restore();
	setSystemTime();
});

let counter = 0;

function node(message: AgentMessage, parentId: string | null, agoMs: number, label?: string): SessionTreeNode {
	const id = `e${counter++}`;
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date(NOW - agoMs).toISOString(),
		message,
	};
	return { entry, children: [], label };
}

/** A user entry under `parent` (or a root when null), `agoMs` old. */
function user(text: string, parent: SessionTreeNode | null, agoMs = 0, label?: string): SessionTreeNode {
	const child = node({ role: "user", content: text, timestamp: ++counter }, parent?.entry.id ?? null, agoMs, label);
	parent?.children.push(child);
	return child;
}

function assistant(text: string, parent: SessionTreeNode, agoMs = 0): SessionTreeNode {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: ++counter,
	} as AgentMessage;
	const child = node(message, parent.entry.id, agoMs);
	parent.children.push(child);
	return child;
}

/**
 * A tool call and its result, chained under `parent`, the way a session records
 * one: the arguments ride the assistant's call and the row is drawn for the
 * result, so a row that shows them proves the pair was matched up.
 */
function toolPair(
	name: string,
	args: Record<string, unknown> | string,
	parent: SessionTreeNode,
	agoMs = 0,
): SessionTreeNode {
	const callId = `call-${counter}`;
	const call = {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: args }],
		stopReason: "toolUse",
		timestamp: ++counter,
	} as unknown as AgentMessage;
	const callNode = node(call, parent.entry.id, agoMs);
	parent.children.push(callNode);
	const result = {
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		timestamp: ++counter,
	} as unknown as AgentMessage;
	const resultNode = node(result, callNode.entry.id, agoMs);
	callNode.children.push(resultNode);
	return resultNode;
}

/** A non-message entry under `parent`, its `type`-specific fields supplied. */
function bookkeeping(fields: Record<string, unknown>, parent: SessionTreeNode): SessionTreeNode {
	const entry = {
		id: `e${counter++}`,
		parentId: parent.entry.id,
		timestamp: new Date(NOW - 60_000).toISOString(),
		...fields,
	} as unknown as SessionEntry;
	const child: SessionTreeNode = { entry, children: [] };
	parent.children.push(child);
	return child;
}

function card(
	tree: SessionTreeNode[],
	leafId: string,
	width = WIDTH,
	filter?: (typeof TREE_FILTER_MODES)[number],
): string[] {
	const component = new TreeSelectorComponent(
		tree,
		leafId,
		() => {},
		() => {},
		undefined,
		filter,
	);
	return component.render(width).map(line => Bun.stripANSI(line));
}

interface Card {
	/** Body-and-chrome rows of the card, border columns trimmed off each one. */
	rows: string[];
	/** Frame rows the card occupies, borders included. */
	height: number;
	/** Rows carrying nothing: the card's vertical padding, and any filler. */
	blank: number;
}

/**
 * The card out of a full-screen frame: one string per card row with the border
 * and pad columns removed, so an assertion about a row's columns is about the
 * list rather than about where the card sits on screen.
 */
function cardOf(frame: readonly string[]): Card {
	const box = theme.boxSharp;
	const top = frame.findIndex(line => line.includes(box.topLeft));
	const topLine = frame[top];
	if (topLine === undefined) throw new Error("cardOf: the frame carries no card");
	const left = topLine.indexOf(box.topLeft);
	const right = topLine.lastIndexOf(box.topRight);
	const bottom = frame.findIndex((line, row) => row > top && line[left] === box.bottomLeft);
	if (bottom === -1) throw new Error("cardOf: the card has no bottom border");
	const rows = frame.slice(top + 1, bottom).map(line => line.slice(left + 2, right - 1).trimEnd());
	return {
		rows,
		height: bottom - top + 1,
		blank: rows.filter(line => line.replace(box.vertical, "").trim() === "").length,
	};
}

/** The row carrying `needle`, border columns already trimmed. */
function rowOf(frame: readonly string[], needle: string): string {
	const row = cardOf(frame).rows.find(line => line.includes(needle));
	if (row === undefined) throw new Error(`no row carries ${JSON.stringify(needle)}`);
	return row;
}

/** The card's header row: search on the left, counts and filter mode on the right. */
function headerOf(frame: readonly string[]): string {
	const header = cardOf(frame).rows[0];
	if (header === undefined) throw new Error("headerOf: the card has no header row");
	return header;
}

/** A linear chain of `count` user entries, newest last. */
function chainOf(count: number): { roots: SessionTreeNode[]; leafId: string } {
	const root = user("prompt 0", null, count * 60_000);
	let tail = root;
	for (let i = 1; i < count; i++) tail = user(`prompt ${i}`, tail, (count - i) * 60_000);
	return { roots: [root], leafId: tail.entry.id };
}

/**
 * Card rows that are not body: two borders, the header row, two dividers and the
 * two-row footer chip band.
 */
const CHROME_ROWS = 7;

describe("the session tree card hugs its rows", () => {
	it("grows one row per entry instead of painting a fixed box", () => {
		counter = 0;
		const small = chainOf(3);
		const shortCard = cardOf(card(small.roots, small.leafId));
		counter = 0;
		const big = chainOf(9);
		const tallCard = cardOf(card(big.roots, big.leafId));

		expect(tallCard.height - shortCard.height).toBe(6);
		expect(tallCard.height).toBeLessThan(ROWS);
	});

	it("never grows past the terminal, and pads no further than the card's own margin", () => {
		counter = 0;
		const small = chainOf(3);
		const shortCard = cardOf(card(small.roots, small.leafId));
		counter = 0;
		const long = chainOf(200);
		const tallCard = cardOf(card(long.roots, long.leafId));

		expect(tallCard.height).toBeLessThanOrEqual(ROWS);
		// Blank rows inside the card are its vertical padding and nothing else. A
		// card sized past its content pads the difference with filler, so the short
		// tree would carry more blank rows than the tree that fills the terminal.
		expect(shortCard.blank).toBe(tallCard.blank);
		// And the tall card spends every remaining row on an entry.
		const shown = tallCard.rows.filter(line => line.includes("prompt")).length;
		expect(shown).toBe(tallCard.height - tallCard.blank - CHROME_ROWS);
	});

	it("keeps entry text in one column whether the row is on the active path or off it", () => {
		counter = 0;
		const root = user("open the session", null, 60 * 60_000);
		const reply = assistant("reading the tree", root, 59 * 60_000);
		const live = user("branch alpha stays live", reply, 30 * 60_000);
		user("branch bravo was abandoned", reply, 58 * 60_000);
		const leaf = assistant("alpha is the current branch", live, 2 * 60_000);

		const frame = card([root], leaf.entry.id);
		const onPath = rowOf(frame, "branch alpha stays live");
		const offPath = rowOf(frame, "branch bravo was abandoned");

		expect(onPath.indexOf("user")).toBe(offPath.indexOf("user"));
		// The mark column is what differs: the on-path row spends it, the off-path
		// row leaves it blank.
		expect(onPath).toContain(`${theme.md.bullet} user`);
		expect(offPath).not.toContain(theme.md.bullet);
	});

	it("marks the current leaf apart from the rest of the active path", () => {
		counter = 0;
		const root = user("open the session", null, 60 * 60_000);
		const reply = assistant("reading the tree", root, 59 * 60_000);
		const live = user("branch alpha stays live", reply, 30 * 60_000);
		user("branch bravo was abandoned", reply, 58 * 60_000);
		const leaf = assistant("alpha is the current branch", live, 2 * 60_000);

		const frame = card([root], leaf.entry.id);
		const pathRows = ["open the session", "reading the tree", "branch alpha stays live"].map(text =>
			rowOf(frame, text),
		);
		const leafRow = rowOf(frame, "alpha is the current branch");
		const abandoned = rowOf(frame, "branch bravo was abandoned");

		// One leaf glyph in the card, on the leaf row.
		expect(leafRow).toContain(`${theme.status.active} assistant`);
		expect(cardOf(frame).rows.filter(line => line.includes(theme.status.active))).toHaveLength(1);
		// The rest of the path carries the plain bullet, never the leaf glyph.
		for (const row of pathRows) {
			expect(row).toContain(theme.md.bullet);
			expect(row).not.toContain(theme.status.active);
		}
		// Off the path, neither.
		expect(abandoned).not.toContain(theme.md.bullet);
		expect(abandoned).not.toContain(theme.status.active);
	});
});

describe("the session tree header names what narrowed the tree", () => {
	it("steps ctrl+O through exactly the modes the setting declares", () => {
		expect([...TREE_FILTER_MODES]).toEqual([...INTERACTION_SETTINGS.treeFilterMode.values]);
	});

	it("names the mode and the visible-of-total count in every declared mode", () => {
		const first = "alpha prompt";
		const second = "bravo prompt";
		const third = "charlie prompt";
		const reply = "a reply with text";
		for (const mode of INTERACTION_SETTINGS.treeFilterMode.values) {
			counter = 0;
			const root = user(first, null, 10 * 60_000, "landmark");
			const answer = assistant(reply, root, 9 * 60_000);
			const middle = user(second, answer, 8 * 60_000);
			const leaf = user(third, middle, 7 * 60_000);

			const frame = card([root], leaf.entry.id, WIDTH, mode);
			const header = headerOf(frame);

			expect(header).toContain(mode);
			const counts = /(?<visible>\d+)\/(?<total>\d+)/.exec(header)?.groups;
			if (counts === undefined) throw new Error(`header names no counts in ${mode}: ${header}`);
			expect(Number(counts.total)).toBe(4);

			// The count is the rows on screen, not a number kept beside them.
			const rows = cardOf(frame).rows;
			const shown = [first, second, third, reply].filter(text => rows.some(line => line.includes(text))).length;
			expect(Number(counts.visible)).toBe(shown);
		}
	});
});

describe("the session tree row dates itself", () => {
	it("ages each row, and says nothing for an entry seconds old", () => {
		counter = 0;
		const root = user("three hours back", null, 3 * 60 * 60_000);
		const recent = assistant("written seconds ago", root, 20_000);
		const old = user("five days back", recent, 5 * 24 * 60 * 60_000);

		const frame = card([root], old.entry.id);

		expect(rowOf(frame, "three hours back").endsWith("3h")).toBe(true);
		expect(rowOf(frame, "five days back").endsWith("5d")).toBe(true);
		expect(rowOf(frame, "written seconds ago").endsWith("written seconds ago")).toBe(true);
	});

	it("truncates the entry text rather than letting it run under the age", () => {
		counter = 0;
		const root = user(`overlong prompt ${"x".repeat(400)}`, null, 4 * 60 * 60_000);
		const leaf = assistant("short reply", root, 2 * 60 * 60_000);

		const row = rowOf(card([root], leaf.entry.id), "overlong prompt");

		expect(row.endsWith("4h")).toBe(true);
		expect(row).toContain("…");
		expect(row.length).toBeLessThanOrEqual(WIDTH);
	});

	it("keeps the age clear of the entry text it sits beside", () => {
		counter = 0;
		const root = user(`overlong prompt ${"x".repeat(400)}`, null, 30 * 60_000);
		const leaf = assistant("short reply", root, 2 * 60 * 60_000);

		const row = rowOf(card([root], leaf.entry.id), "overlong prompt");

		// A truncated row ran its `…` up against the age, so the two read as one
		// token. The age column keeps its own gap whatever the text does.
		expect(row).toMatch(/\S {3,}30m$/);
	});

	it("spends the age cells on entry text when the card is narrow", () => {
		counter = 0;
		const root = user("three hours back", null, 3 * 60 * 60_000);
		const leaf = assistant("a reply", root, 2 * 60 * 60_000);

		const frame = card([root], leaf.entry.id, 46);

		expect(rowOf(frame, "three hours back").endsWith("3h")).toBe(false);
		expect(frame.some(line => /\s3h\s*$/.test(line))).toBe(false);
	});
});

describe("the session tree names what each row is in a column of its own", () => {
	it("starts the entry text at one column whatever the row's kind", () => {
		counter = 0;
		const root = user("the first prompt", null, 60 * 60_000);
		const reply = assistant("the assistant answer", root, 59 * 60_000);
		const read = toolPair("read", { path: "src/alpha.ts" }, reply, 58 * 60_000);
		const ran = toolPair("bash", { command: "bun test src" }, read, 57 * 60_000);
		const leaf = user("the last prompt", ran, 56 * 60_000);

		const frame = card([root], leaf.entry.id, WIDTH, "all");
		const offsets = [
			rowOf(frame, "the first prompt").indexOf("the first prompt"),
			rowOf(frame, "the assistant answer").indexOf("the assistant answer"),
			rowOf(frame, "src/alpha.ts").indexOf("src/alpha.ts"),
			rowOf(frame, "bun test src").indexOf("bun test src"),
			rowOf(frame, "the last prompt").indexOf("the last prompt"),
		];

		// One offset for five kinds of row, all at one depth. A kind spelled into
		// the text instead of into its own column gives five different offsets.
		expect(new Set(offsets).size).toBe(1);
		// And the kind itself starts at one column too.
		const kindOffsets = [
			rowOf(frame, "the first prompt").indexOf("user"),
			rowOf(frame, "the assistant answer").indexOf("assistant"),
			rowOf(frame, "src/alpha.ts").indexOf("read"),
			rowOf(frame, "bun test src").indexOf("bash"),
		];
		expect(new Set(kindOffsets).size).toBe(1);
	});

	it("names a tool in the kind column instead of bracketing it into the text", () => {
		counter = 0;
		const root = user("open a file", null, 60 * 60_000);
		const leaf = toolPair("read", { path: "src/alpha.ts", offset: 10, limit: 20 }, root, 59 * 60_000);

		const row = rowOf(card([root], leaf.entry.id, WIDTH, "all"), "src/alpha.ts");

		expect(row).toContain("read");
		expect(row).toContain("src/alpha.ts:10-29");
		expect(row).not.toContain("[read");
	});

	it("cuts a long path from the left so the file name survives", () => {
		counter = 0;
		const root = user("edit something deep", null, 60 * 60_000);
		const deep = "packages/coding-agent/src/modes/terminal/components/selectors/tree-selector.ts";
		const leaf = toolPair("edit", { path: deep }, root, 59 * 60_000);

		const row = rowOf(card([root], leaf.entry.id, WIDTH, "all"), "tree-selector.ts");

		// The tail is what distinguishes one row from the next; the shared
		// repository prefix is what a right-hand cut would keep.
		expect(row).toContain("…/");
		expect(row).not.toContain("packages/coding-agent");
	});

	it("summarizes an unfamiliar tool by an argument rather than by its JSON", () => {
		counter = 0;
		const root = user("look it up", null, 60 * 60_000);
		const leaf = toolPair(
			"web_search",
			{ query: "terminal tree column alignment", i: "Searching for prior art" },
			root,
			59 * 60_000,
		);

		const row = rowOf(card([root], leaf.entry.id, WIDTH, "all"), "web_search");

		expect(row).toContain("terminal tree column alignment");
		expect(row).not.toContain('{"');
		// The caller's own intent line restates the kind column, so a tool whose
		// arguments carry nothing else the card knows by name still skips it.
		expect(row).not.toContain("Searching for prior art");

		counter = 0;
		const other = user("restart it", null, 60 * 60_000);
		const intentOnly = toolPair(
			"deploy",
			{ i: "Restarting the worker", service: "alpha-worker" },
			other,
			59 * 60_000,
		);

		const intentRow = rowOf(card([other], intentOnly.entry.id, WIDTH, "all"), "deploy");

		expect(intentRow).toContain("alpha-worker");
		expect(intentRow).not.toContain("Restarting the worker");
	});
});

describe("the session tree paints no row it cannot describe", () => {
	/** Every bookkeeping entry, with the text its row is expected to name. */
	const BOOKKEEPING: readonly { fields: Record<string, unknown>; kind: string; text: string }[] = [
		{ fields: { type: "mode_change", mode: "plan" }, kind: "mode", text: "plan" },
		{ fields: { type: "title_change", title: "tree revamp", source: "user" }, kind: "title", text: "tree revamp" },
		{
			fields: { type: "session_init", systemPrompt: "p", task: "t", tools: ["read", "edit"] },
			kind: "session",
			text: "2 tools",
		},
		{ fields: { type: "ttsr_injection", injectedRules: ["no-any"] }, kind: "rules", text: "no-any" },
		{ fields: { type: "mcp_tool_selection", selectedToolNames: ["fetch"] }, kind: "mcp", text: "fetch" },
		{ fields: { type: "service_tier_change", serviceTier: null }, kind: "tier", text: "(cleared)" },
		{ fields: { type: "model_change", model: "sonnet-4" }, kind: "model", text: "sonnet-4" },
		{ fields: { type: "thinking_level_change", thinkingLevel: "high" }, kind: "thinking", text: "high" },
		{ fields: { type: "label", targetId: "e0", label: "landmark" }, kind: "label", text: "landmark" },
		{ fields: { type: "custom", customType: "note" }, kind: "custom", text: "note" },
	];

	it("names every bookkeeping entry in `all`, and hides it by default", () => {
		for (const { fields, kind, text } of BOOKKEEPING) {
			counter = 0;
			const root = user("a prompt to hang it off", null, 60 * 60_000);
			const entryNode = bookkeeping(fields, root);
			const leaf = assistant("a reply", entryNode, 30 * 60_000);

			const all = cardOf(card([root], leaf.entry.id, WIDTH, "all")).rows;
			const row = all.find(line => line.includes(kind));
			if (row === undefined) throw new Error(`no row names ${kind}: ${all.join("\n")}`);
			expect(row).toContain(text);

			// Bookkeeping is not conversation: the default filter drops it, rather
			// than showing a row whose only content is a word for a state change.
			const shown = cardOf(card([root], leaf.entry.id)).rows;
			expect(shown.some(line => line.includes(text))).toBe(false);
		}
	});

	it("names an entry kind it was never written for", () => {
		counter = 0;
		const root = user("a prompt to hang it off", null, 60 * 60_000);
		// An entry type no union here declares: what a package that merges its own
		// entry into the session vocabulary produces. The row builder's fallback
		// is the reason such an entry cannot paint a blank, unreadable row.
		const merged = bookkeeping({ type: "artifact", count: 3 }, root);
		const leaf = assistant("a reply", merged, 30 * 60_000);

		const rows = cardOf(card([root], leaf.entry.id, WIDTH, "all")).rows;

		expect(rows.some(line => line.includes("artifact"))).toBe(true);
		// A kind wider than the column is cut to it, and still names itself.
		counter = 0;
		const other = user("another prompt", null, 60 * 60_000);
		const wide = bookkeeping({ type: "artifact_index_rebuild" }, other);
		const wideLeaf = assistant("a reply", wide, 30 * 60_000);
		const wideRows = cardOf(card([other], wideLeaf.entry.id, WIDTH, "all")).rows;
		expect(wideRows.some(line => line.includes("artifact_"))).toBe(true);
	});

	it("leaves no body row blank between the first entry and the last", () => {
		counter = 0;
		const root = user("a prompt", null, 60 * 60_000);
		let tail = root;
		for (const { fields } of BOOKKEEPING) tail = bookkeeping(fields, tail);
		// The merged kind rides the same chain: the fallback is part of the
		// invariant, not a separate case.
		tail = bookkeeping({ type: "artifact" }, tail);
		const leaf = assistant("the last word", tail, 30 * 60_000);

		const rows = cardOf(card([root], leaf.entry.id, WIDTH, "all")).rows;
		const first = rows.findIndex(line => line.includes("a prompt"));
		const last = rows.findIndex(line => line.includes("the last word"));

		expect(first).toBeGreaterThanOrEqual(0);
		expect(last).toBeGreaterThan(first);
		for (const line of rows.slice(first, last + 1)) {
			// What is read is the row's own words: the cursor lane, the rail, the
			// node mark and the age are structure, and a row that carries only
			// those says nothing about what its entry IS.
			const words = line
				.replace(/\s+\d+[mhdwy]$/, "")
				.replace(/^[\s›│├└─●•…]+/, "")
				.trim();
			expect(words).not.toBe("");
		}
	});
});

/**
 * Every entry type the session vocabulary declares, read out of the contract at
 * run time rather than listed here.
 *
 * The list below is what this suite knows how to build; the contract is what
 * the product can hand the card. Comparing the two by exact equality is what
 * makes an entry type added to `contracts/session/src/entry.ts` turn this suite
 * red until someone decides what its row says — which a hardcoded list of types
 * cannot do, because it goes stale in silence and the defect this closes WAS an
 * entry type nobody had written a row for.
 */
function declaredEntryTypes(): string[] {
	const contract = join(
		import.meta.dirname,
		"..",
		"..",
		"..",
		"..",
		"..",
		"..",
		"contracts",
		"session",
		"src",
		"entry.ts",
	);
	const source = readFileSync(contract, "utf8");
	const types = new Set<string>();
	for (const match of source.matchAll(/^\ttype: "([a-z_]+)";$/gm)) types.add(match[1]);
	return [...types].sort();
}

describe("the session tree describes every entry the session vocabulary declares", () => {
	/** One buildable entry per declared type, with the kind and text its row owes. */
	const ROWS_BY_TYPE: Readonly<Record<string, { fields: Record<string, unknown>; kind: string; text: string }>> = {
		message: {
			fields: { type: "message", message: { role: "user", content: "a swept prompt", timestamp: 1 } },
			kind: "user",
			text: "a swept prompt",
		},
		custom_message: {
			fields: { type: "custom_message", customType: "note", content: "a swept note" },
			kind: "note",
			text: "a swept note",
		},
		compaction: {
			fields: { type: "compaction", summary: "s", firstKeptEntryId: "e0", tokensBefore: 12_000 },
			kind: "compaction",
			text: "12k tokens",
		},
		branch_summary: {
			fields: { type: "branch_summary", summary: "what the abandoned branch did" },
			kind: "summary",
			text: "what the abandoned branch did",
		},
		model_change: { fields: { type: "model_change", model: "sonnet-4" }, kind: "model", text: "sonnet-4" },
		thinking_level_change: {
			fields: { type: "thinking_level_change", thinkingLevel: "high" },
			kind: "thinking",
			text: "high",
		},
		service_tier_change: {
			fields: { type: "service_tier_change", serviceTier: null },
			kind: "tier",
			text: "(cleared)",
		},
		mode_change: { fields: { type: "mode_change", mode: "plan" }, kind: "mode", text: "plan" },
		title_change: {
			fields: { type: "title_change", title: "tree revamp", source: "user" },
			kind: "title",
			text: "tree revamp",
		},
		session_init: {
			fields: { type: "session_init", systemPrompt: "p", task: "t", tools: ["read", "edit"] },
			kind: "session",
			text: "2 tools",
		},
		ttsr_injection: { fields: { type: "ttsr_injection", injectedRules: ["no-any"] }, kind: "rules", text: "no-any" },
		mcp_tool_selection: {
			fields: { type: "mcp_tool_selection", selectedToolNames: ["fetch"] },
			kind: "mcp",
			text: "fetch",
		},
		label: { fields: { type: "label", targetId: "e0", label: "landmark" }, kind: "label", text: "landmark" },
		custom: { fields: { type: "custom", customType: "note" }, kind: "custom", text: "note" },
	};

	it("covers the declared vocabulary and nothing else", () => {
		expect(Object.keys(ROWS_BY_TYPE).sort()).toEqual(declaredEntryTypes());
	});

	it("gives each declared type a row that names its kind and its value", () => {
		for (const [type, { fields, kind, text }] of Object.entries(ROWS_BY_TYPE)) {
			counter = 0;
			const root = user("a prompt to hang it off", null, 60 * 60_000);
			const entryNode = bookkeeping(fields, root);
			const leaf = assistant("a reply", entryNode, 30 * 60_000);

			const rows = cardOf(card([root], leaf.entry.id, WIDTH, "all")).rows;
			const row = rows.find(line => line.includes(text));
			if (row === undefined) throw new Error(`no row carries ${type}'s text: ${rows.join("\n")}`);
			expect(row).toContain(kind);
		}
	});
});

describe("the session tree reads arguments a session never parsed", () => {
	// A turn that ends mid-call records the raw JSON the provider streamed rather
	// than a parsed object. Reading `args.path` off a string answers `undefined`,
	// so a per-tool rule would spend the row on an empty cell and the row would
	// say only which tool ran.
	const RAW = '{"path":"src/parser.ts","offset":10}';

	it("shows the raw payload whatever the tool is", () => {
		for (const name of ["read", "web_search"]) {
			counter = 0;
			const root = user("start it", null, 60 * 60_000);
			const leaf = toolPair(name, RAW, root, 59 * 60_000);

			const row = rowOf(card([root], leaf.entry.id, WIDTH, "all"), name);

			expect(row).toContain("src/parser.ts");
		}
	});
});
