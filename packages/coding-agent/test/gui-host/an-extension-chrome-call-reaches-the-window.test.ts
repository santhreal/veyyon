/**
 * WHY: `GuiHostUIContext` accepted `notify`, `setStatus`, `setWorkingMessage`,
 * `setWidget`, `setEditorText` and `pasteToEditor` and dropped them, answered
 * `getEditorText` with an empty string and ignored `addAutocompleteProvider`,
 * so an extension that decorates or edits the session did nothing in a
 * window while the terminal drew and applied every one of those calls.
 *
 * THE CLASS THIS CLOSES: an extension chrome call that never reaches the
 * window, or reaches it with a shape the composer cannot apply. The suite
 * loads a real extension into a real host session over the socket and reads
 * each section off the wire: the `ExtensionUi` view (sanitized, sorted,
 * capped, placed), notices by level, edits by kind and rising `seq`, the
 * draft `getEditorText` reads (reported before the extensions loaded, pasted
 * into at the caret, a stale report dropped, another session's draft not
 * read), completions in UTF-8 byte offsets, a superseded query's answer
 * dropped, a hung source answered empty within its bound, and the chrome
 * following a session reloaded in place and cleared when the session goes.
 *
 * WHAT IT DOES NOT CATCH: the window drawing any of it; the desktop app's
 * composer and thread suites drive the store fields these sections reduce
 * into, and `extension-chrome-edits-and-completions-reach-the-store.rs`
 * drives the reducer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/discovery/capability/fs";
import { getAgentDir } from "@veyyon/utils";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { COMPLETION_TIMEOUT_MS } from "../../src/gui-host/extension-chrome";
import type {
	ComposerCompletionsView,
	ComposerEditView,
	ExtensionNoticeView,
	ExtensionUiView,
} from "../../src/gui-host/wire";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

useIsolatedAgentDir();
const makeTempDir = useTrackedTempDirs("gui-host-extension-chrome-");

/**
 * Sets its chrome when the session starts and offers `:name` completions;
 * each command makes the calls its name says and reports what
 * `getEditorText` read as a notice. A `:slo` query waits until a `:smi` query
 * has answered, so the newer query answers first without a timed delay; a
 * `never` query never answers.
 */
const EXTENSION = `
export default function (api) {
	let releaseSlow = () => {};
	api.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("lint", "\\u001b[31m3   warnings\\u001b[0m");
		ctx.ui.setStatus("build", "ok");
		ctx.ui.setStatus("blank", "\\u001b[1m \\u001b[0m");
		ctx.ui.setWidget("todo", ["one\\ttwo", "\\u001b[1mthree\\u001b[0m\\u0007"], { placement: "belowEditor" });
		ctx.ui.setWidget("long", Array.from({ length: 12 }, (_, index) => "line " + index));
		ctx.ui.addAutocompleteProvider(base => ({
			async getSuggestions(lines, line, column) {
				const before = lines[line].slice(0, column);
				if (before.endsWith("never")) return Promise.withResolvers().promise;
				const match = /:(\\w*)$/.exec(before);
				if (!match) return base.getSuggestions(lines, line, column);
				if (match[1] === "slo") {
					const gate = Promise.withResolvers();
					releaseSlow = gate.resolve;
					await gate.promise;
				}
				if (match[1] === "smi") queueMicrotask(() => releaseSlow());
				return { prefix: match[0], items: [{ value: ":smile:", label: "smile", description: "grin" }] };
			},
			applyCompletion: (lines, line, column, item, prefix) => base.applyCompletion(lines, line, column, item, prefix),
		}));
	});
	const read = (ctx, level) => ctx.ui.notify("draft=[" + ctx.ui.getEditorText() + "]", level);
	api.registerCommand("chrome-read", { handler: async (_args, ctx) => read(ctx, "warning") });
	api.registerCommand("chrome-paste", {
		handler: async (args, ctx) => {
			ctx.ui.pasteToEditor(args);
			read(ctx, "error");
		},
	});
	api.registerCommand("chrome-edit", {
		handler: async (args, ctx) => {
			ctx.ui.setEditorText(args);
			ctx.ui.pasteToEditor("!");
			ctx.ui.pasteToEditor("?");
			read(ctx, "info");
		},
	});
	api.registerCommand("chrome-working", {
		handler: async (args, ctx) => {
			ctx.ui.setWorkingMessage(args || undefined);
			ctx.ui.setStatus("build", undefined);
		},
	});
}
`;

function uiOf(frames: RequestFrame[]) {
	return snapshotSections<{ session: string; ui: ExtensionUiView }>(frames, "ExtensionUi");
}

function noticesOf(frames: RequestFrame[]) {
	return snapshotSections<{ session: string; notice: ExtensionNoticeView }>(frames, "ExtensionNotice");
}

function editsOf(frames: RequestFrame[]) {
	return snapshotSections<{ session: string; edit: ComposerEditView }>(frames, "ComposerEdit");
}

function completionsOf(frames: RequestFrame[]) {
	return snapshotSections<{ session: string; completions: ComposerCompletionsView }>(frames, "ComposerCompletions");
}

/** Send every request at once and read frames until each has its outcome. */
async function requestAll(
	client: TestSocketClient,
	requests: Array<[number, unknown]>,
): Promise<{ frames: RequestFrame[]; outcomes: Map<number, RequestFrame> }> {
	for (const [id, action] of requests) client.send({ id, action });
	const frames: RequestFrame[] = [];
	const outcomes = new Map<number, RequestFrame>();
	while (outcomes.size < requests.length) {
		const frame = (await client.nextFrame()) as RequestFrame;
		frames.push(frame);
		const settled = frame.RequestSucceeded?.request ?? frame.RequestFailed?.request;
		if (settled !== undefined) outcomes.set(settled, frame);
	}
	return { frames, outcomes };
}

describe("an extension chrome call reaches the window", () => {
	let server: GuiHostServer | undefined;
	let client: TestSocketClient;
	let session: string;
	let nextId = 1;

	async function send(action: unknown): Promise<{ frames: RequestFrame[]; outcome: RequestFrame }> {
		const id = nextId++;
		return await client.request(id, action);
	}

	async function run(text: string): Promise<RequestFrame[]> {
		const result = await send({ RunCommand: { session, text } });
		expect(result.outcome).toEqual({ RequestSucceeded: { request: nextId - 1 } });
		return result.frames;
	}

	/** The draft `getEditorText` read, as the `chrome-read` notice states it. */
	async function readDraft(): Promise<string | undefined> {
		return noticesOf(await run("chrome-read")).at(-1)?.notice.message;
	}

	function report(text: string, cursor: number, appliedEdit: number, target = session) {
		return send({ ReportComposerDraft: { session: target, text, cursor, applied_edit: appliedEdit } });
	}

	beforeEach(async () => {
		const workspace = makeTempDir();
		const profile = getAgentDir();
		await fs.mkdir(path.join(profile, "extensions"), { recursive: true });
		await fs.writeFile(path.join(profile, "extensions", "chrome.ts"), EXTENSION);
		clearFsCache();
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: workspace, agentDir: profile });
		client = await TestSocketClient.connect(server.endpoint);
		nextId = 1;
		const created = await send({ CreateSession: {} });
		const active = snapshotSections<{ value: { id: string } }>(created.frames, "ActiveSession").at(-1);
		if (!active) throw new Error("CreateSession stated no ActiveSession");
		session = active.value.id;
	});

	afterEach(async () => {
		client.destroy();
		await server?.close();
		server = undefined;
	});

	test("the chrome an extension sets is stated sanitized, sorted, capped and placed", async () => {
		const frames = await run("chrome-working Indexing the \u001b[2mworkspace\u001b[0m");
		const loaded = uiOf(frames).filter(each => each.session === session);
		// The view as `session_start` left it: the last one before the command
		// set a working message.
		const started = loaded.findLast(each => each.ui.working_message === null)?.ui;
		expect(started?.statuses).toEqual([
			{ key: "build", text: "ok" },
			{ key: "lint", text: "3 warnings" },
		]);
		expect(started?.working_message).toBeNull();
		expect(started?.completes).toBe(true);
		const [todo, long] = started?.widgets ?? [];
		expect(todo?.key).toBe("todo");
		expect(todo?.placement).toBe("BelowEditor");
		expect(todo?.truncated).toBe(false);
		expect(todo?.lines[0]).toMatch(/^one +two$/);
		expect(todo?.lines[1]).toBe("three ");
		expect(long?.placement).toBe("AboveEditor");
		expect(long?.lines).toEqual(Array.from({ length: 10 }, (_, index) => `line ${index}`));
		expect(long?.truncated).toBe(true);

		const working = loaded.at(-1)?.ui;
		expect(working?.working_message).toBe("Indexing the workspace");
		expect(working?.statuses).toEqual([{ key: "lint", text: "3 warnings" }]);
	}, 15_000);

	test("a notice is raised at the level the extension named", async () => {
		const notices = [
			...noticesOf(await run("chrome-read")),
			...noticesOf(await run("chrome-paste x")),
			...noticesOf(await run("chrome-edit y")),
		];
		expect(notices.map(each => [each.session, each.notice.level])).toEqual([
			[session, "Warning"],
			[session, "Error"],
			[session, "Info"],
		]);
	}, 15_000);

	test("a draft reported before the extensions load is the one they read, and a paste lands at its caret", async () => {
		expect((await report("héllo", Buffer.byteLength("hé"), 0)).outcome.RequestSucceeded).toBeDefined();
		const frames = await run("chrome-paste X");
		expect(noticesOf(frames).at(-1)?.notice.message).toBe("draft=[héXllo]");
		expect(editsOf(frames)).toEqual([{ session, edit: { seq: 1, kind: "Paste", text: "X" } }]);
	}, 15_000);

	test("edits are numbered as they are made, and a report that predates one is dropped", async () => {
		const frames = await run("chrome-edit base");
		expect(editsOf(frames).map(each => each.edit)).toEqual([
			{ seq: 1, kind: "Set", text: "base" },
			{ seq: 2, kind: "Paste", text: "!" },
			{ seq: 3, kind: "Paste", text: "?" },
		]);
		expect(noticesOf(frames).at(-1)?.notice.message).toBe("draft=[base!?]");

		expect((await report("typed before the edits", 0, 2)).outcome.RequestSucceeded).toBeDefined();
		expect(await readDraft()).toBe("draft=[base!?]");

		expect((await report("base!? and more", 3, 3)).outcome.RequestSucceeded).toBeDefined();
		expect(await readDraft()).toBe("draft=[base!? and more]");
	}, 15_000);

	test("a report for another session is taken without effect", async () => {
		await report("mine", 4, 0);
		const other = await report("theirs", 6, 0, "some-other-session");
		expect(other.outcome.RequestSucceeded).toBeDefined();
		expect(await readDraft()).toBe("draft=[mine]");
	}, 15_000);

	test("a cursor inside a character is refused with the reason", async () => {
		const reported = await report("é", 1, 0);
		expect(reported.outcome.RequestFailed?.error).toMatchObject({
			scope: "Extension",
			code: "INVALID_ARGUMENTS",
			retryable: false,
		});
		await run("chrome-read");
		const completed = await send({ CompleteComposer: { session, query: 1, text: "é", cursor: 1 } });
		expect(completed.outcome.RequestFailed?.error).toMatchObject({ scope: "Extension", code: "INVALID_ARGUMENTS" });
		expect(completionsOf(completed.frames)).toEqual([]);
	}, 15_000);

	test("a completion is stated as the byte range it replaces and where the caret lands", async () => {
		await run("chrome-read");
		const text = "é :smi";
		const completed = await send({
			CompleteComposer: { session, query: 1, text, cursor: Buffer.byteLength(text) },
		});
		expect(completed.outcome.RequestSucceeded).toBeDefined();
		expect(completionsOf(completed.frames)).toEqual([
			{
				session,
				completions: {
					query: 1,
					items: [
						{
							label: "smile",
							description: "grin",
							replace_start: Buffer.byteLength(text),
							replace_end: Buffer.byteLength(text),
							insert: "le:",
							caret: Buffer.byteLength("é :smile:"),
						},
					],
				},
			},
		]);
	}, 15_000);

	test("the answer to a query a newer one superseded is not sent", async () => {
		await run("chrome-read");
		const { frames, outcomes } = await requestAll(client, [
			[100, { CompleteComposer: { session, query: 7, text: ":slo", cursor: 4 } }],
			[101, { CompleteComposer: { session, query: 8, text: ":smi", cursor: 4 } }],
		]);
		expect(outcomes.get(100)?.RequestSucceeded).toBeDefined();
		expect(outcomes.get(101)?.RequestSucceeded).toBeDefined();
		expect(completionsOf(frames).map(each => each.completions.query)).toEqual([8]);
	}, 15_000);

	// Real time: the bound is the host's own timer racing an extension that
	// never settles, in a host driven over a socket, so there is no fake clock
	// to advance; the assertion is the bound itself.
	test("a source that never answers is answered empty within its bound", async () => {
		await run("chrome-read");
		const started = performance.now();
		const completed = await send({ CompleteComposer: { session, query: 1, text: "never", cursor: 5 } });
		const elapsed = performance.now() - started;
		expect(completed.outcome.RequestSucceeded).toBeDefined();
		expect(completionsOf(completed.frames)).toEqual([{ session, completions: { query: 1, items: [] } }]);
		expect(elapsed).toBeGreaterThanOrEqual(COMPLETION_TIMEOUT_MS - 50);
		expect(elapsed).toBeLessThan(COMPLETION_TIMEOUT_MS + 3_000);
	}, 15_000);

	test("a completion asked for a session whose extensions are not loaded here is answered empty", async () => {
		const completed = await send({
			CompleteComposer: { session: "some-other-session", query: 1, text: ":smi", cursor: 4 },
		});
		expect(completed.outcome.RequestSucceeded).toBeDefined();
		expect(completionsOf(completed.frames)).toEqual([
			{ session: "some-other-session", completions: { query: 1, items: [] } },
		]);
	}, 15_000);

	test("the chrome follows a session reloaded in place and leaves with the session", async () => {
		await report("first session's draft", 0, 0);
		await run("chrome-read");
		const created = await send({ CreateSession: {} });
		const moved = snapshotSections<{ value: { id: string } }>(created.frames, "ActiveSession").at(-1)?.value.id;
		if (moved === undefined) throw new Error("CreateSession stated no ActiveSession");
		expect(moved).not.toBe(session);
		const restated = uiOf(created.frames);
		expect(restated.map(each => [each.session, each.ui.statuses.map(status => status.key)])).toEqual([
			[session, []],
			[moved, ["build", "lint"]],
		]);
		session = moved;
		expect(await readDraft()).toBe("draft=[]");

		const deleted = await send({ DeleteSession: { session } });
		expect(deleted.outcome.RequestSucceeded).toBeDefined();
		expect(uiOf(deleted.frames)).toEqual([
			{ session, ui: { statuses: [], working_message: null, widgets: [], completes: false } },
		]);
	}, 15_000);
});
