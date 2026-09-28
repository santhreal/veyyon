/**
 * WHY: the `ask` tool raises its questions through `askDialog` when the UI
 * surface offers it, and falls back to one plain question per prompt when it
 * does not, dropping option descriptions, previews, the recommendation,
 * multi-select and the "chat about this" exit. The desktop context did not
 * offer it, so every desktop `ask` was the degraded one.
 *
 * THE CLASS THIS CLOSES: a dialog whose content or answer is lost crossing
 * the socket. The suite drives `GuiHostUIContext.askDialog` over a real socket
 * and checks that the `Interactions` frame carries every field the terminal
 * dialog draws, that each answer shape settles the caller with the result the
 * terminal dialog produces, that a malformed answer is rejected and leaves
 * the dialog open, and that abort and timeout settle it within their bound.
 *
 * WHAT IT DOES NOT CATCH: the window drawing the dialog; the desktop app's
 * suites drive the dock.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import type { ExtensionAskDialogQuestion } from "../../src/extensibility/extensions/types";
import { GuiHostUIContext, InteractionLedger } from "../../src/gui-host/interactions";
import type { PendingDecisions } from "../../src/gui-host/wire";

interface InteractionsFrame {
	Snapshot: { Interactions: { session: string; pending: PendingDecisions } };
}

let server: net.Server;
let hostSide: net.Socket;
let clientSide: net.Socket;
let frames: InteractionsFrame[];
let waiters: Array<(frame: InteractionsFrame) => void>;
let ledger: InteractionLedger;
let ui: GuiHostUIContext;

function nextFrame(): Promise<InteractionsFrame> {
	const queued = frames.shift();
	if (queued) return Promise.resolve(queued);
	const { promise, resolve } = Promise.withResolvers<InteractionsFrame>();
	waiters.push(resolve);
	return promise;
}

beforeEach(async () => {
	const { promise: accepted, resolve: onAccept } = Promise.withResolvers<net.Socket>();
	server = net.createServer(onAccept);
	const { promise: listening, resolve: onListen } = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", onListen);
	await listening;
	const address = server.address() as net.AddressInfo;
	clientSide = net.connect(address.port, "127.0.0.1");
	hostSide = await accepted;
	frames = [];
	waiters = [];
	let buffer = "";
	clientSide.on("data", chunk => {
		buffer += chunk.toString("utf8");
		for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
			const frame = JSON.parse(buffer.slice(0, newline)) as InteractionsFrame;
			buffer = buffer.slice(newline + 1);
			const waiter = waiters.shift();
			if (waiter) waiter(frame);
			else frames.push(frame);
		}
	});
	ledger = new InteractionLedger(hostSide, () => "session-1");
	ui = new GuiHostUIContext(ledger);
});

afterEach(async () => {
	ledger.cancelAll();
	hostSide.destroy();
	clientSide.destroy();
	const { promise, resolve } = Promise.withResolvers<void>();
	server.close(() => resolve());
	await promise;
});

const QUESTIONS: ExtensionAskDialogQuestion[] = [
	{
		id: "db",
		question: "Which database?",
		header: "Database",
		options: [
			{ label: "SQLite", description: "One file" },
			{ label: "Postgres", preview: "docker run postgres" },
		],
		recommended: 1,
	},
	{
		id: "features",
		question: "Which features?",
		options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
		multi: true,
		preselected: ["Billing", "Missing"],
	},
];

const EMPTY: PendingDecisions = { approvals: [], questions: [], plans: [], dialogs: [] };

async function raise(timeout?: number) {
	const result = ui.askDialog(QUESTIONS, timeout === undefined ? undefined : { timeout });
	const frame = await nextFrame();
	const [dialog] = frame.Snapshot.Interactions.pending.dialogs;
	return { result, dialog };
}

describe("a multi-question dialog on the desktop", () => {
	test("the frame carries every field the terminal dialog draws", async () => {
		const before = Date.now();
		const { dialog } = await raise(30_000);
		expect(dialog.questions).toEqual([
			{
				id: "db",
				question: "Which database?",
				header: "Database",
				options: [
					{ label: "SQLite", description: "One file" },
					{ label: "Postgres", preview: "docker run postgres" },
				],
				multi: false,
				recommended: 1,
				preselected: [],
			},
			{
				id: "features",
				question: "Which features?",
				options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }],
				multi: true,
				preselected: [1],
			},
		]);
		expect(dialog.expires_at_ms).toBe(dialog.requested_at_ms + 30_000);
		expect(dialog.requested_at_ms).toBeGreaterThanOrEqual(before);
	});

	test("a submitted answer settles with the terminal dialog's result and takes the dialog down", async () => {
		const { result, dialog } = await raise();
		const answer = {
			kind: "submit",
			answers: [
				{ id: "features", selected: [0, 2], note: "later" },
				{ id: "db", selected: [], custom_input: "MySQL" },
			],
		};
		expect(ledger.answer(dialog.id, answer)).toBeUndefined();
		expect(await result).toEqual({
			kind: "submit",
			results: [
				{
					id: "db",
					question: "Which database?",
					options: ["SQLite", "Postgres"],
					multi: false,
					selectedOptions: [],
					customInput: "MySQL",
				},
				{
					id: "features",
					question: "Which features?",
					options: ["Auth", "Billing", "Search"],
					multi: true,
					selectedOptions: ["Auth", "Search"],
					note: "later",
				},
			],
		});
		expect((await nextFrame()).Snapshot.Interactions.pending).toEqual(EMPTY);
	});

	test("choosing to chat settles with the chat result", async () => {
		const { result, dialog } = await raise();
		expect(ledger.answer(dialog.id, { kind: "chat" })).toBeUndefined();
		expect(await result).toEqual({ kind: "chat" });
	});

	test("a malformed answer is rejected and the dialog stays open for a good one", async () => {
		const { result, dialog } = await raise();
		const selectedBoth = [
			{ id: "db", selected: [0, 1] },
			{ id: "features", selected: [0] },
		];
		const rejected: Array<[unknown, string]> = [
			[{ option: 0 }, "a dialog is answered with"],
			[{ kind: "submit", answers: [{ id: "db", selected: [0] }] }, "question 'features' has no answer"],
			[{ kind: "submit", answers: selectedBoth }, "question 'db' takes one option, 2 were selected"],
			[
				{
					kind: "submit",
					answers: [
						{ id: "db", selected: [5] },
						{ id: "features", selected: [0] },
					],
				},
				"option 5 of question 'db' is out of range (2 options)",
			],
			[
				{
					kind: "submit",
					answers: [
						{ id: "db", selected: [] },
						{ id: "features", selected: [0] },
					],
				},
				"question 'db' needs a selected option or custom_input",
			],
		];
		for (const [answer, message] of rejected) {
			const rejection = ledger.answer(dialog.id, answer);
			expect(rejection?.code).toBe("INVALID_ARGUMENTS");
			expect(rejection?.message).toContain(message);
		}
		expect(ledger.pending().dialogs.map(open => open.id)).toEqual([dialog.id]);
		const good = {
			kind: "submit",
			answers: [
				{ id: "db", selected: [1] },
				{ id: "features", selected: [], custom_input: "none" },
			],
		};
		expect(ledger.answer(dialog.id, good)).toBeUndefined();
		expect((await result)?.kind).toBe("submit");
	});

	test("a timeout settles every question on its recommended option, within the bound", async () => {
		const started = Date.now();
		const { result } = await raise(40);
		expect(await result).toEqual({
			kind: "submit",
			results: [
				{
					id: "db",
					question: "Which database?",
					options: ["SQLite", "Postgres"],
					multi: false,
					selectedOptions: ["Postgres"],
					timedOut: true,
				},
				{
					id: "features",
					question: "Which features?",
					options: ["Auth", "Billing", "Search"],
					multi: true,
					selectedOptions: [],
					timedOut: true,
				},
			],
		});
		expect(Date.now() - started).toBeLessThan(2_000);
		expect((await nextFrame()).Snapshot.Interactions.pending).toEqual(EMPTY);
	});

	test("an abort settles the caller with no result and takes the dialog down", async () => {
		const controller = new AbortController();
		const result = ui.askDialog(QUESTIONS, { signal: controller.signal });
		await nextFrame();
		controller.abort();
		expect(await result).toBeUndefined();
		expect((await nextFrame()).Snapshot.Interactions.pending).toEqual(EMPTY);
	});
});
