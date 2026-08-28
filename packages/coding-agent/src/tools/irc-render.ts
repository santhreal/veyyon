/**
 * TUI renderer for the irc tool — status lines, message cards, inbox and
 * peer-list trees.
 *
 * Split from `irc.ts` on purpose: `renderers.ts` (loaded by the boot-path
 * `tool-execution` component) needs ONLY the presentation code, while the
 * tool implementation pulls the IrcBus runtime and the agent registry.
 * Keeping the renderer here keeps those off the CLI boot path (PERF-6);
 * every runtime import below is type-only and erased at compile time.
 */
import type { Component } from "@veyyon/tui";
import { formatAge, formatDuration } from "@veyyon/utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { IrcDeliveryReceipt } from "../irc/bus";
import type { Theme } from "../modes/theme/theme";
import { Ellipsis, framedBlock, renderStatusLine, type State, truncateToWidth } from "../tui";
import type { IrcDetails, IrcParams } from "./irc";
import {
	createCachedComponent,
	formatBadge,
	formatErrorDetail,
	formatMoreItems,
	getPreviewLines,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
} from "./render-utils";

type IrcRenderArgs = Partial<IrcParams>;

const BODY_LINES_COLLAPSED = 2;
const BODY_LINES_EXPANDED = 12;
const BODY_LINE_WIDTH = 100;

const PEER_STATUS_ORDER: Record<string, number> = { running: 0, idle: 1, parked: 2 };

function ircGlyph(theme: Theme): string {
	return theme.styledSymbol("tool.irc", "accent");
}

function outcomeColor(outcome: IrcDeliveryReceipt["outcome"]): ToolUIColor {
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

/** Glyph + status word, matching the agent-hub status conventions. */
function peerStatusBadge(status: string, theme: Theme): string {
	switch (status) {
		case "running":
			return theme.fg("accent", `${theme.status.running} running`);
		case "idle":
			return theme.fg("success", `${theme.status.enabled} idle`);
		case "parked":
			return theme.fg("muted", `${theme.status.shadowed} parked`);
		default:
			return theme.fg("error", `${theme.status.aborted} ${status}`);
	}
}

function messageAge(ts: number | undefined): string {
	if (!ts) return "";
	return formatAge(Math.max(1, Math.round((Date.now() - ts) / 1000)));
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text?.trim() ?? "";
}

/**
 * Quote-bordered message body preview. `tone` separates outbound text (dim)
 * from received text (toolOutput); a trailing dim counter marks elided lines.
 */
function bodyLines(
	body: string,
	expanded: boolean,
	theme: Theme,
	options: { indent?: string; tone?: "dim" | "toolOutput"; collapsedLines?: number } = {},
): string[] {
	const indent = options.indent ?? "";
	const tone = options.tone ?? "toolOutput";
	const max = expanded ? BODY_LINES_EXPANDED : (options.collapsedLines ?? BODY_LINES_COLLAPSED);
	const total = body.split("\n").filter(line => line.trim()).length;
	// A message body is indented text and carries no quote glyph of its own. The
	// block already hangs from the house rail, and a second `▏` two cells inside
	// it drew a second left edge for the same rows.
	const previewParts = getPreviewLines(body, max, BODY_LINE_WIDTH, Ellipsis.Unicode);
	const lines: string[] = new Array(previewParts.length);
	for (let pi = 0; pi < previewParts.length; pi++) {
		lines[pi] = `${indent}${theme.fg(tone, replaceTabs(previewParts[pi]!))}`;
	}
	const hidden = total - Math.min(total, max);
	if (hidden > 0) {
		lines.push(`${indent}${theme.fg("dim", `… +${hidden} more ${hidden === 1 ? "line" : "lines"}`)}`);
	}
	return lines;
}

/** Header title carrying the op direction: `IRC > peer` out, `IRC ⟵ peer` in. */
function callTitle(args: IrcRenderArgs | undefined, theme: Theme): string {
	switch (args?.op) {
		case "send":
			return `IRC ${theme.nav.selected} ${args.to?.trim() || "…"}`;
		case "wait":
			return `IRC ${theme.nav.back} ${args.from?.trim() || "anyone"}`;
		case "inbox":
			return "IRC inbox";
		case "list":
			return "IRC peers";
		default:
			return "IRC";
	}
}

function callMeta(args: IrcRenderArgs | undefined): string[] {
	const meta: string[] = [];
	if (args?.op === "send") {
		if (args.to === "all") meta.push("broadcast");
		if (args.await) meta.push("await reply");
		if (args.replyTo) meta.push("reply");
	}
	if (args?.op === "wait" && args.timeoutMs) meta.push(`timeout ${formatDuration(args.timeoutMs)}`);
	if (args?.op === "inbox" && args.peek) meta.push("peek");
	return meta;
}

function renderErrorResult(
	result: { content: Array<{ type: string; text?: string }> },
	args: IrcRenderArgs | undefined,
	theme: Theme,
): { header: string; bodyLines: string[]; state: State } {
	const text = textContent(result) || "IRC call failed.";
	return {
		header: renderStatusLine({ icon: "error", title: callTitle(args, theme), meta: callMeta(args) }, theme),
		bodyLines: [formatErrorDetail(text, theme)],
		state: "error",
	};
}

/**
 * Display-only transcript card for live IRC traffic: `irc:incoming` DMs
 * delivered to this session, `irc:autoreply` side-channel replies sent on
 * this session's behalf, and `irc:relay` observations of agent↔agent
 * traffic. Shares the tool renderer's glyph + quote-border conventions so
 * cards and `irc` tool output look identical in the transcript.
 */
export function createIrcMessageCard(
	card: {
		kind: "incoming" | "autoreply" | "relay";
		from?: string;
		to?: string;
		body?: string;
		replyTo?: string;
		timestamp?: number;
	},
	getExpanded: () => boolean,
	uiTheme: Theme,
): Component {
	const from = card.from?.trim() || "?";
	const title =
		card.kind === "incoming"
			? `IRC ${uiTheme.nav.back} ${from}`
			: card.kind === "autoreply"
				? `IRC ${uiTheme.nav.selected} ${card.to?.trim() || "?"}`
				: `IRC ${from} ${uiTheme.nav.selected} ${card.to?.trim() || "?"}`;
	const body = card.body ?? "";
	const meta: string[] = [];
	if (card.kind === "autoreply") meta.push("auto");
	if (card.replyTo) meta.push("reply");
	const age = messageAge(card.timestamp);
	if (age) meta.push(age);
	return createCachedComponent(
		getExpanded,
		(width, expanded) => {
			const lines = [renderStatusLine({ iconOverride: ircGlyph(uiTheme), title, meta }, uiTheme)];
			if (body.trim()) {
				const bl = bodyLines(body, expanded, uiTheme, { indent: "  ", collapsedLines: 3 });
				for (let li = 0; li < bl.length; li++) lines.push(bl[li]!);
			}
			for (let li = 0; li < lines.length; li++) {
				lines[li] = truncateToWidth(lines[li]!, width, Ellipsis.Unicode);
			}
			return lines;
		},
		{ paddingX: 1 },
	);
}

function renderSendResult(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<IrcDetails>,
	args: IrcRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): { header: string; bodyLines: string[]; state: State } {
	const receipts = details.receipts ?? [];
	const to = details.to ?? args?.to?.trim() ?? "?";
	const title = `IRC ${theme.nav.selected} ${to}`;

	// Pre-delivery failures (validation) and empty broadcasts carry no receipts.
	if (receipts.length === 0) {
		const text = textContent(result) || (result.isError ? "Send failed." : "Nothing to deliver.");
		return {
			header: renderStatusLine({ icon: result.isError ? "error" : "warning", title }, theme),
			bodyLines: [result.isError ? formatErrorDetail(text, theme) : theme.fg("muted", replaceTabs(text))],
			state: result.isError ? "error" : "warning",
		};
	}

	const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
	const failedCount = receipts.length - delivered.length;
	const waited = details.waited;
	const timedOut = waited === null;

	const meta: string[] = [];
	if (to === "all") meta.push("broadcast");
	if (receipts.length === 1) {
		const receipt = receipts[0]!;
		meta.push(theme.fg(outcomeColor(receipt.outcome), receipt.outcome));
	} else {
		if (delivered.length > 0) meta.push(theme.fg("success", `${delivered.length} delivered`));
		if (failedCount > 0) meta.push(theme.fg("error", `${failedCount} failed`));
	}
	if (timedOut) meta.push(theme.fg("warning", "no reply"));

	const icon = result.isError
		? { icon: "error" as const }
		: timedOut
			? { icon: "warning" as const }
			: { iconOverride: ircGlyph(theme) };
	const header = renderStatusLine({ ...icon, title, meta }, theme);
	const body: string[] = [];

	const sent = args?.message?.trim();
	if (sent) {
		const bl = bodyLines(sent, expanded, theme, { tone: "dim" });
		for (let li = 0; li < bl.length; li++) body.push(bl[li]!);
	}

	if (receipts.length > 1 || failedCount > 0) {
		const maxItems = expanded ? receipts.length : Math.min(receipts.length, PREVIEW_LIMITS.COLLAPSED_ITEMS);
		for (let i = 0; i < maxItems; i++) {
			const receipt = receipts[i]!;
			const badge = formatBadge(receipt.outcome, outcomeColor(receipt.outcome), theme);
			const error =
				receipt.outcome === "failed" && receipt.error
					? ` ${theme.fg("error", `${theme.format.dash} ${receipt.error}`)}`
					: "";
			body.push(`${theme.fg("toolOutput", receipt.to)} ${badge}${error}`);
		}
		if (!expanded && receipts.length > maxItems) {
			const remaining = receipts.length - maxItems;
			body.push(theme.fg("dim", formatMoreItems(remaining, "recipient")));
		}
	}

	if (waited) {
		const age = messageAge(waited.ts);
		body.push(
			`${theme.fg("dim", theme.nav.back)} ${theme.fg("accent", waited.from)}${age ? ` ${theme.fg("dim", age)}` : ""}`,
		);
		const bl = bodyLines(waited.body, expanded, theme, { indent: "  " });
		for (let li = 0; li < bl.length; li++) body.push(bl[li]!);
	} else if (timedOut) {
		body.push(theme.fg("warning", "No reply yet — they may answer later; check inbox or wait again."));
	}

	const state: State = result.isError ? "error" : timedOut ? "warning" : "success";
	return { header, bodyLines: body, state };
}

function renderWaitResult(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<IrcDetails>,
	args: IrcRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): { header: string; bodyLines: string[]; state: State } {
	const waited = details.waited;
	if (!waited) {
		const text = textContent(result) || "No message arrived.";
		return {
			header: renderStatusLine(
				{ icon: "warning", title: `IRC ${theme.nav.back} ${args?.from?.trim() || "anyone"}`, meta: ["timed out"] },
				theme,
			),
			bodyLines: [theme.fg("muted", replaceTabs(text))],
			state: "warning",
		};
	}
	const meta = [messageAge(waited.ts)];
	if (waited.replyTo) meta.push("reply");
	return {
		header: renderStatusLine(
			{ iconOverride: ircGlyph(theme), title: `IRC ${theme.nav.back} ${waited.from}`, meta },
			theme,
		),
		bodyLines: bodyLines(waited.body, expanded, theme),
		state: "success",
	};
}

function renderInboxResult(
	details: Partial<IrcDetails>,
	args: IrcRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): { header: string; bodyLines: string[]; state: State } {
	const messages = details.inbox ?? [];
	if (messages.length === 0) {
		return {
			header: renderStatusLine({ iconOverride: ircGlyph(theme), title: "IRC inbox", meta: ["empty"] }, theme),
			bodyLines: [],
			state: "success",
		};
	}
	const meta = [`${messages.length} ${messages.length === 1 ? "message" : "messages"}`];
	if (args?.peek) meta.push("peek");
	const header = renderStatusLine({ iconOverride: ircGlyph(theme), title: "IRC inbox", meta }, theme);
	const body: string[] = [];
	const maxItems = expanded ? messages.length : Math.min(messages.length, PREVIEW_LIMITS.COLLAPSED_ITEMS);
	for (let i = 0; i < maxItems; i++) {
		const msg = messages[i]!;
		const age = messageAge(msg.ts);
		const replyBadge = msg.replyTo ? ` ${formatBadge("reply", "muted", theme)}` : "";
		const head = `${theme.fg("accent", msg.from)}${age ? ` ${theme.fg("dim", age)}` : ""}${replyBadge}`;
		body.push(head);
		const bl = bodyLines(msg.body, expanded, theme, { indent: "  ", collapsedLines: 1 });
		for (let li = 0; li < bl.length; li++) body.push(bl[li]!);
	}
	if (!expanded && messages.length > maxItems) {
		const remaining = messages.length - maxItems;
		body.push(theme.fg("dim", formatMoreItems(remaining, "message")));
	}
	return { header, bodyLines: body, state: "success" };
}

function renderListResult(
	details: Partial<IrcDetails>,
	expanded: boolean,
	theme: Theme,
): { header: string; bodyLines: string[]; state: State } {
	const peers = [...(details.peers ?? [])].sort(
		(a, b) =>
			(PEER_STATUS_ORDER[a.status] ?? 9) - (PEER_STATUS_ORDER[b.status] ?? 9) || b.lastActivity - a.lastActivity,
	);
	if (peers.length === 0) {
		return {
			header: renderStatusLine({ icon: "info", title: "IRC peers", meta: ["no other agents"] }, theme),
			bodyLines: [],
			state: "success",
		};
	}
	const counts = new Map<string, number>();
	for (const peer of peers) counts.set(peer.status, (counts.get(peer.status) ?? 0) + 1);
	const meta: string[] = new Array(counts.size);
	let mi = 0;
	for (const [status, count] of counts) {
		meta[mi++] = `${count} ${status}`;
	}
	let unreadTotal = 0;
	for (let pi = 0; pi < peers.length; pi++) {
		unreadTotal += peers[pi]!.unread;
	}
	if (unreadTotal > 0) meta.push(theme.fg("warning", `${unreadTotal} unread`));
	const header = renderStatusLine({ iconOverride: ircGlyph(theme), title: "IRC peers", meta }, theme);
	const body: string[] = [];
	const maxItems = expanded ? peers.length : Math.min(peers.length, PREVIEW_LIMITS.COLLAPSED_ITEMS);
	for (let i = 0; i < maxItems; i++) {
		const peer = peers[i]!;
		const kindText = peer.parentId ? `${peer.kind}${theme.sep.dot}of ${peer.parentId}` : peer.kind;
		const unread = peer.unread > 0 ? ` ${formatBadge(`${peer.unread} unread`, "warning", theme)}` : "";
		const age = messageAge(peer.lastActivity);
		const activity = peer.activity ? ` ${theme.fg("dim", replaceTabs(peer.activity))}` : "";
		const name = theme.fg("dim", replaceTabs(peer.displayName));
		body.push(
			`${peerStatusBadge(peer.status, theme)} ${theme.bold(replaceTabs(peer.id))} ${name} ${theme.fg("dim", kindText)}${activity}${unread}${age ? ` ${theme.fg("dim", age)}` : ""}`,
		);
	}
	if (!expanded && peers.length > maxItems) {
		const remaining = peers.length - maxItems;
		body.push(theme.fg("dim", formatMoreItems(remaining, "peer")));
	}
	return { header, bodyLines: body, state: "success" };
}

function buildResultBlock(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<IrcDetails>,
	args: IrcRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): { header: string; bodyLines: string[]; state: State } {
	switch (details.op ?? args?.op) {
		case "send":
			return renderSendResult(result, details, args, expanded, theme);
		case "wait":
			return renderWaitResult(result, details, args, expanded, theme);
		case "inbox":
			return result.isError
				? renderErrorResult(result, args, theme)
				: renderInboxResult(details, args, expanded, theme);
		case "list":
			return result.isError ? renderErrorResult(result, args, theme) : renderListResult(details, expanded, theme);
		default: {
			const text = textContent(result) || (result.isError ? "IRC call failed." : "Done.");
			return {
				header: renderStatusLine(
					{ icon: result.isError ? "error" : "success", title: callTitle(args, theme) },
					theme,
				),
				bodyLines: [result.isError ? formatErrorDetail(text, theme) : theme.fg("muted", replaceTabs(text))],
				state: result.isError ? "error" : "success",
			};
		}
	}
}

export const ircToolRenderer = {
	inline: true,
	mergeCallAndResult: true,

	renderCall(args: IrcRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const header = renderStatusLine(
			{ icon: "pending", title: callTitle(args, uiTheme), meta: callMeta(args) },
			uiTheme,
		);
		const body: string[] = [];
		if (args?.op === "send" && args.message?.trim()) {
			const bl = bodyLines(args.message, false, uiTheme, { tone: "dim", collapsedLines: 1 });
			for (let li = 0; li < bl.length; li++) body.push(bl[li]!);
		}
		return framedBlock(uiTheme, width => ({
			header,
			sections: body.length > 0 ? [{ lines: body }] : [],
			state: "pending",
			width,
		}));
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: IrcDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: IrcRenderArgs,
	): Component {
		const details: Partial<IrcDetails> = result.details ?? {};
		return framedBlock(uiTheme, width => {
			const {
				header,
				bodyLines: lines,
				state,
			} = buildResultBlock(result, details, args, Boolean(options.expanded), uiTheme);
			return {
				header,
				sections: lines.length > 0 ? [{ lines }] : [],
				state: options.isPartial ? "pending" : state,
				width,
			};
		});
	},
};
