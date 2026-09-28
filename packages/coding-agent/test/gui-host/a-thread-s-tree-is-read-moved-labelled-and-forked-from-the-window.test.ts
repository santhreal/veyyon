/**
 * WHY: the window's tree sheet and its "Fork this thread" row send
 * `LoadSessionTree`, `NavigateTree`, `AbortBranchSummary`, `SetEntryLabel`
 * and `ForkSession`, which the terminal's `/tree` picker and `/fork` command
 * perform, and the host had no handler for any of them, so the sheet opened
 * empty and every press on it was refused. This drives the real handlers
 * against a session file with two branches and reads back what the window
 * draws: the tree section, the transcript, the header and the prompt handed
 * back to the composer.
 *
 * CLASS CLOSED: a tree request the host accepts and then states wrongly or
 * not at all. Each request is asserted on the surface the window reads after
 * it: the rows (order, indent, parent, kind, text, label, current branch and
 * the filters that show each row), the settings the sheet opens with, the
 * leaf a navigation lands on for a reply and for a prompt, the summary a
 * navigation writes and the instructions it was written with, the abort that
 * ends a pending summary, the label a later tree and the session file keep,
 * and the fork the window moves onto. Refusals are swept per request: a
 * missing argument, a session the window does not have open, an entry on no
 * branch, and a turn still running.
 *
 * NOT CAUGHT: the sheet's own drawing and key handling, which are
 * `crates/veyyon-desktop-app`'s to assert; an extension cancelling a fork or
 * a navigation, which no extension in this fixture registers for; and a fork
 * of a session that never reached disk, which the window cannot open.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ApiKey, type AssistantMessage, type Context, isApiKeyResolver, type StopReason } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { resetSettingsForTest } from "../../src/config/settings";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { SessionTreeFilter, SessionTreeView } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

/** What the model answers a summary request with. */
const SUMMARY = "The YAML path was abandoned.";

/** The filters that show a prompt, which is every filter but the labelled one. */
const PROMPT_FILTERS: SessionTreeFilter[] = ["default", "no-tools", "user-only", "all"];

/** The filters that show a reply with text. */
const REPLY_FILTERS: SessionTreeFilter[] = ["default", "no-tools", "all"];

/** The words each seeded entry records, by the name the assertions use. */
const WORDS = {
	first: "what does this crate do",
	firstReply: "it parses configuration files",
	second: "read the parser first",
	secondReply: "the parser reads TOML",
	other: "try the YAML path instead",
	otherReply: "the YAML path is unused",
} as const;

type EntryName = keyof typeof WORDS;

interface TreeSection {
	session: string;
	tree: SessionTreeView;
}

/** A tree row as the assertions read it: entries by seeded name, kinds and filters as text. */
interface TreeRow {
	entry: string;
	parent: string | null;
	depth: number;
	kind: string;
	prefix: string;
	text: string;
	label: string | null;
	on_path: boolean;
	shown_in: string[];
}

interface ActiveSessionSection {
	value: { id: string };
}

interface TranscriptSection {
	value: Array<{ role: string; content: Array<{ Text?: { text: string } }> }>;
}

interface QueuedPromptsSection {
	restored: string | null;
}

type SessionsSection = [{ value: Array<{ id: string }> }, unknown[]];

function assistantMessage(text: string, stopReason: StopReason = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1_700_000_000_001,
	};
}

/** A reply that finishes on its own. */
function completedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

/**
 * A reply that finishes once the request's credential resolves, as a
 * provider's does. A branch summary builds its prompt only when its
 * credential resolves, so `sent` reads the messages at that point.
 */
function providerStream(
	context: Context,
	apiKey: ApiKey | undefined,
	sent: (messages: string) => void,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(SUMMARY);
	void (async () => {
		if (isApiKeyResolver(apiKey)) await apiKey({ lastChance: false, error: undefined });
		sent(JSON.stringify(context.messages));
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "text_delta", contentIndex: 0, delta: SUMMARY, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	})();
	return stream;
}

/**
 * Whether `context` is the request that names a session from its first
 * prompt: one `<user>` string and none of the session's own messages.
 */
function isTitleRequest(context: Context): boolean {
	const first = context.messages[0]?.content;
	return context.messages.length === 1 && typeof first === "string" && first.startsWith("<user>");
}

/** The tree the last `SessionTree` section in `frames` states. */
function treeIn(frames: RequestFrame[]): TreeSection | undefined {
	return snapshotSections<TreeSection>(frames, "SessionTree").at(-1);
}

/** The text of every user entry in the last transcript `frames` carries. */
function promptsIn(frames: RequestFrame[]): string[] | undefined {
	return snapshotSections<TranscriptSection>(frames, "Transcript")
		.at(-1)
		?.value.filter(entry => entry.role === "User")
		.flatMap(entry => entry.content.map(block => block.Text?.text ?? ""))
		.filter(text => text.length > 0);
}

/** The prompt the last queued-prompts report in `frames` hands back to the composer. */
function restoredIn(frames: RequestFrame[]): string | null | undefined {
	return snapshotSections<QueuedPromptsSection>(frames, "QueuedPrompts").at(-1)?.restored;
}

/** The request id a terminal frame answers, if `frame` is one. */
function answered(frame: RequestFrame): number | undefined {
	return frame.RequestSucceeded?.request ?? frame.RequestFailed?.request;
}

describe("a thread's tree is read, moved, labelled and forked from the window", () => {
	let tempDir: string;
	let sessionDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	/** The seeded session's id. */
	let source: string;
	/** The seeded entry ids, by name. */
	let ids: Record<EntryName, string>;
	/** Each seeded entry id's name, for rows read back. */
	let names: Map<string, EntryName>;
	/** The messages of every request the model was sent that is not a session title, in order. */
	let requests: string[];

	beforeEach(async () => {
		// `Settings` is process-wide and reads its file once, so this suite's
		// tree settings are read from its own config rather than a previous one's.
		resetSettingsForTest();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-session-tree-"));
		const storage = new FileSessionStorage();
		sessionDir = computeDefaultSessionDir(tempDir, storage, path.join(tempDir, "sessions"));
		const sm = SessionManager.create(tempDir, sessionDir, storage);
		const prompt = (name: EntryName): string =>
			sm.appendMessage({
				role: "user",
				content: [{ type: "text", text: WORDS[name] }],
				timestamp: 1_700_000_000_000,
			});
		const first = prompt("first");
		const firstReply = sm.appendMessage(assistantMessage(WORDS.firstReply));
		const second = prompt("second");
		const secondReply = sm.appendMessage(assistantMessage(WORDS.secondReply));
		// The second branch leaves the first reply, and is the one the file ends on.
		sm.branch(firstReply);
		const other = prompt("other");
		const otherReply = sm.appendMessage(assistantMessage(WORDS.otherReply));
		await sm.ensureOnDisk();
		await sm.flush();
		source = sm.getSessionId();
		ids = { first, firstReply, second, secondReply, other, otherReply };
		names = new Map(Object.entries(ids).map(([name, id]) => [id, name as EntryName]));

		requests = [];
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context, options) =>
			providerStream(context, options?.apiKey, messages => {
				if (!isTitleRequest(context)) requests.push(messages);
			}),
		);
		// Both tree settings away from their defaults, so a sheet that opened
		// on the defaults is told apart from one opened on the settings.
		await fs.writeFile(
			path.join(tempDir, "config.yml"),
			"modelRoles:\n  default: openai/gpt-4o-mini\nbranchSummary:\n  enabled: true\ntreeFilterMode: user-only\n",
			"utf8",
		);
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir, authStorage });
		client = await TestSocketClient.connect(server.endpoint);
		// Greeting and capabilities.
		await client.nextFrame();
		await client.nextFrame();
		const opened = await client.request(1, { OpenSession: { session: source } });
		expect(opened.outcome.RequestFailed).toBeUndefined();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		resetSettingsForTest();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** The rows of `tree` by seeded name, with every field the sheet draws. */
	function rowsOf(tree: SessionTreeView): TreeRow[] {
		return tree.nodes.map(node => ({
			entry: names.get(node.id) ?? node.kind,
			parent: node.parent === null ? null : (names.get(node.parent) ?? node.parent),
			depth: node.depth,
			kind: node.kind,
			prefix: node.prefix,
			text: node.text,
			label: node.label,
			on_path: node.on_path,
			shown_in: node.shown_in,
		}));
	}

	/** The seeded names of the rows on the current branch, in the order drawn. */
	function currentBranch(tree: SessionTreeView): Array<string | undefined> {
		return tree.nodes.filter(node => node.on_path).map(node => names.get(node.id) ?? node.kind);
	}

	/** The tree the window reads after asking for it. */
	async function loadTree(id: number): Promise<SessionTreeView> {
		const loaded = await client.request(id, { LoadSessionTree: { session: source } });
		expect(loaded.outcome.RequestFailed).toBeUndefined();
		const section = treeIn(loaded.frames);
		expect(section?.session).toBe(source);
		return section!.tree;
	}

	/** The seeded session's file. */
	async function sourceFile(): Promise<string> {
		for (const file of await fs.readdir(sessionDir)) {
			if (!file.endsWith(".jsonl")) continue;
			const full = path.join(sessionDir, file);
			const opened = await SessionManager.open(full, undefined, undefined, { suppressBreadcrumb: true });
			if (opened.getSessionId() === source) return full;
		}
		throw new Error(`no session file in ${sessionDir} holds ${source}`);
	}

	test("the tree the window loads is every entry, current branch first, as the terminal draws it", async () => {
		const tree = await loadTree(2);

		expect(tree.leaf).toBe(ids.otherReply);
		expect(tree.summary_offered).toBe(true);
		expect(tree.filter).toBe("user-only");
		const prompt = { kind: "user", prefix: "user: ", label: null, shown_in: PROMPT_FILTERS };
		const reply = { kind: "assistant", prefix: "assistant: ", label: null, shown_in: REPLY_FILTERS };
		// The branch point indents both of its children and the first
		// generation below them; the current branch is drawn first.
		expect(rowsOf(tree)).toEqual([
			{ ...prompt, entry: "first", parent: null, depth: 0, text: WORDS.first, on_path: true },
			{ ...reply, entry: "firstReply", parent: "first", depth: 0, text: WORDS.firstReply, on_path: true },
			{ ...prompt, entry: "other", parent: "firstReply", depth: 1, text: WORDS.other, on_path: true },
			{ ...reply, entry: "otherReply", parent: "other", depth: 2, text: WORDS.otherReply, on_path: true },
			{ ...prompt, entry: "second", parent: "firstReply", depth: 1, text: WORDS.second, on_path: false },
			{ ...reply, entry: "secondReply", parent: "second", depth: 2, text: WORDS.secondReply, on_path: false },
		]);
	});

	test("a request missing its session or naming one the window does not have open is refused", async () => {
		const elsewhere = "a-session-the-window-never-opened";
		const actions = {
			LoadSessionTree: {},
			NavigateTree: { entry: ids.secondReply, summarize: false, instructions: null },
			AbortBranchSummary: {},
			SetEntryLabel: { entry: ids.first, label: "kept" },
			ForkSession: {},
		};
		let id = 10;
		for (const [action, fields] of Object.entries(actions)) {
			id += 1;
			const missing = await client.request(id, { [action]: { ...fields, session: "  " } });
			expect([action, missing.outcome.RequestFailed?.error.code]).toEqual([action, "INVALID_ARGUMENTS"]);
			if (action === "ForkSession") continue;
			// Reading, moving or labelling a tree acts on the thread on screen
			// and never moves the window onto another one.
			id += 1;
			const foreign = await client.request(id, { [action]: { ...fields, session: elsewhere } });
			expect([action, foreign.outcome.RequestFailed?.error.code]).toEqual([action, "SESSION_NOT_FOUND"]);
		}
		const tree = await loadTree(id + 1);
		expect(tree.leaf).toBe(ids.otherReply);
		expect(tree.nodes.map(node => node.label)).toEqual(tree.nodes.map(() => null));
	});

	test("moving onto a reply lands the leaf on it and states that branch", async () => {
		const moved = await client.request(2, {
			NavigateTree: { session: source, entry: ids.secondReply, summarize: false, instructions: null },
		});
		expect(moved.outcome.RequestFailed).toBeUndefined();

		expect(promptsIn(moved.frames)).toEqual([WORDS.first, WORDS.second]);
		const tree = treeIn(moved.frames)?.tree;
		expect(tree?.leaf).toBe(ids.secondReply);
		expect(currentBranch(tree!)).toEqual(["first", "firstReply", "second", "secondReply"]);
		// A reply is not the operator's words, so nothing returns to the composer.
		expect(restoredIn(moved.frames) ?? null).toBeNull();
		expect(requests).toEqual([]);
	});

	test("moving onto a prompt lands the leaf before it and hands the prompt back to the composer", async () => {
		const moved = await client.request(2, {
			NavigateTree: { session: source, entry: ids.second, summarize: false, instructions: null },
		});
		expect(moved.outcome.RequestFailed).toBeUndefined();

		expect(promptsIn(moved.frames)).toEqual([WORDS.first]);
		const tree = treeIn(moved.frames)?.tree;
		expect(tree?.leaf).toBe(ids.firstReply);
		expect(currentBranch(tree!)).toEqual(["first", "firstReply"]);
		expect(restoredIn(moved.frames)).toBe(WORDS.second);
	});

	test("a move to no entry, or to one on no branch, is refused and leaves the leaf where it was", async () => {
		for (const [entry, code] of [
			["   ", "INVALID_ARGUMENTS"],
			["no-such-entry", "NAVIGATE_TREE_FAILED"],
		] as const) {
			const refused = await client.request(2, {
				NavigateTree: { session: source, entry, summarize: false, instructions: null },
			});
			expect([entry, refused.outcome.RequestFailed?.error.code]).toEqual([entry, code]);
		}
		expect((await loadTree(3)).leaf).toBe(ids.otherReply);
	});

	test("a move that asks for a summary writes one of the branch it leaves, with the instructions given", async () => {
		const moved = await client.request(2, {
			NavigateTree: { session: source, entry: ids.secondReply, summarize: true, instructions: "  name the files  " },
		});
		expect(moved.outcome.RequestFailed).toBeUndefined();

		// One request, made of the branch left behind and the instructions.
		expect(requests.length).toBe(1);
		const asked = requests[0]!;
		expect(asked).toContain(WORDS.otherReply);
		expect(asked).toContain("name the files");
		const tree = treeIn(moved.frames)!.tree;
		const summary = tree.nodes.find(node => node.kind === "branch_summary");
		expect(summary?.parent).toBe(ids.secondReply);
		expect(summary?.prefix).toBe("[branch summary]: ");
		expect(summary?.text).toContain(SUMMARY);
		expect(tree.leaf).toBe(summary!.id);
		expect(currentBranch(tree)).toEqual(["first", "firstReply", "second", "secondReply", "branch_summary"]);
	});

	test("an abort ends a pending summary and the move it was part of", async () => {
		const summaryRequested = Promise.withResolvers<void>();
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, _context, options) => {
			// A summary that never finishes on its own: only the abort ends it.
			const held = new AssistantMessageEventStream();
			options?.signal?.addEventListener("abort", () => held.end(assistantMessage("", "aborted")), { once: true });
			summaryRequested.resolve();
			return held;
		});
		client.send({
			id: 2,
			action: { NavigateTree: { session: source, entry: ids.secondReply, summarize: true, instructions: null } },
		});
		await summaryRequested.promise;
		client.send({ id: 3, action: { AbortBranchSummary: { session: source } } });
		const outcomes = new Map<number, RequestFrame>();
		while (outcomes.size < 2) {
			const frame = (await client.nextFrame()) as RequestFrame;
			const id = answered(frame);
			if (id === 2 || id === 3) outcomes.set(id, frame);
		}

		expect(outcomes.get(3)?.RequestSucceeded).toEqual({ request: 3 });
		const failure = outcomes.get(2)?.RequestFailed?.error;
		expect([failure?.code, failure?.retryable]).toEqual(["BRANCH_SUMMARY_CANCELLED", true]);
		const tree = await loadTree(4);
		expect(tree.leaf).toBe(ids.otherReply);
		expect(tree.nodes.some(node => node.kind === "branch_summary")).toBe(false);
	});

	test("a label is set, trimmed, cleared, and kept in the session file", async () => {
		const labelled = await client.request(2, {
			SetEntryLabel: { session: source, entry: ids.firstReply, label: "  before the rewrite  " },
		});
		expect(labelled.outcome.RequestFailed).toBeUndefined();
		const tree = treeIn(labelled.frames)!.tree;
		const row = tree.nodes.find(node => node.id === ids.firstReply);
		expect(row?.label).toBe("before the rewrite");
		expect(row?.shown_in).toEqual(["default", "no-tools", "labeled-only", "all"]);
		// The change is an entry of its own, which only the `all` filter shows.
		const change = tree.nodes.find(node => node.kind === "label");
		expect([change?.text, change?.shown_in]).toEqual(["[label: before the rewrite]", ["all"]]);

		for (const [id, label] of [
			[3, null],
			[4, "   "],
		] as const) {
			const cleared = await client.request(id, { SetEntryLabel: { session: source, entry: ids.firstReply, label } });
			expect(cleared.outcome.RequestFailed).toBeUndefined();
			const clearedRow = treeIn(cleared.frames)!.tree.nodes.find(node => node.id === ids.firstReply);
			expect([label, clearedRow?.label, clearedRow?.shown_in]).toEqual([label, null, REPLY_FILTERS]);
		}

		const kept = await client.request(5, {
			SetEntryLabel: { session: source, entry: ids.second, label: "the parser" },
		});
		expect(kept.outcome.RequestFailed).toBeUndefined();
		await server!.close();
		server = null;
		const reopened = await SessionManager.open(await sourceFile(), undefined, undefined, {
			suppressBreadcrumb: true,
		});
		expect([reopened.getLabel(ids.second), reopened.getLabel(ids.firstReply)]).toEqual(["the parser", undefined]);
	});

	test("a label for no entry, or for one on no branch, is refused and sets nothing", async () => {
		for (const [entry, code] of [
			["   ", "INVALID_ARGUMENTS"],
			["no-such-entry", "SET_ENTRY_LABEL_FAILED"],
		] as const) {
			const refused = await client.request(2, { SetEntryLabel: { session: source, entry, label: "kept" } });
			expect([entry, refused.outcome.RequestFailed?.error.code]).toEqual([entry, code]);
		}
		const tree = await loadTree(3);
		expect(tree.nodes.some(node => node.kind === "label" || node.label !== null)).toBe(false);
	});

	test("a fork is a new session holding every entry, and the window moves onto it", async () => {
		const before = await loadTree(2);
		const forked = await client.request(3, { ForkSession: { session: source } });
		expect(forked.outcome.RequestFailed).toBeUndefined();

		const fork = snapshotSections<ActiveSessionSection>(forked.frames, "ActiveSession").at(-1)?.value.id;
		expect(fork).toBeDefined();
		expect(fork).not.toBe(source);
		expect(promptsIn(forked.frames)).toEqual([WORDS.first, WORDS.other]);
		const listed = snapshotSections<SessionsSection>(forked.frames, "Sessions")
			.at(-1)?.[0]
			.value.map(s => s.id);
		expect(listed).toContain(fork);
		expect(listed).toContain(source);

		// The window is on the fork: its tree is the source's, entry for entry,
		// and the source is no longer the thread on screen.
		const forkTree = await client.request(4, { LoadSessionTree: { session: fork } });
		expect(treeIn(forkTree.frames)?.tree.nodes.map(node => node.id)).toEqual(before.nodes.map(node => node.id));
		const stale = await client.request(5, { LoadSessionTree: { session: source } });
		expect(stale.outcome.RequestFailed?.error.code).toBe("SESSION_NOT_FOUND");
		const reopened = await SessionManager.open(await sourceFile(), undefined, undefined, {
			suppressBreadcrumb: true,
		});
		expect(reopened.getEntries().map(entry => entry.id)).toEqual(Object.values(ids));
	});

	test("a fork or a move under a running turn is refused until the turn ends", async () => {
		const turnStarted = Promise.withResolvers<void>();
		const held = new AssistantMessageEventStream();
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			if (isTitleRequest(context)) return completedStream("Named.");
			const opening = assistantMessage("working on it");
			held.push({ type: "start", partial: { ...opening, content: [] } });
			turnStarted.resolve();
			return held;
		});
		const submitted = await client.request(2, { SubmitPrompt: { session: source, text: "hold the turn open" } });
		expect(submitted.outcome.RequestFailed).toBeUndefined();
		await turnStarted.promise;

		// Forking copies a file the turn is still writing, and moving the leaf
		// rewrites the history the running request is answered from.
		const actions = {
			ForkSession: {},
			NavigateTree: { entry: ids.secondReply, summarize: false, instructions: null },
		};
		let id = 2;
		for (const [action, fields] of Object.entries(actions)) {
			id += 1;
			const refused = await client.request(id, { [action]: { ...fields, session: source } });
			const failure = refused.outcome.RequestFailed?.error;
			expect([action, failure?.code, failure?.retryable]).toEqual([action, "TURN_IN_PROGRESS", true]);
		}
		held.end(assistantMessage("Answered."));
		expect((await loadTree(id + 1)).nodes.some(node => node.id === ids.secondReply && node.on_path)).toBe(false);
	});
});
