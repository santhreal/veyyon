/**
 * WHY:
 *
 * A desktop client has no terminal, so every question the engine asks the
 * operator — a tool approval, an `ask` question, an extension prompt, a plan
 * review — has to cross the socket as a `Snapshot.Interactions` section and
 * come back as `RespondToInteraction`. Before this seam existed the session
 * was created with no UI and a tool that needed approval failed headless.
 *
 * This suite defends, against the real `ExtensionUIContext` contract and a
 * real socket:
 * 1. Each prompting method raises one record of the right kind, and the frame
 *    carries the whole pending set, so the client replaces rather than merges.
 * 2. An answer of the right shape settles the caller with the value the
 *    terminal would have produced (the wrapper's label, the option's label,
 *    the text, the boolean); one of the wrong shape or for an unknown id is
 *    rejected and leaves the decision open.
 * 3. Abort, timeout and `cancelAll` each settle the caller with its default
 *    and take the record down, within the bound they were given.
 *
 * What it does NOT catch: the tool wrapper's own handling of the label it gets
 * back, and the desktop's rendering of the card.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { APPROVAL_SELECT_OPTIONS } from "../../src/extensibility/extensions/wrapper";
import { GuiHostUIContext, InteractionLedger } from "../../src/gui-host/interactions";
import type { PendingDecisions } from "../../src/gui-host/wire";

interface InteractionsFrame {
	Snapshot: { Interactions: { session: string; pending: PendingDecisions } };
}

class FrameSink {
	#buffer = "";
	readonly frames: InteractionsFrame[] = [];
	#waiters: Array<(frame: InteractionsFrame) => void> = [];

	constructor(socket: net.Socket) {
		socket.on("data", chunk => {
			this.#buffer += chunk.toString("utf8");
			let newline = this.#buffer.indexOf("\n");
			while (newline !== -1) {
				const line = this.#buffer.slice(0, newline);
				this.#buffer = this.#buffer.slice(newline + 1);
				const frame = JSON.parse(line) as InteractionsFrame;
				const waiter = this.#waiters.shift();
				if (waiter) waiter(frame);
				else this.frames.push(frame);
				newline = this.#buffer.indexOf("\n");
			}
		});
	}

	next(): Promise<InteractionsFrame> {
		const queued = this.frames.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<InteractionsFrame>();
		this.#waiters.push(resolve);
		return promise;
	}
}

let server: net.Server;
let hostSide: net.Socket;
let clientSide: net.Socket;
let sink: FrameSink;
let ledger: InteractionLedger;
let ui: GuiHostUIContext;

beforeEach(async () => {
	const { promise: accepted, resolve: onAccept } = Promise.withResolvers<net.Socket>();
	server = net.createServer(onAccept);
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as net.AddressInfo;
	clientSide = net.connect(address.port, "127.0.0.1");
	await new Promise<void>(resolve => clientSide.once("connect", resolve));
	hostSide = await accepted;
	sink = new FrameSink(clientSide);
	ledger = new InteractionLedger(hostSide, () => "session-1");
	ui = new GuiHostUIContext(ledger);
});

afterEach(async () => {
	ledger.cancelAll();
	hostSide.destroy();
	clientSide.destroy();
	await new Promise<void>(resolve => server.close(() => resolve()));
});

const APPROVAL_CARD = [
	"## Permission required",
	"**Tool:** `bash`",
	"**Scope:** This call only",
	"",
	"**Requested action**",
	"rm -rf build",
].join("\n");

describe("raising a decision", () => {
	test("a wrapper approval card becomes an approval record naming the tool, and the answer maps to the wrapper's label", async () => {
		const pending = ui.select(APPROVAL_CARD, APPROVAL_SELECT_OPTIONS, { selectionMarker: "radio" });
		const raised = await sink.next();
		expect(raised.Snapshot.Interactions.session).toBe("session-1");
		const [approval] = raised.Snapshot.Interactions.pending.approvals;
		expect(approval.tool_name).toBe("bash");
		expect(approval.detail).toContain("rm -rf build");
		expect(approval.detail).not.toContain("Permission required");
		expect(raised.Snapshot.Interactions.pending.questions).toEqual([]);

		expect(ledger.answer(approval.id, { approved: true, scope: "session" })).toBeUndefined();
		expect(await pending).toBe("Approve for session");
		const settled = await sink.next();
		expect(settled.Snapshot.Interactions.pending).toEqual({ approvals: [], questions: [], plans: [] });
	});

	test("every approval answer maps to the wrapper's own label", async () => {
		const answers: Array<[{ approved: boolean; scope?: "once" | "session" }, string]> = [
			[{ approved: true }, "Approve"],
			[{ approved: true, scope: "once" }, "Approve"],
			[{ approved: false }, "Deny"],
			[{ approved: false, scope: "session" }, "Deny for session"],
		];
		for (const [answer, label] of answers) {
			const pending = ui.select(APPROVAL_CARD, APPROVAL_SELECT_OPTIONS);
			const raised = await sink.next();
			ledger.answer(raised.Snapshot.Interactions.pending.approvals[0].id, answer);
			expect(await pending).toBe(label);
			await sink.next();
		}
	});

	test("any other select is a question whose options are the labels, answered by index", async () => {
		const pending = ui.select("Which?", ["left", { label: "right", description: "the other one" }]);
		const raised = await sink.next();
		const [question] = raised.Snapshot.Interactions.pending.questions;
		expect(question.prompt).toBe("Which?");
		expect(question.options).toEqual(["left", "right"]);

		expect(ledger.answer(question.id, { option: 1 })).toBeUndefined();
		expect(await pending).toBe("right");
	});

	test("input and editor are free-text questions with no options, answered with text", async () => {
		const typed = ui.input("Name it", "a short name");
		const raisedInput = await sink.next();
		const [asked] = raisedInput.Snapshot.Interactions.pending.questions;
		expect(asked.options).toEqual([]);
		expect(asked.prompt).toContain("Name it");
		ledger.answer(asked.id, { text: "widget" });
		expect(await typed).toBe("widget");
		await sink.next();

		const edited = ui.editor("Edit", "draft");
		const raisedEditor = await sink.next();
		const [draft] = raisedEditor.Snapshot.Interactions.pending.questions;
		expect(draft.prompt).toContain("draft");
		ledger.answer(draft.id, { text: "final" });
		expect(await edited).toBe("final");
	});

	test("confirm is a yes/no question and resolves true only for the first option", async () => {
		const yes = ui.confirm("Overwrite?", "The file exists");
		const raisedYes = await sink.next();
		const [ask] = raisedYes.Snapshot.Interactions.pending.questions;
		expect(ask.options).toEqual(["Yes", "No"]);
		ledger.answer(ask.id, { option: 0 });
		expect(await yes).toBe(true);
		await sink.next();

		const no = ui.confirm("Overwrite?", "The file exists");
		const raisedNo = await sink.next();
		ledger.answer(raisedNo.Snapshot.Interactions.pending.questions[0].id, { option: 1 });
		expect(await no).toBe(false);
	});

	test("a plan carries its markdown and resolves the acceptance", async () => {
		const review = ledger.plan("# Ship it\n- step");
		const raised = await sink.next();
		const [plan] = raised.Snapshot.Interactions.pending.plans;
		expect(plan.markdown_plan).toBe("# Ship it\n- step");
		ledger.answer(plan.id, { accepted: true });
		expect(await review).toBe(true);
	});

	test("the frame carries every open decision, so two prompts are one set", async () => {
		const first = ui.select(APPROVAL_CARD, APPROVAL_SELECT_OPTIONS);
		await sink.next();
		const second = ui.select("Which?", ["a", "b"]);
		const both = await sink.next();
		expect(both.Snapshot.Interactions.pending.approvals).toHaveLength(1);
		expect(both.Snapshot.Interactions.pending.questions).toHaveLength(1);

		ledger.answer(both.Snapshot.Interactions.pending.questions[0].id, { option: 0 });
		const oneLeft = await sink.next();
		expect(oneLeft.Snapshot.Interactions.pending.approvals).toHaveLength(1);
		expect(oneLeft.Snapshot.Interactions.pending.questions).toHaveLength(0);
		expect(await second).toBe("a");

		ledger.answer(oneLeft.Snapshot.Interactions.pending.approvals[0].id, { approved: false });
		expect(await first).toBe("Deny");
	});
});

describe("rejecting an answer", () => {
	test("an unknown id is not found", () => {
		expect(ledger.answer("approval-99", { approved: true })).toEqual({
			code: "INTERACTION_NOT_FOUND",
			message: "No pending interaction with id 'approval-99'",
		});
	});

	test("a wrong-shaped answer leaves the decision open until the right one arrives", async () => {
		const pending = ui.select("Which?", ["a", "b"]);
		const raised = await sink.next();
		const id = raised.Snapshot.Interactions.pending.questions[0].id;

		expect(ledger.answer(id, { approved: true })?.code).toBe("INVALID_ARGUMENTS");
		expect(ledger.answer(id, { option: 7 })?.code).toBe("INVALID_ARGUMENTS");
		expect(ledger.answer(id, { option: "0" })?.code).toBe("INVALID_ARGUMENTS");
		expect(ledger.answer(id, "b")?.code).toBe("INVALID_ARGUMENTS");
		expect(ledger.answer(id, { text: "b" })?.code).toBe("INVALID_ARGUMENTS");
		expect(ledger.isEmpty).toBe(false);

		expect(ledger.answer(id, { option: 1 })).toBeUndefined();
		expect(await pending).toBe("b");
		expect(ledger.answer(id, { option: 1 })?.code).toBe("INTERACTION_NOT_FOUND");
	});

	test("an approval answered as anything but { approved } stays open", async () => {
		const pending = ui.select(APPROVAL_CARD, APPROVAL_SELECT_OPTIONS);
		const raised = await sink.next();
		const id = raised.Snapshot.Interactions.pending.approvals[0].id;
		expect(ledger.answer(id, { option: 0 })?.code).toBe("INVALID_ARGUMENTS");
		expect(ledger.answer(id, { approved: "yes" })?.code).toBe("INVALID_ARGUMENTS");
		ledger.answer(id, { approved: true });
		expect(await pending).toBe("Approve");
	});
});

describe("settling without an answer", () => {
	test("an aborted signal resolves the caller's default and takes the record down", async () => {
		const controller = new AbortController();
		const pending = ui.select("Which?", ["a"], { signal: controller.signal });
		await sink.next();
		controller.abort();
		expect(await pending).toBeUndefined();
		const cleared = await sink.next();
		expect(cleared.Snapshot.Interactions.pending.questions).toEqual([]);
		expect(ledger.isEmpty).toBe(true);
	});

	test("an already-aborted signal raises nothing", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await ui.confirm("?", "", { signal: controller.signal })).toBe(false);
		expect(ledger.isEmpty).toBe(true);
		expect(sink.frames).toEqual([]);
	});

	test("a timeout settles within its bound, reports it, and clears", async () => {
		let timedOut = 0;
		const started = Date.now();
		const pending = ui.select("Which?", ["a"], { timeout: 40, onTimeout: () => timedOut++ });
		await sink.next();
		expect(await pending).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(2000);
		expect(timedOut).toBe(1);
		expect(ledger.isEmpty).toBe(true);
	});

	test("cancelAll settles every open decision with its own default", async () => {
		const approval = ui.select(APPROVAL_CARD, APPROVAL_SELECT_OPTIONS);
		const confirm = ui.confirm("?", "");
		const text = ui.input("Name");
		const plan = ledger.plan("# p");
		await sink.next();
		await sink.next();
		await sink.next();
		await sink.next();

		ledger.cancelAll();

		expect(await approval).toBeUndefined();
		expect(await confirm).toBe(false);
		expect(await text).toBeUndefined();
		expect(await plan).toBe(false);
		expect(ledger.isEmpty).toBe(true);
		expect(ledger.pending()).toEqual({ approvals: [], questions: [], plans: [] });
	});
});
