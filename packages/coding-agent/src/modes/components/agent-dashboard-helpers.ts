/**
 * AgentDashboard - the Agent Control Center. THE agent surface.
 *
 * Two views, one card, both about a run in progress:
 * - Live: every agent that exists right now, what TYPE of agent each one is,
 *   and what it is doing. Enter hands the main view over to that agent's live
 *   session, where you read it and talk to it; Esc there returns you to your
 *   own session.
 * - Comms: the agent-to-agent traffic, streaming, oldest first, with a summary
 *   line above it. Each message says who spoke to whom, what it answers when it
 *   is a reply, and how it landed when that was not the ordinary live hand-off.
 *   Ctrl+O expands the messages the stream folded; f narrows the stream to one
 *   agent's traffic.
 *
 * BOTH VIEWS ARE SCOPED TO ONE CONVERSATION. The registry and the bus are
 * process-global, and this card is not: `deps.scope` is the session id the card
 * was opened for, and the roster and the stream are filtered to it. Without
 * that, `/resume` in a long-lived process listed the subagents of every
 * conversation the process had ever driven, and the stream opened on their
 * chatter.
 *
 * WHY ONE CARD. This surface was FOUR. `/agents` carried a configuration list
 * that duplicated the Subagents settings table. `/cockpit` (alias `/hub`, and
 * the `app.agents.hub` key, and the `←←` gesture) opened a separate "Agent Hub"
 * overlay with its own roster, its own ordering, its own status glyphs and its
 * own drill-in. A third roster, the "subagent inbox", sat behind a
 * `display.subagentInbox` flag with a fourth drill-in. Three of them showed the
 * same registry through three different renderings, and only one of them opened
 * something you could reply to, so "which agents are running" had three answers
 * that could disagree and the operator had to know which screen they were on.
 * They are one component now, and every entry point opens it.
 *
 * What each of the folded surfaces contributed, and where it went:
 * - The hub's persisted-subagent scan (agents from previous runs, registered
 *   `parked` so they survive a restart) is now `registry/persisted-subagents.ts`,
 *   called here.
 * - The hub's model badge is `agent-model-badge.ts`, shared with the task widget.
 * - The hub's kill (`x`) is here. Its revive (`r`) is gone as a separate key:
 *   opening a parked agent revives it, so a key that only revived was a second
 *   way to do the same thing badly.
 * - The hub's in-overlay transcript viewer is still mounted, but only for the
 *   two cases with no live session to hand over: an advisor transcript, and a
 *   collab guest whose sessions live on the host.
 *
 * Controls:
 * - Up/Down or j/k: move selection (Live) or scroll (Comms)
 * - Tab / Shift+Tab or Left/Right: switch view
 * - Enter: open the selected agent (Live)
 * - x: confirm termination of the selected agent (Live)
 * - Ctrl+O: expand folded messages (Comms)
 * - f: cycle the stream through each agent's traffic (Comms)
 * - Esc, or the key that opened it: close
 */
import type { AgentTool } from "@veyyon/agent-core";
import {
	type Component,
	matchesKey,
	padding,
	replaceTabs,
	routeSgrMouseInput,
	ScrollView,
	sanitizeSingleLine,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { errorMessage, formatAge, formatMoreLines } from "@veyyon/utils";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import type { IrcBus, IrcLogEntry } from "../../irc/bus";
import type { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import type { AgentRegistry } from "../../registry/agent-registry";
import type { SessionObserverRegistry } from "../session-observer-registry";
import { withIcon } from "../theme/icon-label";
import { theme } from "../theme/theme";
import { matchesSelectCancel } from "../utils/keybinding-matchers";
import { agentType, type LiveAgent } from "./agent-activity";
import { agentDisplayState, agentStatusGlyph, agentStatusWord } from "./agent-status-display";
import type { AgentTranscriptRemote } from "./agent-transcript-viewer";
import {
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	type ModalShortcut,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";
import { selectionBand } from "./selector-helpers";

/** Which of the card's two views is showing. */
export type ViewId = "live" | "comms";

export interface ViewTab {
	id: ViewId;
	label: string;
	/** Rows behind the tab, so the strip says how much is there before you switch. */
	count: number;
}

export const VIEW_ORDER: readonly ViewId[] = ["live", "comms"];

/**
 * ModalShell footer chips for the Live roster.
 *
 * The three roster chips are dropped when the roster is empty, for the same
 * reason the Comms expand chip is dropped when nothing is bound to it: a chip
 * names an action you can take, and with no rows there is nothing to navigate,
 * open or kill. The empty state already explains what will appear here, so
 * offering three keys that do nothing under it reads as a broken panel rather
 * than an idle one.
 */
export function liveShortcuts(rosterRows: number, scopeHint: string): readonly ModalShortcut[] {
	return [
		...(rosterRows > 0
			? [{ label: "up/down navigate" }, { label: "enter open agent" }, { label: "x terminate" }]
			: []),
		...(scopeHint ? [{ label: scopeHint }] : []),
		{ label: "left/right view" },
		{ label: "esc close", clickable: true, id: "close" },
	];
}

/**
 * ModalShell footer chips for the Comms stream.
 *
 * The expand chip is built from the keys the host injected rather than written
 * out, because `app.tools.expand` is remappable and the handler already reads it:
 * a hardcoded `ctrl+o` chip told a user who had rebound the action about a key
 * that no longer unfolds anything, next to a key that does. When no expand key
 * reaches the card at all the chip is dropped rather than shown, since a chip for
 * a gesture nothing can trigger is worse than one fewer chip.
 */
export function commsShortcuts(expandHint: string, canFilter: boolean, scopeHint: string): readonly ModalShortcut[] {
	return [
		{ label: "up/down scroll" },
		...(expandHint ? [{ label: `${expandHint} expand` }] : []),
		// Dropped below two participants, by the same rule as the expand chip: with
		// one agent in the log there is nothing to narrow to, and a key that cycles
		// between "everything" and "everything" reads as a broken control.
		...(canFilter ? [{ label: "f filter" }] : []),
		...(scopeHint ? [{ label: scopeHint }] : []),
		{ label: "left/right view" },
		{ label: "esc close", clickable: true, id: "close" },
	];
}

/**
 * Lines of one message shown in the stream before it is folded.
 *
 * Agents send each other paragraphs. Rendered whole, two of them fill the card
 * and the stream stops being a stream, so the tail is folded away and Ctrl+O
 * unfolds it. The fold is always announced with the count it hid: a silently
 * clipped message reads as a short message.
 */
export const COMMS_PREVIEW_LINES = 3;

/**
 * Seconds between two epoch-millisecond stamps, for {@link formatAge}.
 *
 * `formatAge` takes SECONDS and appends " ago" itself. Handing it milliseconds
 * showed a four-second-old agent as "1h ago" and a two-minute-old one as "1d
 * ago", and appending a second " ago" at the call site read as "51m ago ago".
 * One helper so both surfaces convert once and neither restates the unit.
 */
export function ageSeconds(now: number, at: number): number {
	// At least one second, because `formatAge` reads 0 as UNKNOWN and returns
	// nothing for it. That is right for a file with no mtime and wrong for an
	// agent that acted this very second: the busiest row in the roster went blank
	// while a row that had been idle for forty seconds read "just now".
	return Math.max(1, Math.round((now - at) / 1000));
}

/** `HH:MM:SS` for a bus timestamp, so the stream reads as a log. */
function clockTime(at: number): string {
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Everything one roster row needs that does not come from the registry ref. */
export interface RosterExtras {
	/** Undelivered messages sitting in this agent's mailbox. */
	unread: number;
	/** What it was ASKED to do (spawn description), which outlives the momentary activity. */
	task?: string;
	/** Model + reasoning level, when the operator has badges turned on. */
	model?: string;
}

/**
 * The Live roster: one row per agent that exists, including the ones parked on
 * disk from previous runs.
 *
 * Deliberately NOT a configuration list. It only ever shows agents that exist,
 * which means a disabled specialist cannot appear in it at all: not by a filter
 * that could drift, but because a disabled agent is never spawned and so never
 * registers.
 */
/**
 * Narrowest a model badge is worth drawing.
 *
 * `claude-son…` is a model you can recognise; `clau…` is four columns spent on
 * nothing. Below this the row keeps the space for the status and the age.
 */
export const MIN_MODEL_BADGE = 10;

/**
 * Frame a failure for the notice line, in the operator's terms.
 *
 * `errorMessage(error)` on its own put the program's internal words on screen:
 * a kill whose session had no `abort` announced "ref.session.abort is not a
 * function. (In 'ref.session.abort({ reason: USER_INTERRUPT_LABEL })', ...)",
 * which names no agent, no action, and nothing to do next. The reason still
 * rides along at the end, where it is evidence rather than the whole message.
 */
export function actionFailedNotice(action: string, callSign: string, error: unknown): string {
	return `Could not ${action} ${callSign}: ${errorMessage(error)}`;
}

/** Gap between the roster row's parts, in one place so measuring matches joining. */
export const PART_GAP = "  ";

/**
 * Narrowest a name column is ever squeezed to.
 *
 * Below this a call sign stops being recognisable, so a very narrow card gives
 * the name columns their floor and truncates the row's tail instead.
 */
export const MIN_NAME_COLUMN = 8;

/**
 * Widths the roster's fixed columns are padded to, measured over every agent.
 *
 * One object rather than four positional numbers: the row builder took them in
 * an order only its own call site knew, and a fifth column would have meant a
 * fifth positional argument to thread through.
 */
export interface RosterColumns {
	sign: number;
	type: number;
	status: number;
	age: number;
}

export class LiveRosterPane implements Component {
	constructor(
		private readonly agents: readonly LiveAgent[],
		private readonly extrasFor: (agent: LiveAgent) => RosterExtras,
		private readonly selectedIndex: number,
		private readonly hoveredIndex: number,
		private readonly canTerminate: (agent: LiveAgent) => boolean,
		private readonly scrollOffset: number,
		private readonly maxVisible: number,
		/**
		 * Read at RENDER time, not captured at construction.
		 *
		 * The age ticker repaints the card every five seconds to advance this
		 * column, and the layout is only rebuilt when the terminal geometry
		 * changes. A pane holding the `Date.now()` of its construction therefore
		 * redrew the same "3m ago" forever: the ticker paid for a repaint on a
		 * fixed cadence and the label it existed to update never moved.
		 */
		private readonly now: () => number,
		/**
		 * The width the rows were actually drawn at, reported back after the
		 * ScrollView has decided whether to take its gutter.
		 *
		 * The hit test for the row-local `[x]` used to re-derive this from
		 * `agents.length > maxVisible`, which is a GUESS at what ScrollView does.
		 * The two disagreed at the boundary where the roster exactly fills its
		 * window: the view still reserved a gutter, the guess said it had not, and
		 * the click target sat one column right of the `[x]` the operator could
		 * see. Reporting the real width keeps one source of truth.
		 */
		private readonly onContentWidth: (width: number) => void,
	) {}

	render(width: number): readonly string[] {
		if (this.agents.length === 0) {
			return [
				theme.fg("muted", "  Nothing running."),
				"",
				theme.fg("dim", "  Subagents appear here the moment they spawn,"),
				theme.fg("dim", "  and the ones from earlier runs appear parked."),
				theme.fg("dim", "  Enter opens one in the main view, where you can talk to it."),
			];
		}

		const now = this.now();
		// Aligned columns, measured over the WHOLE roster rather than the visible
		// page, so scrolling never shifts the text sideways. Status and age are
		// measured too, not only the two name columns: with `running` on one row
		// and `idle` on the next, an unpadded status pushed the model and the
		// activity three columns apart down the list, and a list whose columns do
		// not line up is read as noise rather than scanned as a table. The age is
		// the subtle one, because `formatAge` returns an EMPTY string for an agent
		// that just moved, so those rows lost the column entirely and everything
		// after them slid left.
		const widest = (measure: (agent: LiveAgent) => string) =>
			this.agents.reduce((width, agent) => Math.max(width, visibleWidth(measure(agent))), 0);
		// No column may take more than a quarter of the row. Status and age are
		// short words and cap themselves, but the two NAME columns are whatever an
		// agent was called: one subagent spawned as
		// `a-very-long-agent-type-name` padded the type column to 27 cells on every
		// row, and on a 56-column card that left nothing for the status, the model
		// or the activity. A name long enough to cost the row its content is
		// truncated rather than paid for.
		const cap = Math.max(MIN_NAME_COLUMN, Math.floor(width / 4));
		const columns: RosterColumns = {
			sign: Math.min(
				widest(agent => agent.callSign),
				cap,
			),
			type: Math.min(
				widest(agent => agentType(agent)),
				cap,
			),
			// The DISPLAYED word, not `agent.status`: a waiting agent's word is
			// longer than the `parked` it is derived from, and measuring the raw
			// status padded the column one cell short, sliding every following
			// column left on exactly the rows that most need reading.
			status: widest(agent => agentDisplayState(agent)),
			age: widest(agent => formatAge(ageSeconds(now, agent.lastActivity))),
		};

		const start = this.scrollOffset;
		const end = Math.min(start + this.maxVisible, this.agents.length);
		// The view is built before its rows because the SELECTED row is filled to
		// the full width, and how much width there is depends on whether the
		// scrollbar has taken its gutter. Asking the view is the only way to get
		// that right: a fill padded past the content width is truncated by
		// `render`, which cuts the escape that closes it, and the highlight then
		// runs on through the gutter and the bar.
		const sv = new ScrollView([], {
			height: end - start,
			scrollbar: "auto",
			totalRows: this.agents.length,
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		const contentWidth = sv.contentWidth(width);
		this.onContentWidth(contentWidth);

		const rows: string[] = [];
		for (let i = start; i < end; i++) {
			rows.push(
				truncateToWidth(
					this.#row(this.agents[i], i === this.selectedIndex, i === this.hoveredIndex, columns, contentWidth, now),
					contentWidth,
				),
			);
		}

		sv.setLines(rows);
		sv.setScrollOffset(this.scrollOffset);
		return sv.render(width);
	}

	/** `‹glyph› ‹call sign› ‹type› ‹status› ‹age› ‹model› ‹unread› ‹activity› [x]`. */
	#row(
		agent: LiveAgent,
		selected: boolean,
		hovered: boolean,
		columns: RosterColumns,
		width: number,
		now: number,
	): string {
		const terminable = this.canTerminate(agent);
		// Give an idle row its whole width. Hover overlays [x] on the final four
		// cells instead of permanently evicting the model or activity, and the
		// prefix stays fixed while the pointer target appears.
		const contentWidth = width;
		const extras = this.extrasFor(agent);
		const sign = truncateToWidth(replaceTabs(agent.callSign), columns.sign);
		const name = theme.bold(sign) + padding(Math.max(0, columns.sign - visibleWidth(sign)));
		// WHAT KIND OF AGENT IT IS, next to its name. A call sign is memorable but
		// arbitrary: `Kestrel` says nothing about whether the thing burning tokens
		// over there is a reviewer or a scout. The type used to be shown only when
		// the agent had no activity to report, which is exactly when nobody is
		// looking at the row.
		const type = truncateToWidth(replaceTabs(agentType(agent)), columns.type);
		const kind = theme.fg("link", type) + padding(Math.max(0, columns.type - visibleWidth(type)));

		// A CURSOR GLYPH, not only a selection colour. The row Enter will open has
		// to be identifiable on a terminal that renders no colour at all (NO_COLOR,
		// a dumb terminal, a piped capture), and a background tint is the whole
		// signal disappearing on exactly those. Every other selector in this
		// codebase draws the same glyph in the same leading slot, so the gesture
		// reads the same here as it does in the tree, history and plan pickers.
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : padding(visibleWidth(theme.nav.cursor));
		const state = agentDisplayState(agent);
		const parts = [`${cursor} ${agentStatusGlyph(state)} ${name}  ${kind}`];
		parts.push(theme.fg("dim", agentStatusWord(state)) + padding(columns.status - visibleWidth(state)));
		const age = formatAge(ageSeconds(now, agent.lastActivity));
		parts.push(theme.fg("dim", age) + padding(columns.age - visibleWidth(age)));
		// The model badge gets what is left, and only if what is left can still say
		// something. Letting the row's own truncation cut it produced `clau…`,
		// which costs four columns to tell you nothing; `claude-son…` is a model
		// you can recognise. Below MIN_MODEL_BADGE columns the badge is dropped
		// rather than stubbed, the same way the activity below is.
		if (extras.model) {
			const room = contentWidth - visibleWidth(parts.join(PART_GAP)) - PART_GAP.length;
			if (room >= Math.min(visibleWidth(extras.model), MIN_MODEL_BADGE)) {
				parts.push(truncateToWidth(extras.model, room));
			}
		}
		// A nested spawn's parent, so a deep run reads as a tree rather than a flat
		// list of strangers. Omitted for the common case of a child of a driving
		// agent, which is recognized by its role: its id names the conversation it
		// drives, so there is no one name to compare against.
		if (agent.parentId && !this.agents.some(row => row.id === agent.parentId && row.kind === "main")) {
			parts.push(theme.fg("dim", `↳ ${replaceTabs(agent.parentId)}`));
		}
		if (agent.kind === "advisor") parts.push(theme.fg("warning", "read-only"));
		// The glyph comes from the symbol owner, not from this line: a hard-coded
		// one cannot follow the ascii or nerd preset, and the `⧉` that used to be
		// here does not exist in DejaVu Sans Mono at all.
		if (extras.unread > 0)
			parts.push(theme.fg("warning", withIcon(theme.symbol("icon.unread"), String(extras.unread))));

		const head = parts.join(PART_GAP);
		// The gist gets whatever is left of the row: it is the answer to "what is
		// it doing", and a fixed column for it would truncate the one useful line.
		const doing = agent.activity ?? extras.task;
		const gistWidth = contentWidth - visibleWidth(head) - 2;
		const content =
			doing && gistWidth >= 12
				? `${head}  ${theme.fg("muted", truncateToWidth(sanitizeSingleLine(doing), gistWidth))}`
				: head;
		const contentPadded =
			truncateToWidth(content, contentWidth) + padding(Math.max(0, contentWidth - visibleWidth(content)));
		const actionWidth = 4;
		const prefixWidth = Math.max(0, width - actionWidth);
		const actionPrefix = truncateToWidth(content, prefixWidth);
		const line =
			terminable && hovered
				? `${actionPrefix}${padding(Math.max(0, prefixWidth - visibleWidth(actionPrefix)))} ${theme.fg("error", "[x]")}`
				: contentPadded;
		if (!selected) return line;
		// `width` here is the view's content width, so the band stops exactly where
		// the scrollbar gutter starts.
		return selectionBand(theme.fg("accent", line), width);
	}

	invalidate(): void {}
}

export const TERMINATION_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "esc dismiss", clickable: true, id: "close" },
	{ label: "enter yes, terminate", clickable: true, id: "confirm" },
];

/**
 * Destructive-action guard mounted over the roster.
 *
 * The selected agent stays visible behind this small card, while both decisions
 * are explicit clickable actions. Enter confirms because focus is already inside
 * the dialog; Escape, the close glyph and click-outside all dismiss.
 */
export class AgentTerminationDialog implements Component {
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	onRequestRender?: () => void;

	constructor(
		private readonly agent: LiveAgent,
		private readonly terminalRows: () => number,
		private readonly onConfirm: () => void,
		private readonly onDismiss: () => void,
	) {}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
					motion: event.motion,
					leftClick: event.leftClick,
				});
				if (
					consumeModalChipHover(chrome, this.#hoveredShortcutId, id => {
						this.#hoveredShortcutId = id;
						this.onRequestRender?.();
					})
				) {
					return true;
				}
				if (
					chrome.kind === "close" ||
					chrome.kind === "outside" ||
					(chrome.kind === "shortcut" && chrome.id === "close")
				) {
					this.onDismiss();
					return true;
				}
				if (chrome.kind === "shortcut" && chrome.id === "confirm") {
					this.onConfirm();
				}
				return true;
			});
			return;
		}

		if (matchesSelectCancel(data)) {
			this.onDismiss();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.onConfirm();
		}
	}

	render(width: number): readonly string[] {
		const height = this.terminalRows();
		const sizing = sizingForArea(MODAL_SIZING_MEDIUM, height);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: height }, () => padding(width));
		}

		const type = agentType(this.agent);
		const statusWord = agentStatusWord(agentDisplayState(this.agent));
		const kindAndStatus = type ? `${type} · ${statusWord}` : statusWord;
		const warning =
			"This stops the current turn and removes the agent from the roster. Its transcript stays on disk.";
		const body = [
			`${theme.bold(replaceTabs(this.agent.callSign))}  ${theme.fg("muted", kindAndStatus)}`,
			"",
			...wrapTextWithAnsi(theme.fg("warning", warning), dims.contentWidth),
		];
		const shell = renderModalShell({
			title: "Terminate agent?",
			sizing,
			areaWidth: width,
			areaHeight: height,
			body,
			preferredBodyRows: body.length,
			shortcuts: TERMINATION_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return shell.lines;
	}

	invalidate(): void {}
}

/**
 * How a delivery landed, when that is worth a word on the row.
 *
 * `injected` is the ordinary case (the recipient was live and took it at its
 * next step boundary) and gets nothing: a badge on every single row is a badge
 * nobody reads. The other two say something the body cannot. `woken` means the
 * message started a turn in an agent that had stopped, and `revived` means it
 * brought a parked agent back from disk, which is the difference between "they
 * were listening" and "your message is why they are running".
 */
export const OUTCOME_BADGE: Partial<Record<IrcLogEntry["outcome"], string>> = {
	woken: "woke",
	revived: "revived",
};

/** One message's contribution to the stream, before it is turned into rows. */
export interface CommsPaneOptions {
	entries: readonly IrcLogEntry[];
	/**
	 * Agent id to the name the Live roster shows for it.
	 *
	 * The two views must name the same agent the same way. The bus records raw
	 * ids, and a spawn-scoped id (`task-3f2a…`) is exactly what call signs
	 * exist to replace: a conversation is followed by who is speaking, and
	 * `Kestrel → Otter` is followable where two hashes are not. An id with no
	 * roster row prints as itself rather than as a placeholder, since an agent
	 * that has been released still said what it said.
	 */
	nameFor: (id: string) => string;
	/**
	 * Rows scrolled past, or `"tail"` for "stay on the newest".
	 *
	 * `"tail"` is a state, not the number that happens to mean the bottom right
	 * now. How many rows the stream occupies depends on the width it wraps at
	 * and the height it is measured against, and both are only final at RENDER
	 * time, so the tail resolves here, where the rows exist.
	 */
	scrollOffset: number | "tail";
	maxVisible: number;
	/** Ctrl+O: show every line of every message instead of the first few. */
	expanded: boolean;
	/**
	 * How the fold line names the expand gesture, or `""` to name no key.
	 *
	 * The gesture is `app.tools.expand`, which is remappable, so the hint comes
	 * from the keys the card was given rather than being written out here. A
	 * hardcoded `ctrl+o` told a user who had rebound the action to press a key
	 * that no longer unfolds anything. Empty means no expand key reached the
	 * card, and then the fold still announces its count: a silently clipped
	 * message reads as a short message, which is the thing this line exists to
	 * prevent.
	 */
	expandHint: string;
	/** Report the resolved start row back, so scrolling up has a number to leave from. */
	onResolvedStart?: (start: number) => void;
	/**
	 * Whether `entries` is a narrowed view rather than the whole stream. Decides
	 * which empty state the pane shows: "nothing has been said" and "nothing
	 * matches your filter" are different facts and only one of them can be true.
	 */
	filtered?: boolean;
}

/**
 * The Comms stream: agent-to-agent traffic as it happens.
 *
 * The bus is the source, not the session files. A subagent's transcript shows
 * what IT received; only {@link IrcBus} sees every leg, including the ones that
 * failed to land, and only it keeps them after delivery has consumed the
 * mailbox. Reading anything else here would show a partial conversation and
 * call it the conversation.
 *
 * Three things ride on the head line besides who spoke, and each earns its
 * space by answering a question the body cannot:
 *  - the DELIVERY, when it was not the ordinary live hand-off, because a
 *    message that woke or revived its recipient changed what that agent is
 *    doing, and a message that failed changes what YOU do next;
 *  - the REPLY link, because `replyTo` is recorded on every answered message
 *    and was previously shown nowhere, leaving an interleaved four-agent stream
 *    to be untangled by reading bodies;
 *  - and nothing else. Latency and route are telemetry, gated on an
 *    instrumentation level, and absent in the configuration most people run.
 */
export class CommsPane implements Component {
	constructor(private readonly options: CommsPaneOptions) {}

	/** The head line for one message: time, speakers, delivery, and what it answers. */
	static #head(
		entry: IrcLogEntry,
		replyToSender: string | undefined,
		nameFor: (id: string) => string,
		width: number,
	): string {
		const { message } = entry;
		const parts = [
			theme.fg("dim", clockTime(message.ts)),
			theme.fg("accent", replaceTabs(nameFor(message.from))),
			theme.fg("dim", "→"),
			theme.fg("link", replaceTabs(nameFor(message.to))),
		];
		// A bare `↩` when the reply goes back to whoever asked, which is almost
		// every reply: the head already reads `Otter → Juniper`, and appending
		// `re Juniper` to it says Juniper twice and teaches nothing. The name is
		// added only for the case it answers, a reply routed to someone OTHER than
		// the agent being answered, where "who is this about" genuinely is not on
		// the row.
		if (replyToSender !== undefined) {
			const mark = replyToSender === message.to ? "↩" : `↩ re ${replaceTabs(nameFor(replyToSender))}`;
			parts.push(theme.fg("dim", mark));
		}
		const badge = OUTCOME_BADGE[entry.outcome];
		if (badge) parts.push(theme.fg("warning", badge));
		return truncateToWidth(parts.join(" "), width);
	}

	/** Rendered rows for the whole stream, before scrolling. Shared by render and the scroll bounds. */
	static layout(
		entries: readonly IrcLogEntry[],
		width: number,
		expanded: boolean,
		nameFor: (id: string) => string,
		expandHint: string,
	): string[] {
		// Sender by message id, so a reply can name who it answers. Built from the
		// entries this pane was handed rather than from the bus, so a filtered
		// stream resolves against what is on screen and a reply to a message the
		// filter hid degrades to no link instead of to a stray name.
		const senderOf = new Map<string, string>();
		for (const entry of entries) senderOf.set(entry.message.id, entry.message.from);

		const rows: string[] = [];
		for (const entry of entries) {
			const { message } = entry;
			const replyToSender = message.replyTo === undefined ? undefined : senderOf.get(message.replyTo);
			rows.push(CommsPane.#head(entry, replyToSender, nameFor, width));

			const wrapped: string[] = [];
			for (const raw of message.body.split("\n")) {
				for (const line of wrapTextWithAnsi(replaceTabs(raw), Math.max(10, width - 4))) wrapped.push(line);
			}
			const shown = expanded ? wrapped : wrapped.slice(0, COMMS_PREVIEW_LINES);
			for (const line of shown) rows.push(truncateToWidth(`  ${theme.fg("muted", line)}`, width));
			if (wrapped.length > shown.length) {
				const more = `  … ${formatMoreLines(wrapped.length - shown.length)}`;
				rows.push(theme.fg("dim", expandHint ? `${more} · ${expandHint}` : more));
			}

			// A message that never reached its recipient is the one line in this view
			// that changes what you do next, so it is stated on the row rather than
			// left for the reader to infer from a reply that never comes.
			if (entry.outcome === "failed") {
				const why = entry.error ? `: ${sanitizeSingleLine(entry.error)}` : "";
				rows.push(truncateToWidth(theme.fg("error", `  not delivered${why}`), width));
			}
			rows.push("");
		}
		// The blank line after the last message is a separator with nothing to
		// separate; keeping it puts a permanent empty row under the tail.
		if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
		return rows;
	}

	render(width: number): readonly string[] {
		const { entries, nameFor, expanded, expandHint, maxVisible, scrollOffset, onResolvedStart, filtered } =
			this.options;
		if (entries.length === 0) {
			// A filter that matches nothing is a DIFFERENT state from a run that has
			// said nothing, and saying the second while the first is true tells the
			// operator there has been no traffic while traffic sits in the log one
			// keypress away. It is also the only body text on screen when the log is
			// pruned under a live filter, so getting it wrong there leaves nothing
			// on the card that is true.
			if (filtered) {
				return [
					theme.fg("muted", "  No traffic from this agent."),
					"",
					theme.fg("dim", "  The stream is narrowed to one agent and nothing here matches it."),
					theme.fg("dim", "  Press f to widen it back to every agent."),
				];
			}
			return [
				theme.fg("muted", "  No agent traffic yet."),
				"",
				theme.fg("dim", "  Every message agents send each other lands here as it happens,"),
				theme.fg("dim", "  including the ones that failed to reach their recipient."),
			];
		}
		const rows = CommsPane.layout(entries, width, expanded, nameFor, expandHint);
		// Pre-sliced, because passing `totalRows` puts ScrollView in the mode where
		// the CALLER windows and the component only draws the bar. Handing it the
		// whole stream with an offset set rendered the first screen under a
		// scrollbar parked at the bottom.
		const maxStart = Math.max(0, rows.length - maxVisible);
		const start = scrollOffset === "tail" ? maxStart : Math.min(scrollOffset, maxStart);
		onResolvedStart?.(start);
		const windowed = rows.slice(start, start + maxVisible);
		const sv = new ScrollView(windowed, {
			height: windowed.length,
			scrollbar: "auto",
			totalRows: rows.length,
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		sv.setScrollOffset(start);
		return sv.render(width);
	}

	invalidate(): void {}
}

export interface AgentDashboardDeps {
	/** Rows to size the card against. Defaults to the live terminal height. */
	terminalHeight?: number;
	/** Keys that expand folded comms messages (`app.tools.expand`). */
	expandKeys?: readonly KeyId[];
	/** Keys that toggle the card closed from inside (`app.agents.hub` + `app.session.observe`). */
	hubKeys?: readonly KeyId[];
	/** Injectable for tests; defaults to the process-global registry. */
	registry?: AgentRegistry;
	/** Injectable for tests; defaults to the process-global bus. */
	irc?: IrcBus;
	/** Injectable for tests; defaults to the process-global lifecycle manager. Lazy: only termination touches it. */
	lifecycle?: () => AgentLifecycleManager;
	/** Spawn descriptions and executor-reported models. Absent in render-only tests. */
	observers?: SessionObserverRegistry;
	/** `subagent.showResolvedModelBadge`: whether rows carry the model badge. */
	showModelBadge?: boolean;
	/** Current main session file; seeds parked agents from previous runs. */
	sessionFile?: string | null;
	/**
	 * Conversation this card is rendered for (`SessionManager.getSessionId()`).
	 *
	 * The registry is process-global; a roster is not. Omitted only where there
	 * is no conversation to attribute the card to (collab guest, render-only
	 * tests), and an omitted scope shows everything rather than nothing.
	 */
	scope?: string;
	/**
	 * Open showing every conversation in the process rather than only `scope`.
	 *
	 * The entry point decides the opening scope; `a` toggles it either way once
	 * the card is up. `/agents` opens on the conversation the operator is in,
	 * because that is the tree they are working in and a roster that also lists
	 * a background conversation's subagents buries it. `/process-manager` opens
	 * wide, because the whole reason to reach for it is a conversation no screen
	 * is showing.
	 */
	processScope?: boolean;
	/** Collab guest: route transcript reads and actions to the host. */
	remote?: AgentTranscriptRemote;
	/**
	 * Hand the main view to this agent's live session (`ctx.focusAgentSession`).
	 * Rejecting leaves the card open with the reason on it. Absent for collab
	 * guests and render-only tests, where Enter opens the read-only viewer.
	 */
	focusAgent?: (id: string) => Promise<void>;
	/** TUI handle for the read-only transcript overlay; tests omit it and get a render-only stub. */
	ui?: TUI;
	/** Tool lookup for transcript renderers (labels, custom render functions). */
	getTool?: (name: string) => AgentTool | undefined;
	/** Extension message renderers for custom messages in the transcript. */
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	/** Cwd used by tool renderers for path shortening; defaults to the project dir. */
	cwd?: string;
	/** Mirrors the main transcript's thinking-block visibility. */
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
}
