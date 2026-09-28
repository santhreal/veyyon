/**
 * WHY: the session tree drew a row with no text for every entry type its row
 * switch did not name (the session's lifecycle markers, settings snapshots,
 * title changes, mode changes and six more), and showed those blank rows in
 * the default view, which hid only the four settings types it listed. The
 * terminal's `/tree` picker and the desktop's tree sheet both read their rows
 * from `presentation/session-tree.ts`, so both drew the same blank rows.
 *
 * CLASS CLOSED: an entry type that reads as nothing, and bookkeeping the
 * default view shows. `ENTRIES` and `ROWS` are keyed by every member of
 * `SessionEntry["type"]`, including the kinds a package adds through
 * `CustomCompactionSessionEntries`, so a new entry type fails `check:ts` here
 * until it has a row and a filter decision; the presenter's switch ends in a
 * `never` check for the same reason. An entry type a newer writer added reads
 * as its bare tag and stays out of the default view.
 *
 * NOT CAUGHT: the rows a message entry reads per role, which the tree
 * selector suites and the GUI host tree suite assert.
 */

import { describe, expect, test } from "bun:test";
import { SESSION_TREE_FILTERS } from "@veyyon/coding-agent/gui-host/wire";
import { isTreeEntryShown, treeEntryRow } from "@veyyon/coding-agent/presentation/session-tree";
import type { SessionEntry, SessionTreeNode } from "@veyyon/kernel/session/session-entries";

type EntryType = SessionEntry["type"];

const BASE = { id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };

/** One entry of every type a session file holds. */
const ENTRIES: { [K in EntryType]: Extract<SessionEntry, { type: K }> } = {
	message: {
		...BASE,
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "Name the files." }], timestamp: 1 },
	},
	thinking_level_change: { ...BASE, type: "thinking_level_change", thinkingLevel: "high" },
	model_change: { ...BASE, type: "model_change", model: "openai/gpt-4o-mini" },
	service_tier_change: { ...BASE, type: "service_tier_change", serviceTier: { openai: "priority", google: "flex" } },
	compaction: {
		...BASE,
		type: "compaction",
		summary: "Earlier turns.",
		firstKeptEntryId: "kept",
		tokensBefore: 48_600,
	},
	branch_summary: { ...BASE, type: "branch_summary", fromId: "left", summary: "The branch it left\nread two files." },
	custom: { ...BASE, type: "custom", customType: "bench-marker" },
	custom_message: {
		...BASE,
		type: "custom_message",
		customType: "session-state",
		content: "Mode is plan.",
		display: true,
	},
	label: { ...BASE, type: "label", targetId: "kept", label: "checkpoint A" },
	title_change: { ...BASE, type: "title_change", title: "List the files", source: "auto" },
	ttsr_injection: { ...BASE, type: "ttsr_injection", injectedRules: ["no-console", "hard-tabs"] },
	mcp_tool_selection: { ...BASE, type: "mcp_tool_selection", selectedToolNames: [] },
	session_init: {
		...BASE,
		type: "session_init",
		systemPrompt: "Answer briefly.",
		task: "List files.",
		tools: ["read"],
	},
	mode_change: { ...BASE, type: "mode_change", mode: "plan" },
	subagent_spawn: {
		...BASE,
		type: "subagent_spawn",
		agentId: "agent-1",
		agentName: "task",
		task: "Count the lines.",
		sessionFile: "/repo/.agents/agent-1.jsonl",
		isolation: "none",
		status: "completed",
		exitCode: 0,
		durationMs: 1200,
	},
	settings_snapshot: {
		...BASE,
		type: "settings_snapshot",
		kind: "diff",
		values: { "display.transitions": "off", treeFilterMode: "all" },
	},
	session_lifecycle: { ...BASE, type: "session_lifecycle", state: "running", reason: "created" },
	session_checkpoint: { ...BASE, type: "session_checkpoint", prefixSequence: 12 },
};

/** The line each entry of `ENTRIES` reads: its marker, then its text. */
const ROWS: { [K in EntryType]: string } = {
	message: "user: Name the files.",
	thinking_level_change: "[thinking: high]",
	model_change: "[model: openai/gpt-4o-mini]",
	service_tier_change: "[service tier: openai priority, google flex]",
	compaction: "[compaction: 49k tokens]",
	branch_summary: "[branch summary]: The branch it left read two files.",
	custom: "[custom: bench-marker]",
	custom_message: "[session-state]: Mode is plan.",
	label: "[label: checkpoint A]",
	title_change: "[title: List the files]",
	ttsr_injection: "[rules: no-console, hard-tabs]",
	mcp_tool_selection: "[mcp tools: none]",
	session_init: "[session start]",
	mode_change: "[mode: plan]",
	subagent_spawn: "[agent task: completed]",
	settings_snapshot: "[settings: display.transitions, treeFilterMode]",
	session_lifecycle: "[session running: created]",
	session_checkpoint: "[checkpoint]",
};

const CONVERSATION = ["default", "no-tools", "all"];
const BOOKKEEPING = ["all"];

/** The filters that show each entry of `ENTRIES`: the conversation in the default view, bookkeeping only in all. */
const SHOWN: { [K in EntryType]: string[] } = {
	message: ["default", "no-tools", "user-only", "all"],
	thinking_level_change: BOOKKEEPING,
	model_change: BOOKKEEPING,
	service_tier_change: BOOKKEEPING,
	compaction: CONVERSATION,
	branch_summary: CONVERSATION,
	custom: BOOKKEEPING,
	custom_message: CONVERSATION,
	label: BOOKKEEPING,
	title_change: BOOKKEEPING,
	ttsr_injection: BOOKKEEPING,
	mcp_tool_selection: BOOKKEEPING,
	session_init: BOOKKEEPING,
	mode_change: BOOKKEEPING,
	subagent_spawn: BOOKKEEPING,
	settings_snapshot: BOOKKEEPING,
	session_lifecycle: BOOKKEEPING,
	session_checkpoint: BOOKKEEPING,
};

/** What a host reads for `entry` as a tree root: its line and the filters that show it. */
function readRow(entry: SessionEntry): { line: string; shown: string[] } {
	const node: SessionTreeNode = { entry, children: [] };
	const row = treeEntryRow(node, new Map());
	return {
		line: row.prefix + row.text,
		shown: SESSION_TREE_FILTERS.filter(filter => isTreeEntryShown(node, filter, null)),
	};
}

describe("a session tree row names its entry, and the default view hides bookkeeping", () => {
	test("every entry type reads as its own line", () => {
		const lines = Object.fromEntries(Object.values(ENTRIES).map(entry => [entry.type, readRow(entry).line]));
		expect(lines).toEqual(ROWS);
	});

	test("the default and no-tools views show the conversation and no bookkeeping; all shows every entry", () => {
		const shown = Object.fromEntries(Object.values(ENTRIES).map(entry => [entry.type, readRow(entry).shown]));
		expect(shown).toEqual(SHOWN);
	});

	test("an entry type a newer writer added reads as its tag and shows only in the all view", () => {
		// Read the way a session file line arrives: parsed JSON with a tag this build does not name.
		const future: SessionEntry = JSON.parse(
			'{"type":"from_a_newer_writer","id":"entry","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z"}',
		);
		expect(readRow(future)).toEqual({ line: "[from_a_newer_writer]", shown: ["all"] });
	});
});
