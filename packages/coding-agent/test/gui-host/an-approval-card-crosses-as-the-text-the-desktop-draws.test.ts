/**
 * WHY:
 *
 * `formatApprovalCard` writes the permission card in markdown, for the
 * terminal's renderer. The desktop has no markdown renderer: it draws each
 * line of `ApprovalInteraction.detail` into a mono pane verbatim, and the run
 * bar draws one of them beside the tool name. So the card read
 * `**Scope:** This call only` with the emphasis markers as text.
 *
 * The class closed here is a marker the wrapper authored for the terminal
 * crossing the wire into a surface that draws text. It is closed at the
 * projection, and the suite drives the real card formatter so a label added to
 * the card is covered without being restated here.
 *
 * This suite defends:
 * 1. No line of a projected detail carries markdown emphasis, for a card built
 *    through every branch the formatter has: scope, MCP origin, reason,
 *    requester and detail lines.
 * 2. Each of the wrapper's own labels keeps its text and its value, so the card
 *    still states the scope, the origin, the reason and who asked.
 * 3. The tool's own detail line crosses byte-identical, backticks and all,
 *    because it states the command about to run and an approval that shows
 *    anything else is worse than an ugly one.
 * 4. The heading and the tool line are absent, because the card draws the tool
 *    name in its own ramp and the pane would repeat it.
 *
 * What it does NOT catch: the desktop's own flattening of a plan's
 * `markdown_plan`, which stays markdown by contract and is covered by
 * `crates/veyyon-desktop/tests/a-decision-card-draws-text-and-never-the-markdown-it-arrived-in.rs`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { APPROVAL_SELECT_OPTIONS } from "../../src/extensibility/extensions/wrapper";
import { approvalDetail, GuiHostUIContext, InteractionLedger } from "../../src/gui-host/interactions";
import type { PendingDecisions } from "../../src/gui-host/wire";
import { formatApprovalCard } from "../../src/tools/core/approval";

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

/** The next frame the host writes, decoded. A frame ends at a newline. */
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
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as net.AddressInfo;
	clientSide = net.connect(address.port, "127.0.0.1");
	await new Promise<void>(resolve => clientSide.once("connect", resolve));
	hostSide = await accepted;
	frames = [];
	waiters = [];
	let buffer = "";
	clientSide.on("data", chunk => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const frame = JSON.parse(buffer.slice(0, newline)) as InteractionsFrame;
			buffer = buffer.slice(newline + 1);
			const waiter = waiters.shift();
			if (waiter) waiter(frame);
			else frames.push(frame);
			newline = buffer.indexOf("\n");
		}
	});
	ledger = new InteractionLedger(hostSide, () => "session-1");
	ui = new GuiHostUIContext(ledger);
});

afterEach(async () => {
	ledger.cancelAll();
	hostSide.destroy();
	clientSide.destroy();
	await new Promise<void>(resolve => server.close(() => resolve()));
});

/** A tool as the approval formatter reads one. */
function subject(name: string, details: string[]): Parameters<typeof formatApprovalCard>[0] {
	return { name, approval: undefined, formatApprovalDetails: () => details };
}

/** The command line a bash approval carries, with its own backticks. */
const COMMAND_LINE = "Command: rm -rf `pwd`/build";

describe("the detail an approval card crosses as", () => {
	test("carries no markdown emphasis on any line the formatter can author", async () => {
		const card = formatApprovalCard(
			subject("mcp__deploy__run", [COMMAND_LINE, "Target: `production`"]),
			{},
			"the tier this call resolved to needs an answer",
			"DeployLane",
		);
		expect(card).toContain("**Scope:**");

		const pending = ui.select(card, APPROVAL_SELECT_OPTIONS, { selectionMarker: "radio" });
		const [approval] = (await nextFrame()).Snapshot.Interactions.pending.approvals;
		expect(approval.tool_name).toBe("mcp__deploy__run");
		for (const line of approval.detail.split("\n")) {
			expect(line).not.toContain("**");
			expect(line.startsWith("## ")).toBe(false);
		}

		ledger.answer(approval.id, { approved: false, scope: "once" });
		await pending;
	});

	test("keeps every label the wrapper writes, with its value", () => {
		const detail = approvalDetail(
			formatApprovalCard(
				subject("mcp__deploy__run", [COMMAND_LINE]),
				{},
				"the tier this call resolved to needs an answer",
				"DeployLane",
			),
		);
		expect(detail.split("\n")).toEqual([
			"Requested by: DeployLane",
			"Scope: This call only",
			"Origin: MCP server tool",
			"Reason: the tier this call resolved to needs an answer",
			"",
			"Requested action",
			COMMAND_LINE,
		]);
	});

	test("crosses a tool's own detail line byte-identical", () => {
		const detail = approvalDetail(formatApprovalCard(subject("bash", [COMMAND_LINE]), {}));
		expect(detail.split("\n")).toEqual(["Scope: This call only", "", "Requested action", COMMAND_LINE]);
	});

	test("drops the heading and the tool line the card draws in its own ramp", () => {
		const detail = approvalDetail(formatApprovalCard(subject("read", ["Path: src/app.ts"]), {}));
		expect(detail).not.toContain("Permission required");
		expect(detail).not.toContain("Tool:");
		expect(detail).not.toContain("read");
	});

	test("states a label with no value as the label alone", () => {
		expect(approvalDetail("**Reason:**")).toBe("Reason:");
	});
});
