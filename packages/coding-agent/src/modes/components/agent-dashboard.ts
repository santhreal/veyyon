/**
 * AgentDashboard - the Agent Control Center. THE agent surface.
 *
 * Two views, one card, both about a run in progress:
 * - Live: every agent that exists right now, what TYPE of agent each one is,
 *   and what it is doing. Enter hands the main view over to that agent's live
 *   session, where you read it and talk to it; Esc there returns you to your
 *   own session.
 * - Comms: the agent-to-agent traffic, streaming, oldest first. Ctrl+O expands
 *   the messages the stream folded.
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
 * - Esc, or the key that opened it: close
 */
import type { AgentTool } from "@veyyon/agent-core";
import {
	type Component,
	Container,
	matchesKey,
	type OverlayHandle,
	padding,
	replaceTabs,
	routeSgrMouseInput,
	ScrollView,
	Spacer,
	sanitizeSingleLine,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { clampLow, errorMessage, formatAge, formatMoreLines, getProjectDir, logger } from "@veyyon/utils";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { IrcBus, type IrcLogEntry } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-subagents";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { getTabBarTheme } from "../shared";
import { withIcon } from "../theme/icon-label";
import { theme } from "../theme/theme";
import { keyHint } from "../utils/key-hint";
import {
	matchesAppInterrupt,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { agentType, collectLiveAgents, type LiveAgent } from "./agent-activity";
import { modelBadgeFromSelector } from "./agent-model-badge";
import { agentStatusGlyph, agentStatusWord } from "./agent-status-display";
import { type AgentTranscriptRemote, AgentTranscriptViewer } from "./agent-transcript-viewer";
import { AGENT_VIEW_AGE_TICK_MS, AGENT_VIEW_DATA_CHANGE_COALESCE_MS } from "./agent-view-timings";
import {
	applyModalReveal,
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	MODAL_SIZING_MEDIUM,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	modalNeedsCompactPadding,
	planModalChrome,
	renderModalShell,
	withCompact,
} from "./modal-shell";
import { clampSelection, handleTabSwitchKey, selectionBand } from "./selector-helpers";

/** Which of the card's two views is showing. */
type ViewId = "live" | "comms";

interface ViewTab {
	id: ViewId;
	label: string;
	/** Rows behind the tab, so the strip says how much is there before you switch. */
	count: number;
}

const VIEW_ORDER: readonly ViewId[] = ["live", "comms"];

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
function liveShortcuts(rosterRows: number): readonly ModalShortcut[] {
	return [
		...(rosterRows > 0
			? [{ label: "up/down navigate" }, { label: "enter open agent" }, { label: "x terminate" }]
			: []),
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
function commsShortcuts(expandHint: string): readonly ModalShortcut[] {
	return [
		{ label: "up/down scroll" },
		...(expandHint ? [{ label: `${expandHint} expand` }] : []),
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
const COMMS_PREVIEW_LINES = 3;

/**
 * Seconds between two epoch-millisecond stamps, for {@link formatAge}.
 *
 * `formatAge` takes SECONDS and appends " ago" itself. Handing it milliseconds
 * showed a four-second-old agent as "1h ago" and a two-minute-old one as "1d
 * ago", and appending a second " ago" at the call site read as "51m ago ago".
 * One helper so both surfaces convert once and neither restates the unit.
 */
function ageSeconds(now: number, at: number): number {
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
interface RosterExtras {
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
const MIN_MODEL_BADGE = 10;

/**
 * Frame a failure for the notice line, in the operator's terms.
 *
 * `errorMessage(error)` on its own put the program's internal words on screen:
 * a kill whose session had no `abort` announced "ref.session.abort is not a
 * function. (In 'ref.session.abort({ reason: USER_INTERRUPT_LABEL })', ...)",
 * which names no agent, no action, and nothing to do next. The reason still
 * rides along at the end, where it is evidence rather than the whole message.
 */
function actionFailedNotice(action: string, callSign: string, error: unknown): string {
	return `Could not ${action} ${callSign}: ${errorMessage(error)}`;
}

/** Gap between the roster row's parts, in one place so measuring matches joining. */
const PART_GAP = "  ";

/**
 * Narrowest a name column is ever squeezed to.
 *
 * Below this a call sign stops being recognisable, so a very narrow card gives
 * the name columns their floor and truncates the row's tail instead.
 */
const MIN_NAME_COLUMN = 8;

/**
 * Widths the roster's fixed columns are padded to, measured over every agent.
 *
 * One object rather than four positional numbers: the row builder took them in
 * an order only its own call site knew, and a fifth column would have meant a
 * fifth positional argument to thread through.
 */
interface RosterColumns {
	sign: number;
	type: number;
	status: number;
	age: number;
}

class LiveRosterPane implements Component {
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
			status: widest(agent => agent.status),
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
		// Every terminable row reserves the action's four cells even before hover,
		// so revealing [x] never shifts or re-wraps the activity under the pointer.
		const actionWidth = terminable ? 4 : 0;
		const contentWidth = Math.max(1, width - actionWidth);
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
		const parts = [`${cursor} ${agentStatusGlyph(agent.status)} ${name}  ${kind}`];
		parts.push(theme.fg("dim", agentStatusWord(agent.status)) + padding(columns.status - visibleWidth(agent.status)));
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
		// list of strangers. Omitted for the common case of a child of the session.
		if (agent.parentId && agent.parentId !== MAIN_AGENT_ID) {
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
		const action = terminable ? ` ${hovered ? theme.fg("error", "[x]") : "   "}` : "";
		const line = `${contentPadded}${action}`;
		if (!selected) return line;
		// `width` here is the view's content width, so the band stops exactly where
		// the scrollbar gutter starts.
		return selectionBand(theme.fg("accent", line), width);
	}

	invalidate(): void {}
}

const TERMINATION_SHORTCUTS: readonly ModalShortcut[] = [
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
class AgentTerminationDialog implements Component {
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
				if (chrome.kind === "hover-shortcut") {
					if (this.#hoveredShortcutId !== chrome.id) {
						this.#hoveredShortcutId = chrome.id;
						this.onRequestRender?.();
					}
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
		const sizing = withCompact(MODAL_SIZING_MEDIUM, modalNeedsCompactPadding(height, MODAL_SIZING_MEDIUM));
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: height }, () => padding(width));
		}

		const kindAndStatus = `${agentType(this.agent)} · ${agentStatusWord(this.agent.status)}`;
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
 * The Comms stream: agent-to-agent traffic as it happens.
 *
 * The bus is the source, not the session files. A subagent's transcript shows
 * what IT received; only {@link IrcBus} sees every leg, including the ones that
 * failed to land, and only it keeps them after delivery has consumed the
 * mailbox. Reading anything else here would show a partial conversation and
 * call it the conversation.
 */
class CommsPane implements Component {
	constructor(
		private readonly entries: readonly IrcLogEntry[],
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
		private readonly nameFor: (id: string) => string,
		/**
		 * Rows scrolled past, or `"tail"` for "stay on the newest".
		 *
		 * `"tail"` is a state, not the number that happens to mean the bottom right
		 * now. How many rows the stream occupies depends on the width it wraps at
		 * and the height it is measured against, and both are only final at RENDER
		 * time, so the tail resolves here, where the rows exist.
		 */
		private readonly scrollOffset: number | "tail",
		private readonly maxVisible: number,
		/** Ctrl+O: show every line of every message instead of the first few. */
		private readonly expanded: boolean,
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
		private readonly expandHint: string,
		/** Report the resolved start row back, so scrolling up has a number to leave from. */
		private readonly onResolvedStart?: (start: number) => void,
	) {}

	/** Rendered rows for the whole stream, before scrolling. Shared by render and the scroll bounds. */
	static layout(
		entries: readonly IrcLogEntry[],
		width: number,
		expanded: boolean,
		nameFor: (id: string) => string,
		expandHint: string,
	): string[] {
		const rows: string[] = [];
		for (const entry of entries) {
			const { message } = entry;
			const head = `${theme.fg("dim", clockTime(message.ts))} ${theme.fg("accent", replaceTabs(nameFor(message.from)))} ${theme.fg("dim", "→")} ${theme.fg("link", replaceTabs(nameFor(message.to)))}`;
			rows.push(truncateToWidth(head, width));

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
		if (this.entries.length === 0) {
			return [
				theme.fg("muted", "  No agent traffic yet."),
				"",
				theme.fg("dim", "  Every message agents send each other lands here as it happens,"),
				theme.fg("dim", "  including the ones that failed to reach their recipient."),
			];
		}
		const rows = CommsPane.layout(this.entries, width, this.expanded, this.nameFor, this.expandHint);
		// Pre-sliced, because passing `totalRows` puts ScrollView in the mode where
		// the CALLER windows and the component only draws the bar. Handing it the
		// whole stream with an offset set rendered the first screen under a
		// scrollbar parked at the bottom.
		const maxStart = Math.max(0, rows.length - this.maxVisible);
		const start = this.scrollOffset === "tail" ? maxStart : Math.min(this.scrollOffset, maxStart);
		this.onResolvedStart?.(start);
		const windowed = rows.slice(start, start + this.maxVisible);
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
	/** Play the open unfold (TOUCH-5). Show site decides via `modalRevealEnabled()`. */
	reveal?: boolean;
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

export class AgentDashboard extends Container {
	#activeView: ViewId = "live";

	/** Live roster, refreshed from the registry on every change. */
	#liveAgents: LiveAgent[] = [];
	#liveSelectedIndex = 0;
	#liveScrollOffset = 0;
	#liveHoveredIndex = -1;
	/** One line of feedback under the tab strip: a failed open or refused action. */
	#notice: string | undefined;

	/** Bus traffic, refreshed from the bus on every message. */
	#comms: IrcLogEntry[] = [];
	/** Rows scrolled past, or `"tail"` while the stream follows the newest message. */
	#commsScrollOffset: number | "tail" = "tail";
	/** Start row the pane last resolved, so leaving the tail has a number to leave from. */
	#commsResolvedStart = 0;
	#commsExpanded = false;

	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;
	#dataChangeTimer: NodeJS.Timeout | undefined;

	#builtRows = -1;
	#builtCols = -1;
	/** Content-column width inside the ModalShell card, refreshed every render. */
	#contentWidth = 80;
	/**
	 * Body rows the card will actually show, from the shell's own plan and
	 * refreshed every render. `#computeBodyHeight` sizes the panes against this
	 * rather than restating the chrome arithmetic, which is how the last row got
	 * dropped: a body longer than the budget is truncated with no error.
	 */
	#bodyBudget = 11;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	/** Screen column the card's body text starts at, refreshed every render. */
	#bodyColStart = 0;
	/** Clickable view tabs, in columns relative to the body text. */
	#tabHits: Array<{ id: ViewId; start: number; end: number }> = [];

	/** Fullscreen read-only transcript overlay, when one is open. */
	#transcriptOverlay: OverlayHandle | undefined;
	#transcriptViewer: AgentTranscriptViewer | undefined;
	/** Focused confirmation overlay guarding a roster termination. */
	#terminationOverlay: OverlayHandle | undefined;
	#terminationDialog: AgentTerminationDialog | undefined;

	readonly #deps: AgentDashboardDeps;
	readonly #registry: AgentRegistry;
	readonly #irc: IrcBus;
	readonly #lifecycle: () => AgentLifecycleManager;
	readonly #observers: SessionObserverRegistry | undefined;
	readonly #expandKeys: readonly KeyId[];
	readonly #hubKeys: readonly KeyId[];
	readonly #terminalHeight: number;
	readonly #ui: TUI;

	/** Resolves once agents persisted by previous runs have been registered and the roster refreshed. */
	readonly persistedSubagentsReady: Promise<void>;

	onClose?: () => void;
	onRequestRender?: () => void;
	#reveal = new ModalRevealDriver();

	constructor(deps: AgentDashboardDeps = {}) {
		super();
		this.#deps = deps;
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#irc = deps.irc ?? IrcBus.global();
		// Lazy: the lifecycle global self-constructs against the global registry,
		// so only touch it when confirmed termination actually needs it.
		this.#lifecycle = () => (deps.lifecycle ?? AgentLifecycleManager.global)();
		this.#observers = deps.observers;
		this.#expandKeys = deps.expandKeys ?? [];
		this.#hubKeys = deps.hubKeys ?? [];
		this.#terminalHeight = deps.terminalHeight ?? process.stdout.rows ?? 24;
		this.#ui =
			deps.ui ??
			({
				requestRender: () => this.onRequestRender?.(),
				requestComponentRender: () => this.onRequestRender?.(),
			} as unknown as TUI);
		if (deps.reveal) this.#reveal.start(() => this.onRequestRender?.());

		this.#refreshLiveAgents();
		this.#comms = this.#irc.log();
		// Always the roster, never "whichever view has content". A card that picks
		// its own opening tab is a card whose first keypress means something
		// different each time you open it, and the counts in the strip already say
		// where the content is.

		this.#unsubscribers.push(this.#registry.onChange(() => this.#scheduleDataChange()));
		if (this.#observers) {
			this.#unsubscribers.push(this.#observers.onChange(() => this.#scheduleDataChange()));
		}
		// Streaming, not polling: the bus tells the card the moment a message is
		// recorded, which is what makes the Comms view live rather than a snapshot
		// of whatever had been said when it was opened.
		this.#unsubscribers.push(
			this.#irc.onMessage(() => {
				this.#comms = this.#irc.log();
				this.#rebuildAndRender();
			}),
		);
		// Only the age labels move on this tick, never the row count or layout, so a
		// component-scoped repaint avoids re-walking the whole UI tree. The timer
		// lives only while the card is mounted.
		this.#ageTimer = setInterval(() => this.#ui.requestComponentRender?.(this), AGENT_VIEW_AGE_TICK_MS);
		this.#ageTimer.unref?.();

		// Agents from previous runs are on disk, not in this process's registry.
		// A guest's roster is the host's, mirrored over the wire, so it does not
		// scan a local session tree that is not its own.
		this.persistedSubagentsReady = deps.remote
			? Promise.resolve()
			: registerPersistedSubagents(this.#registry, deps.sessionFile).then(registered => {
					// Only when the scan actually added something. A session with no
					// subagents on disk would otherwise rebuild the roster and repaint the
					// card one microtask after opening it, to draw the same rows again.
					if (registered === 0) return;
					this.#refreshLiveAgents();
					this.#buildLayout();
					this.onRequestRender?.();
				});

		this.#buildLayout();
	}

	/**
	 * Whether the roster has nothing worth opening the card for.
	 *
	 * The driving session is always registered, so it does not count: a card
	 * raised by the `←←` gesture must stay inert until there is a SUBAGENT to
	 * look at. Agents persisted by previous runs arrive later; callers that need
	 * those included wait for {@link persistedSubagentsReady} first.
	 */
	get isEmpty(): boolean {
		return this.#liveAgents.every(agent => agent.id === MAIN_AGENT_ID);
	}

	/**
	 * Drop every subscription, timer and child overlay.
	 *
	 * The registry and the bus are process-global and outlive every card opened
	 * against them, so a card that closed without unsubscribing would keep
	 * rebuilding a layout nobody is looking at for the rest of the session, once
	 * per agent event and once per message.
	 */
	dispose(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		if (this.#ageTimer) {
			clearInterval(this.#ageTimer);
			this.#ageTimer = undefined;
		}
		if (this.#dataChangeTimer) {
			clearTimeout(this.#dataChangeTimer);
			this.#dataChangeTimer = undefined;
		}
		this.#closeTranscriptOverlay({ restoreFocus: false });
		this.#closeTerminationOverlay({ restoreFocus: false });
	}

	#scheduleDataChange(): void {
		if (this.#dataChangeTimer) return;
		this.#dataChangeTimer = setTimeout(() => {
			this.#dataChangeTimer = undefined;
			this.#refreshLiveAgents();
			this.#rebuildAndRender();
		}, AGENT_VIEW_DATA_CHANGE_COALESCE_MS);
		this.#dataChangeTimer.unref?.();
	}

	#refreshLiveAgents(): void {
		const selectedId = this.#liveAgents[this.#liveSelectedIndex]?.id;
		this.#liveHoveredIndex = -1;
		this.#liveAgents = collectLiveAgents(this.#registry.list());
		// Keep the cursor on the AGENT, not on the row number: a spawn or a park
		// reorders the roster under an operator who is about to press Enter.
		const kept = selectedId ? this.#liveAgents.findIndex(agent => agent.id === selectedId) : -1;
		this.#liveSelectedIndex =
			kept >= 0 ? kept : clampLow(this.#liveSelectedIndex, 0, Math.max(0, this.#liveAgents.length - 1));
	}

	#observableFor(id: string): ObservableSession | undefined {
		return this.#observers?.getSessions().find(session => session.id === id);
	}

	/**
	 * The name the roster shows for an agent id, for the Comms stream to reuse.
	 *
	 * Recomputed from the current roster rather than cached, because call signs
	 * are assigned from the roster order and an agent registered since the last
	 * lookup shifts nothing but adds a name that was not there before.
	 */
	#callSignFor(id: string): string {
		return this.#liveAgents.find(agent => agent.id === id)?.callSign ?? id;
	}

	/** Mailbox depth, spawn description and model badge for one row. */
	#extrasFor(agent: LiveAgent): RosterExtras {
		const observed = this.#observableFor(agent.id);
		return {
			unread: this.#irc.unreadCount(agent.id),
			task: observed?.description ?? observed?.progress?.task,
			model: this.#deps.showModelBadge ? this.#modelBadge(agent, observed) : undefined,
		};
	}

	/**
	 * Live session state when the agent is attached, else the executor-reported
	 * selector, else the model recorded on the ref at registration. Undefined
	 * only when none is known.
	 */
	#modelBadge(agent: LiveAgent, observed: ObservableSession | undefined): string | undefined {
		const resolved = observed?.progress?.resolvedModel ?? agent.model;
		if (!resolved) return undefined;
		const badge = modelBadgeFromSelector(resolved, theme);
		// A dim arrow when this is not the model the agent started on, the same
		// mark the Subagents HUD block uses, so the two surfaces read alike.
		return observed?.progress?.fellBackFrom ? `${theme.fg("dim", "↓")}${badge}` : badge;
	}

	/**
	 * Tab strip labels and counts.
	 *
	 * Live counts what is RUNNING rather than what is registered, because an idle
	 * or parked agent is history, and a count that includes history never returns
	 * to zero once the session has spawned anything.
	 */
	#viewTabs(): ViewTab[] {
		return [
			// The count is ROWS BEHIND THE TAB, which is what {@link ViewTab.count}
			// promises and what the reader compares against the list in front of
			// them. It used to count only the RUNNING agents while the pane listed
			// every one of them, so a roster with three parked agents read
			// "Live (17)" above twenty rows and the strip contradicted the body.
			{ id: "live", label: "Live", count: this.#liveAgents.length },
			{ id: "comms", label: "Comms", count: this.#comms.length },
		];
	}

	/** Live terminal height so the dashboard tracks resize while open. */
	#terminalRows(): number {
		return process.stdout.rows || this.#terminalHeight || 24;
	}

	/** Height budget for the body, sized to the ModalShell card. */
	#computeBodyHeight(): number {
		// Chrome inside the card: tab bar + spacer, plus the notice line when one is
		// showing. ModalShell owns everything outside the body, and how much that is
		// comes from {@link #bodyBudget}, which render() takes from the shell.
		return Math.max(1, this.#bodyBudget - 2 - (this.#notice ? 2 : 0));
	}

	/**
	 * The expand gesture as the chips and the fold hint spell it, or `""`.
	 *
	 * Lowercase, because every chip in this card is lowercase and `formatKeyHints`
	 * produces the title-case form the settings UI uses.
	 */
	#expandHint(): string {
		return keyHint(this.#expandKeys);
	}

	#currentShortcuts(): readonly ModalShortcut[] {
		return this.#activeView === "live" ? liveShortcuts(this.#liveAgents.length) : commsShortcuts(this.#expandHint());
	}

	/**
	 * Floating ModalShell card: titled chrome, tab bar, body, centered shortcut
	 * chips. Transcript visible around the card (host overlay is fullscreen so the
	 * alt-screen + mouse tracking stay active for the card's lifetime).
	 */
	override render(width: number): readonly string[] {
		const height = this.#cardHeight(width);
		const sizing = withCompact(MODAL_SIZING_LARGE, modalNeedsCompactPadding(height, MODAL_SIZING_LARGE));
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: height }, () => padding(width));
		}

		this.#contentWidth = dims.contentWidth;
		const shortcuts = this.#currentShortcuts();
		this.#bodyBudget = planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth: dims.contentWidth,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
		}).maxBodyRows;
		// Rebuild when terminal geometry changes so the card re-fits on resize.
		if (height !== this.#builtRows || dims.contentWidth !== this.#builtCols) {
			this.#buildLayout();
		}

		const body = super.render(dims.contentWidth);
		const shell = renderModalShell({
			title: "Agent Control Center",
			sizing,
			areaWidth: width,
			areaHeight: height,
			body,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});

		this.#shellGeometry = shell.geometry;
		// The body's left edge: the card's own left edge, its border, and the
		// shell's horizontal padding. Taken from the shell that just rendered
		// rather than recomputed later, because `sizing` is chosen per frame from
		// the terminal height and a stale copy would put every click one or two
		// columns off on a short terminal.
		this.#bodyColStart = (shell.geometry?.cardColStart ?? 0) + 1 + Math.max(1, sizing.hPad);
		return applyModalReveal(shell, width, this.#reveal.value);
	}

	#switchView(direction: 1 | -1): void {
		const index = VIEW_ORDER.indexOf(this.#activeView);
		this.#activeView = VIEW_ORDER[(index + direction + VIEW_ORDER.length) % VIEW_ORDER.length];
		this.#notice = undefined;
		this.#liveHoveredIndex = -1;
		if (this.#activeView === "live") this.#refreshLiveAgents();
		if (this.#activeView === "comms") this.#comms = this.#irc.log();
		this.#buildLayout();
	}

	/**
	 * Move the cursor (Live) or the stream (Comms) by `delta` rows.
	 *
	 * Signed row count rather than a direction, because a page is the same
	 * gesture as a step with a bigger number, and two code paths that both know
	 * how to clamp a roster index is how they come to disagree about the ends.
	 */
	#moveSelection(delta: number): void {
		if (this.#activeView === "live") {
			this.#liveHoveredIndex = -1;
			if (this.#liveAgents.length === 0) return;
			this.#liveSelectedIndex = clampLow(this.#liveSelectedIndex + delta, 0, this.#liveAgents.length - 1);
			const next = clampSelection(
				this.#liveSelectedIndex,
				this.#liveScrollOffset,
				this.#liveAgents.length,
				this.#computeBodyHeight(),
			);
			this.#liveSelectedIndex = next.selectedIndex;
			this.#liveScrollOffset = next.scrollOffset;
			this.#buildLayout();
			return;
		}
		// Leaving the tail starts from wherever the tail actually resolved to,
		// which only the pane knows: scrolling up one row from the bottom must
		// move one row, not jump to a number computed at some earlier geometry.
		const from = this.#commsScrollOffset === "tail" ? this.#commsResolvedStart : this.#commsScrollOffset;
		const next = clampLow(from + delta, 0, Number.MAX_SAFE_INTEGER);
		this.#commsScrollOffset = next >= this.#commsResolvedStart && delta > 0 ? "tail" : next;
		this.#buildLayout();
	}

	/**
	 * Jump by one bodyful of rows.
	 *
	 * A page is what fits on screen, which is what every other selector in the
	 * TUI pages by, so the distance the key travels matches what you just read.
	 * Without it a roster of sixty agents, or a stream of five hundred messages,
	 * could only be crossed one row at a time.
	 */
	#movePage(direction: -1 | 1): void {
		this.#moveSelection(direction * Math.max(1, this.#computeBodyHeight()));
	}

	// ========================================================================
	// Opening an agent
	// ========================================================================

	/**
	 * Enter on a row: hand the main view to that agent's live session.
	 *
	 * Focusing retargets the transcript, the editor and the status line at the
	 * agent (`SessionFocusController`), which is the whole point: you read what it
	 * is doing and then answer it, and `esc` there returns you to your own
	 * session. Parked agents revive on the way in (`ensureLive`), so an agent from
	 * an earlier run opens the same way a running one does.
	 *
	 * Two cases have no live session to hand over and fall back to the read-only
	 * transcript viewer: an advisor transcript (observability-only, never a peer)
	 * and a collab guest, whose sessions live on the host.
	 */
	openSelectedAgent(): void {
		const agent = this.#liveAgents[this.#liveSelectedIndex];
		if (!agent) return;
		this.#notice = undefined;
		const focusAgent = this.#deps.focusAgent;
		if (agent.kind === "advisor" || this.#deps.remote || !focusAgent) {
			this.openTranscript(agent.id);
			return;
		}
		void focusAgent(agent.id).then(
			() => this.onClose?.(),
			(error: unknown) => {
				// The card stays open with the reason on it. Closing on failure would
				// drop the operator back into a session that did not change, with
				// nothing said about why.
				this.#notice = actionFailedNotice("open", agent.callSign, error);
				this.#rebuildAndRender();
			},
		);
	}

	/**
	 * Mount the read-only transcript viewer over the card, for agents with no
	 * live session to hand over. No-op without a real TUI (render-only tests).
	 */
	openTranscript(id: string): void {
		if (!this.#registry.get(id)) return;
		if (typeof this.#ui.showOverlay !== "function") return;
		this.#closeTranscriptOverlay({ restoreFocus: false });
		const viewer = new AgentTranscriptViewer({
			agentId: id,
			registry: this.#registry,
			remote: this.#deps.remote,
			observers: this.#observers,
			lifecycle: this.#deps.remote ? undefined : this.#lifecycle,
			ui: this.#ui,
			getTool: this.#deps.getTool,
			getMessageRenderer: this.#deps.getMessageRenderer,
			cwd: this.#deps.cwd ?? getProjectDir(),
			hideThinkingBlock: this.#deps.hideThinkingBlock,
			proseOnlyThinking: this.#deps.proseOnlyThinking,
			expandKeys: [...this.#expandKeys],
			hubKeys: [...this.#hubKeys],
			requestRender: () => this.onRequestRender?.(),
			onClose: () => this.#closeTranscriptOverlay({ restoreFocus: true }),
			onHubClose: () => {
				this.#closeTranscriptOverlay({ restoreFocus: false });
				this.onClose?.();
			},
		});
		this.#transcriptViewer = viewer;
		this.#transcriptOverlay = this.#ui.showOverlay(viewer, { width: "100%", margin: 0, fullscreen: true });
		this.#ui.setFocus?.(viewer);
		this.onRequestRender?.();
	}

	#closeTranscriptOverlay(options: { restoreFocus: boolean }): void {
		if (!this.#transcriptOverlay && !this.#transcriptViewer) return;
		this.#transcriptOverlay?.hide();
		this.#transcriptOverlay = undefined;
		this.#transcriptViewer?.dispose();
		this.#transcriptViewer = undefined;
		if (options.restoreFocus) this.#ui.setFocus?.(this);
		this.onRequestRender?.();
	}

	/** Whether this roster row represents a child session the operator may terminate. */
	#canTerminate(agent: LiveAgent): boolean {
		return agent.id !== MAIN_AGENT_ID && agent.kind !== "advisor";
	}

	/**
	 * `x`: ask before terminating the selected agent.
	 *
	 * The main session owns this dashboard and cannot terminate itself here. An
	 * advisor is a read-only transcript rather than a running peer. Every real
	 * subagent opens the same focused confirmation card whether the request came
	 * from the keyboard or the row-local [x].
	 */
	killSelectedAgent(): void {
		const agent = this.#liveAgents[this.#liveSelectedIndex];
		if (!agent) return;
		this.#requestTermination(agent);
	}

	#requestTermination(agent: LiveAgent): void {
		if (agent.id === MAIN_AGENT_ID) {
			this.#notice = "The main session cannot be terminated from its own roster.";
			this.#rebuildAndRender();
			return;
		}
		if (agent.kind === "advisor") {
			this.#notice = `"${agent.id}" is a read-only advisor transcript, so there is nothing to terminate.`;
			this.#rebuildAndRender();
			return;
		}
		if (typeof this.#ui.showOverlay !== "function") {
			// A destructive fallback would make the guard disappear in embedded
			// hosts. Refuse instead, with a reason the host can render.
			this.#notice = `Could not confirm termination of ${agent.callSign} in this non-interactive view.`;
			this.#rebuildAndRender();
			return;
		}

		this.#notice = undefined;
		this.#closeTerminationOverlay({ restoreFocus: false });
		let settled = false;
		const dialog = new AgentTerminationDialog(
			agent,
			() => this.#terminalRows(),
			() => {
				if (settled) return;
				settled = true;
				this.#closeTerminationOverlay({ restoreFocus: true });
				this.#terminateAgent(agent);
			},
			() => {
				if (settled) return;
				settled = true;
				this.#closeTerminationOverlay({ restoreFocus: true });
			},
		);
		dialog.onRequestRender = () => this.onRequestRender?.();
		this.#terminationDialog = dialog;
		this.#terminationOverlay = this.#ui.showOverlay(dialog, { width: "100%", margin: 0, fullscreen: true });
		this.#ui.setFocus?.(dialog);
		this.onRequestRender?.();
	}

	#closeTerminationOverlay(options: { restoreFocus: boolean }): void {
		if (!this.#terminationOverlay && !this.#terminationDialog) return;
		this.#terminationOverlay?.hide();
		this.#terminationOverlay = undefined;
		this.#terminationDialog = undefined;
		if (options.restoreFocus) this.#ui.setFocus?.(this);
		this.onRequestRender?.();
	}

	/**
	 * Apply a confirmed termination.
	 *
	 * A running agent is aborted first, then released, because releasing a
	 * session mid-turn leaves the provider request in flight with nothing to
	 * receive it. A parked agent has no turn to abort and is released directly.
	 */
	#terminateAgent(agent: LiveAgent): void {
		const remote = this.#deps.remote;
		if (remote) {
			remote.kill(agent.id);
			this.#rebuildAndRender();
			return;
		}
		void (async () => {
			try {
				const ref = this.#registry.get(agent.id);
				if (ref?.status === "running" && ref.session) {
					await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
				}
				await this.#lifecycle().release(agent.id);
			} catch (error) {
				logger.warn("Agent Control Center: termination failed", { id: agent.id, error: String(error) });
				this.#notice = actionFailedNotice("terminate", agent.callSign, error);
			}
			this.#refreshLiveAgents();
			this.#rebuildAndRender();
		})();
	}

	// ========================================================================
	// Layout
	// ========================================================================

	/**
	 * The view strip, styled by the SHARED overlay tab theme rather than a local
	 * pair of colours.
	 *
	 * Two reasons. It is the same control the settings and extension overlays
	 * draw, and a second styling of it is how two fullscreen cards end up
	 * disagreeing about what an active tab looks like. The shared active style
	 * is bold as well as tinted, and this strip also brackets the active label,
	 * so the active view stays legible when a dumb terminal suppresses every SGR.
	 */
	#renderTabBar(): string {
		const tabTheme = getTabBarTheme();
		const parts: string[] = [" "];
		this.#tabHits = [];
		let column = 1; // the leading space above
		for (const tab of this.#viewTabs()) {
			const isActive = tab.id === this.#activeView;
			const text = `${tab.label} (${tab.count})`;
			const label = isActive ? `[${text}]` : ` ${text} `;
			this.#tabHits.push({ id: tab.id, start: column, end: column + visibleWidth(label) });
			column += visibleWidth(label);
			parts.push(isActive ? tabTheme.activeTab(label) : tabTheme.inactiveTab(label));
		}
		return parts.join("");
	}

	/** Rebuild layout and request a TUI render pass (for use after async state changes). */
	#rebuildAndRender(): void {
		this.#buildLayout();
		this.onRequestRender?.();
	}

	#buildLayout(): void {
		this.clear();
		this.addChild(new Text(this.#renderTabBar(), 0, 0));
		this.addChild(new Spacer(1));

		if (this.#notice) {
			this.addChild(new Text(theme.fg("error", sanitizeSingleLine(this.#notice)), 0, 0));
			this.addChild(new Spacer(1));
		}

		if (this.#activeView === "live") {
			this.addChild(
				new LiveRosterPane(
					this.#liveAgents,
					agent => this.#extrasFor(agent),
					this.#liveSelectedIndex,
					this.#liveHoveredIndex,
					agent => this.#canTerminate(agent),
					this.#liveScrollOffset,
					this.#computeBodyHeight(),
					() => Date.now(),
				),
			);
		} else {
			this.addChild(
				new CommsPane(
					this.#comms,
					id => this.#callSignFor(id),
					this.#commsScrollOffset,
					this.#computeBodyHeight(),
					this.#commsExpanded,
					this.#expandHint(),
					start => {
						this.#commsResolvedStart = start;
					},
				),
			);
		}

		this.#builtRows = this.#terminalRows();
		this.#builtCols = this.#contentWidth;
	}

	/**
	 * Roster rows the card keeps room for even when fewer agents exist.
	 *
	 * Without a floor the card would resize on every spawn, and a panel that
	 * changes height while you are reading it is worse than a little empty space.
	 * Eight is where a run stops feeling small: below it the card is a short strip,
	 * and rosters that size change often.
	 */
	static readonly #MIN_ROSTER_ROWS = 8;

	/**
	 * How tall the card should be, which is not always the whole terminal.
	 *
	 * It used to be `Math.max(14, terminalRows())` unconditionally, so a run with
	 * four agents drew four rows of roster and then about twenty rows of empty card
	 * under them, framed and bordered as though something were there. On a
	 * forty-row terminal that is most of the screen given to nothing, and the
	 * transcript behind the card is what it is covering.
	 *
	 * The Live roster hugs its content, because it is a LIST and its length is
	 * known. The Comms stream does not: it is a feed, its rows depend on the width
	 * it wraps at, and a feed that keeps resizing its own frame as messages arrive
	 * is the jitter this is trying to avoid. So it keeps the full height, which is
	 * also the height it wants.
	 */
	#cardHeight(width: number): number {
		const available = Math.max(14, this.#terminalRows());
		if (this.#activeView !== "live") return available;

		const wantedBody = this.#paneRowOffset() + Math.max(AgentDashboard.#MIN_ROSTER_ROWS, this.#liveAgents.length);
		if (this.#bodyRowsAt(width, available) <= wantedBody) return available;

		// Smallest height whose body still holds the roster. Chrome is not a
		// constant to subtract: the shell centers the card in the area it is given
		// and drops to compact padding on a short one, so the body a height yields
		// has to be measured at that height. It is monotonic, which is what makes a
		// search valid, and a search is what keeps this to six probes rather than
		// one per candidate row on a surface that redraws while agents work.
		let low = 14;
		let high = available;
		while (low < high) {
			const mid = Math.floor((low + high) / 2);
			if (this.#bodyRowsAt(width, mid) >= wantedBody) high = mid;
			else low = mid + 1;
		}
		return low;
	}

	/** Body rows the shell would leave at this card height, or 0 if it cannot draw. */
	#bodyRowsAt(width: number, height: number): number {
		const sizing = withCompact(MODAL_SIZING_LARGE, modalNeedsCompactPadding(height, MODAL_SIZING_LARGE));
		const dims = computeModalDims(width, height, sizing);
		if (!dims) return 0;
		return planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth: dims.contentWidth,
			shortcuts: this.#currentShortcuts(),
			hoveredShortcutId: this.#hoveredShortcutId,
		}).maxBodyRows;
	}

	/** Body rows the tab strip and any notice occupy before the pane starts. */
	#paneRowOffset(): number {
		return 2 + (this.#notice ? 2 : 0);
	}

	/**
	 * The roster index under a screen row, or -1.
	 *
	 * Reads the same scroll offset and page height the pane was built with, so a
	 * click lands on the row the operator can see rather than on the row that
	 * would be there if the roster had not been scrolled.
	 */
	#rosterIndexAt(row: number): number {
		const geometry = this.#shellGeometry;
		if (!geometry || this.#activeView !== "live") return -1;
		const offset = row - (geometry.bodyRowStart + this.#paneRowOffset());
		if (offset < 0 || offset >= this.#computeBodyHeight()) return -1;
		const index = this.#liveScrollOffset + offset;
		return index < this.#liveAgents.length ? index : -1;
	}

	/** Set the row-local hover affordance without rebuilding unchanged frames. */
	#setHoveredRosterIndex(index: number): void {
		if (this.#liveHoveredIndex === index) return;
		this.#liveHoveredIndex = index;
		this.#buildLayout();
		this.onRequestRender?.();
	}

	/** Whether a screen column lands on the right-aligned [x] for this row. */
	#isTerminationActionAt(index: number, col: number): boolean {
		const agent = this.#liveAgents[index];
		if (!agent || !this.#canTerminate(agent)) return false;
		const hasScrollbar = this.#liveAgents.length > this.#computeBodyHeight();
		const rosterWidth = this.#contentWidth - (hasScrollbar ? 1 : 0);
		const actionStart = this.#bodyColStart + rosterWidth - 3;
		return col >= actionStart && col < actionStart + 3;
	}

	/** The view whose tab is under a screen position, or undefined. */
	#tabAt(row: number, col: number): ViewId | undefined {
		const geometry = this.#shellGeometry;
		if (!geometry || row !== geometry.bodyRowStart) return undefined;
		const column = col - this.#bodyColStart;
		return this.#tabHits.find(hit => column >= hit.start && column < hit.end)?.id;
	}

	/**
	 * Route an SGR mouse report against the last render's ModalShell geometry:
	 * the chrome (close glyph, click-outside, footer chips), view tabs, roster
	 * rows, and each terminable row's hover-only [x].
	 *
	 * Clicking a row still opens it. Clicking its [x] selects that same row and
	 * opens the confirmation guard instead, so no pointer gesture can terminate
	 * immediately.
	 */
	#handleMouse(data: string): void {
		routeSgrMouseInput(data, event => {
			// The wheel moves the active view, which is the roster cursor on Live and
			// the stream on Comms, the same thing the arrow keys move.
			if (event.wheel !== null) {
				this.#moveSelection(event.wheel);
				this.onRequestRender?.();
				return true;
			}
			const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
				motion: event.motion,
				leftClick: event.leftClick,
			});
			if (event.motion) {
				const overRosterColumns =
					event.col >= this.#bodyColStart && event.col < this.#bodyColStart + this.#contentWidth;
				const hoveredIndex = overRosterColumns ? this.#rosterIndexAt(event.row) : -1;
				this.#setHoveredRosterIndex(hoveredIndex);
			}
			if (chrome.kind === "hover-shortcut") {
				if (this.#hoveredShortcutId !== chrome.id) {
					this.#hoveredShortcutId = chrome.id;
					this.onRequestRender?.();
				}
				return true;
			}
			if (
				chrome.kind === "close" ||
				chrome.kind === "outside" ||
				(chrome.kind === "shortcut" && chrome.id === "close")
			) {
				this.onClose?.();
				this.onRequestRender?.();
				return true;
			}
			// `none` is a click or motion inside the card that hit no chrome.
			if (chrome.kind !== "none" || !event.leftClick) return true;

			const tab = this.#tabAt(event.row, event.col);
			if (tab) {
				if (tab !== this.#activeView) this.#switchView(1);
				this.onRequestRender?.();
				return true;
			}

			const index = this.#rosterIndexAt(event.row);
			if (index >= 0) {
				this.#liveSelectedIndex = index;
				this.#buildLayout();
				const agent = this.#liveAgents[index];
				if (agent && this.#isTerminationActionAt(index, event.col)) this.#requestTermination(agent);
				else this.openSelectedAgent();
				this.onRequestRender?.();
			}
			return true;
		});
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			this.#handleMouse(data);
			return;
		}

		// The key that opened the card closes it, which is what makes the hub keys a
		// toggle rather than a one-way door.
		for (const key of this.#hubKeys) {
			if (matchesKey(data, key)) {
				this.onClose?.();
				return;
			}
		}

		if (matchesKey(data, "ctrl+c") || matchesAppInterrupt(data)) {
			this.onClose?.();
			return;
		}

		if (handleTabSwitchKey(data, direction => this.#switchView(direction))) {
			return;
		}

		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			this.#moveSelection(1);
			return;
		}
		if (matchesSelectPageUp(data)) {
			this.#movePage(-1);
			this.onRequestRender?.();
			return;
		}
		if (matchesSelectPageDown(data)) {
			this.#movePage(1);
			this.onRequestRender?.();
			return;
		}

		if (this.#activeView === "live") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.openSelectedAgent();
				return;
			}
			if (data === "x") this.killSelectedAgent();
			return;
		}

		// Comms: Ctrl+O is the same expand gesture the transcript uses for a
		// truncated tool result, read off `app.tools.expand` rather than hardcoded
		// here, so a rebound key moves both.
		for (const key of this.#expandKeys) {
			if (matchesKey(data, key)) {
				this.#commsExpanded = !this.#commsExpanded;
				this.#buildLayout();
				this.onRequestRender?.();
				return;
			}
		}
	}
}
