/**
 * What an irc card shows, for any host.
 *
 * The tool half in `irc.ts` decides what was delivered, who answered and which peers are alive;
 * this half states what the card says about them and names no colour, no glyph and no width. A
 * direction is a word rather than an arrow, a peer's state is a symbol key the host resolves, and
 * every hold-back is a count the host words: a terminal draws the arrow it always drew from its own
 * tables and a browser draws a chip beside the same peer.
 */

import { formatAge, formatDuration } from "@veyyon/utils";
import type {
	FramedBlockView,
	StatusRowView,
	ToolViewContext,
	ToolViewRenderer,
	ViewHiddenCount,
	ViewLine,
	ViewSection,
	ViewSpan,
	ViewStatus,
	ViewTone,
} from "@veyyon/view";
import type { IrcDeliveryReceipt } from "../../task/irc-bus";
import { Ellipsis, getPreviewLines, PREVIEW_LIMITS, replaceTabs, sanitizeErrorText } from "../core/render-utils";
import type { IrcDetails, IrcParams } from "./irc";

/** The arguments the card reads off the call, which are the ones the model sends. */
export type IrcViewArgs = Partial<IrcParams>;

/** The result the card reads, which is the tool's own result narrowed to what a card shows. */
export interface IrcViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: IrcDetails;
	isError?: boolean;
}

/** Rows of a message body a collapsed card spends before it says how many it kept back. */
const BODY_LINES_COLLAPSED = 2;
/** Rows of a message body an expanded card spends, which is the whole of a short message. */
const BODY_LINES_EXPANDED = 12;
/** The columns a body line is cut to, which bounds a pasted paragraph before any host sees it. */
const BODY_LINE_WIDTH = 100;

const LINE_NOUN = { one: "line", many: "lines" } as const;
const RECIPIENT_NOUN = { one: "recipient", many: "recipients" } as const;
const MESSAGE_NOUN = { one: "message", many: "messages" } as const;
const PEER_NOUN = { one: "peer", many: "peers" } as const;

/** The order a roster reads in: who is working, then who is waiting, then who is parked. */
const PEER_STATUS_ORDER: Record<string, number> = { running: 0, idle: 1, parked: 2 };

/** The symbol key and tone a peer's state draws as, which the host resolves from its own registry. */
const PEER_STATUS_MARKS: Record<string, { symbol: string; tone: ViewTone }> = {
	running: { symbol: "status.running", tone: "accent" },
	idle: { symbol: "status.enabled", tone: "success" },
	parked: { symbol: "status.shadowed", tone: "muted" },
};

function outcomeTone(outcome: IrcDeliveryReceipt["outcome"]): ViewTone {
	switch (outcome) {
		case "woken":
			return "success";
		case "revived":
			return "warning";
		case "injected":
			return "accent";
		case "failed":
			return "error";
	}
}

/** A peer's state as its mark and the word for it, which a host draws from one tone. */
function peerStatusSpans(status: string): ViewSpan[] {
	const mark = PEER_STATUS_MARKS[status] ?? { symbol: "status.aborted", tone: "error" as const };
	return [
		{ text: "", symbol: mark.symbol, tone: mark.tone },
		{ text: ` ${status}`, tone: mark.tone },
	];
}

/** How long ago a message landed, or nothing for a message that carries no timestamp. */
function messageAge(ts: number | undefined): string {
	if (!ts) return "";
	return formatAge(Math.max(1, Math.round((Date.now() - ts) / 1000)));
}

function textContent(result: Pick<IrcViewResult, "content">): string {
	return result.content.find(part => part.type === "text")?.text?.trim() ?? "";
}

/** A failure message as its own rows, each carrying the indent and the tone rather than sharing one. */
function errorLines(text: string): ViewLine[] {
	return sanitizeErrorText(text)
		.split("\n")
		.map(line => [{ text: "  " }, { text: line, tone: "error" as const }]);
}

/**
 * A message body as the section a card shows it in, cut to the rows the disclosure state allows.
 *
 * The body carries no quote glyph of its own: the card already hangs from whatever edge the host
 * draws, and a second mark two columns inside it drew a second left edge for the same rows.
 */
function bodySection(
	body: string,
	expanded: boolean,
	options: { indent?: string; tone?: ViewTone; collapsedLines?: number } = {},
): ViewSection | undefined {
	const indent = options.indent ?? "";
	const tone = options.tone ?? "output";
	const max = expanded ? BODY_LINES_EXPANDED : (options.collapsedLines ?? BODY_LINES_COLLAPSED);
	const total = body.split("\n").filter(line => line.trim()).length;
	const lines: ViewLine[] = getPreviewLines(body, max, BODY_LINE_WIDTH, Ellipsis.Unicode).map(line => {
		const text: ViewSpan = { text: replaceTabs(line), tone };
		return indent ? [{ text: indent }, text] : [text];
	});
	if (lines.length === 0) return undefined;
	const held = total - Math.min(total, max);
	return { lines, hidden: held > 0 ? { count: held, noun: LINE_NOUN, revealable: !expanded } : undefined };
}

/** What a list of items held back, or nothing when the card shows every one of them. */
function heldBack(total: number, shown: number, noun: { one: string; many: string }): ViewHiddenCount | undefined {
	const count = total - shown;
	return count > 0 ? { count, noun, revealable: true } : undefined;
}

/** The items a collapsed card shows, which is every one of them once it is expanded. */
function shownItems(total: number, expanded: boolean): number {
	return expanded ? total : Math.min(total, PREVIEW_LIMITS.COLLAPSED_ITEMS);
}

/**
 * The title a card carries, which states the direction in words.
 *
 * `to` and `from` rather than a pair of arrows: the direction is what the row MEANS, and a host that
 * has arrows draws them beside the peer while a host reading the row aloud still says which way it
 * went.
 */
function callTitle(args: IrcViewArgs | undefined): string {
	switch (args?.op) {
		case "send":
			return `IRC to ${args.to?.trim() || "…"}`;
		case "wait":
			return `IRC from ${args.from?.trim() || "anyone"}`;
		case "inbox":
			return "IRC inbox";
		case "list":
			return "IRC peers";
		default:
			return "IRC";
	}
}

/** The facts the row states about the call itself, one entry each. */
function callMeta(args: IrcViewArgs | undefined): ViewLine[] {
	const meta: ViewLine[] = [];
	if (args?.op === "send") {
		if (args.to === "all") meta.push([{ text: "broadcast" }]);
		if (args.await) meta.push([{ text: "await reply" }]);
		if (args.replyTo) meta.push([{ text: "reply" }]);
	}
	if (args?.op === "wait" && args.timeoutMs) meta.push([{ text: `timeout ${formatDuration(args.timeoutMs)}` }]);
	if (args?.op === "inbox" && args.peek) meta.push([{ text: "peek" }]);
	return meta;
}

/** A card whose body is one message the tool has for the reader. */
function messageCard(header: StatusRowView, state: ViewStatus, sections: (ViewSection | undefined)[]): FramedBlockView {
	return {
		kind: "framedBlock",
		header,
		state,
		sections: sections.filter((section): section is ViewSection => section !== undefined),
	};
}

function errorCard(result: IrcViewResult, args: IrcViewArgs | undefined): FramedBlockView {
	const text = textContent(result) || "IRC call failed.";
	return messageCard({ kind: "statusRow", status: "error", title: callTitle(args), meta: callMeta(args) }, "error", [
		{ lines: errorLines(text) },
	]);
}

function sendCard(
	result: IrcViewResult,
	details: Partial<IrcDetails>,
	args: IrcViewArgs | undefined,
	expanded: boolean,
): FramedBlockView {
	const receipts = details.receipts ?? [];
	const to = details.to ?? args?.to?.trim() ?? "?";
	const title = `IRC to ${to}`;

	// Pre-delivery failures (validation) and empty broadcasts carry no receipts.
	if (receipts.length === 0) {
		const text = textContent(result) || (result.isError ? "Send failed." : "Nothing to deliver.");
		return messageCard(
			{ kind: "statusRow", status: result.isError ? "error" : "warning", title },
			result.isError ? "error" : "warning",
			[{ lines: result.isError ? errorLines(text) : [[{ text: replaceTabs(text), tone: "muted" }]] }],
		);
	}

	const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
	const failedCount = receipts.length - delivered.length;
	const waited = details.waited;
	const timedOut = waited === null;

	const meta: ViewLine[] = [];
	if (to === "all") meta.push([{ text: "broadcast" }]);
	if (receipts.length === 1) {
		const receipt = receipts[0]!;
		meta.push([{ text: receipt.outcome, tone: outcomeTone(receipt.outcome) }]);
	} else {
		if (delivered.length > 0) meta.push([{ text: `${delivered.length} delivered`, tone: "success" }]);
		if (failedCount > 0) meta.push([{ text: `${failedCount} failed`, tone: "error" }]);
	}
	if (timedOut) meta.push([{ text: "no reply", tone: "warning" }]);

	const header: StatusRowView = result.isError
		? { kind: "statusRow", status: "error", title, meta }
		: timedOut
			? { kind: "statusRow", status: "warning", title, meta }
			: { kind: "statusRow", emblem: "tool.irc", title, meta };

	const sections: (ViewSection | undefined)[] = [];
	const sent = args?.message?.trim();
	if (sent) sections.push(bodySection(sent, expanded, { tone: "dim" }));

	if (receipts.length > 1 || failedCount > 0) {
		const shown = shownItems(receipts.length, expanded);
		const lines: ViewLine[] = [];
		for (let i = 0; i < shown; i++) {
			const receipt = receipts[i]!;
			const line: ViewSpan[] = [
				{ text: receipt.to, tone: "output" },
				{ text: " " },
				{ text: receipt.outcome, tone: outcomeTone(receipt.outcome) },
			];
			if (receipt.outcome === "failed" && receipt.error) {
				line.push({ text: " " }, { text: receipt.error, tone: "error" });
			}
			lines.push(line);
		}
		sections.push({ lines, hidden: heldBack(receipts.length, shown, RECIPIENT_NOUN) });
	}

	if (waited) {
		const age = messageAge(waited.ts);
		const reply: ViewSpan[] = [
			{ text: "", symbol: "nav.back", tone: "dim" },
			{ text: " " },
			{ text: waited.from, tone: "accent" },
		];
		if (age) reply.push({ text: " " }, { text: age, tone: "dim" });
		sections.push({ lines: [reply] });
		sections.push(bodySection(waited.body, expanded, { indent: "  " }));
	} else if (timedOut) {
		sections.push({
			lines: [[{ text: "No reply yet — they may answer later; check inbox or wait again.", tone: "warning" }]],
		});
	}

	return messageCard(header, result.isError ? "error" : timedOut ? "warning" : "success", sections);
}

function waitCard(
	result: IrcViewResult,
	details: Partial<IrcDetails>,
	args: IrcViewArgs | undefined,
	expanded: boolean,
): FramedBlockView {
	const waited = details.waited;
	if (!waited) {
		const text = textContent(result) || "No message arrived.";
		return messageCard(
			{
				kind: "statusRow",
				status: "warning",
				title: `IRC from ${args?.from?.trim() || "anyone"}`,
				meta: [[{ text: "timed out" }]],
			},
			"warning",
			[{ lines: [[{ text: replaceTabs(text), tone: "muted" }]] }],
		);
	}
	const meta: ViewLine[] = [[{ text: messageAge(waited.ts) }]];
	if (waited.replyTo) meta.push([{ text: "reply" }]);
	return messageCard({ kind: "statusRow", emblem: "tool.irc", title: `IRC from ${waited.from}`, meta }, "success", [
		bodySection(waited.body, expanded),
	]);
}

function inboxCard(details: Partial<IrcDetails>, args: IrcViewArgs | undefined, expanded: boolean): FramedBlockView {
	const messages = details.inbox ?? [];
	if (messages.length === 0) {
		return messageCard(
			{ kind: "statusRow", emblem: "tool.irc", title: "IRC inbox", meta: [[{ text: "empty" }]] },
			"success",
			[],
		);
	}
	const meta: ViewLine[] = [[{ text: `${messages.length} ${messages.length === 1 ? "message" : "messages"}` }]];
	if (args?.peek) meta.push([{ text: "peek" }]);

	// One section per message: each body states what IT held back, which one section for the whole
	// inbox could not say twice.
	const sections: (ViewSection | undefined)[] = [];
	const shown = shownItems(messages.length, expanded);
	for (let i = 0; i < shown; i++) {
		const message = messages[i]!;
		const age = messageAge(message.ts);
		const head: ViewSpan[] = [{ text: message.from, tone: "accent" }];
		if (age) head.push({ text: " " }, { text: age, tone: "dim" });
		if (message.replyTo) head.push({ text: " " }, { text: "reply", tone: "muted" });
		sections.push({ lines: [head] });
		sections.push(bodySection(message.body, expanded, { indent: "  ", collapsedLines: 1 }));
	}
	const hidden = heldBack(messages.length, shown, MESSAGE_NOUN);
	if (hidden) sections.push({ lines: [], hidden });
	return messageCard({ kind: "statusRow", emblem: "tool.irc", title: "IRC inbox", meta }, "success", sections);
}

function peersCard(details: Partial<IrcDetails>, expanded: boolean): FramedBlockView {
	const peers = [...(details.peers ?? [])].sort(
		(a, b) =>
			(PEER_STATUS_ORDER[a.status] ?? 9) - (PEER_STATUS_ORDER[b.status] ?? 9) || b.lastActivity - a.lastActivity,
	);
	if (peers.length === 0) {
		return messageCard(
			{ kind: "statusRow", status: "info", title: "IRC peers", meta: [[{ text: "no other agents" }]] },
			"success",
			[],
		);
	}
	const counts = new Map<string, number>();
	for (const peer of peers) counts.set(peer.status, (counts.get(peer.status) ?? 0) + 1);
	const meta: ViewLine[] = [...counts].map(([status, count]) => [{ text: `${count} ${status}` }]);
	const unreadTotal = peers.reduce((sum, peer) => sum + peer.unread, 0);
	if (unreadTotal > 0) meta.push([{ text: `${unreadTotal} unread`, tone: "warning" }]);

	const shown = shownItems(peers.length, expanded);
	const lines: ViewLine[] = [];
	for (let i = 0; i < shown; i++) {
		const peer = peers[i]!;
		const kindText = peer.parentId ? `${peer.kind} of ${peer.parentId}` : peer.kind;
		const line: ViewSpan[] = [
			...peerStatusSpans(peer.status),
			{ text: " " },
			{ text: replaceTabs(peer.id), bold: true },
			{ text: " " },
			{ text: replaceTabs(peer.displayName), tone: "dim" },
			{ text: " " },
			{ text: kindText, tone: "dim" },
		];
		if (peer.activity) line.push({ text: " " }, { text: replaceTabs(peer.activity), tone: "dim" });
		if (peer.unread > 0) line.push({ text: " " }, { text: `${peer.unread} unread`, tone: "warning" });
		const age = messageAge(peer.lastActivity);
		if (age) line.push({ text: " " }, { text: age, tone: "dim" });
		lines.push(line);
	}
	return messageCard({ kind: "statusRow", emblem: "tool.irc", title: "IRC peers", meta }, "success", [
		{ lines, hidden: heldBack(peers.length, shown, PEER_NOUN) },
	]);
}

function resultCard(result: IrcViewResult, args: IrcViewArgs | undefined, expanded: boolean): FramedBlockView {
	const details: Partial<IrcDetails> = result.details ?? {};
	switch (details.op ?? args?.op) {
		case "send":
			return sendCard(result, details, args, expanded);
		case "wait":
			return waitCard(result, details, args, expanded);
		case "inbox":
			return result.isError ? errorCard(result, args) : inboxCard(details, args, expanded);
		case "list":
			return result.isError ? errorCard(result, args) : peersCard(details, expanded);
		default: {
			const text = textContent(result) || (result.isError ? "IRC call failed." : "Done.");
			return messageCard(
				{ kind: "statusRow", status: result.isError ? "error" : "success", title: callTitle(args) },
				result.isError ? "error" : "success",
				[{ lines: result.isError ? errorLines(text) : [[{ text: replaceTabs(text), tone: "muted" }]] }],
			);
		}
	}
}

export const ircToolView: Required<ToolViewRenderer<IrcViewArgs, IrcViewResult>> = {
	renderCall(args: IrcViewArgs, _context: ToolViewContext): FramedBlockView {
		const message = args?.op === "send" ? args.message?.trim() : undefined;
		return messageCard(
			{ kind: "statusRow", status: "pending", title: callTitle(args), meta: callMeta(args) },
			"pending",
			message ? [bodySection(message, false, { tone: "dim", collapsedLines: 1 })] : [],
		);
	},

	renderResult(result: IrcViewResult, context: ToolViewContext, args?: IrcViewArgs): FramedBlockView {
		const card = resultCard(result, args, context.expanded);
		return context.partial ? { ...card, state: "pending" } : card;
	},
};
