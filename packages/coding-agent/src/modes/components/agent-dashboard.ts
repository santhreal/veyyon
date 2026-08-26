/**
 * AgentDashboard: unified control center providing Live (agent roster and focus handoff)
 * and Comms (inter-agent message stream) views scoped to the active conversation.
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
import { clampLow, countWhere, errorMessage, formatAge, formatMoreLines, getProjectDir, logger } from "@veyyon/utils";
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
import { agentDisplayState, agentStatusGlyph, agentStatusWord } from "./agent-status-display";
import { type AgentTranscriptRemote, AgentTranscriptViewer } from "./agent-transcript-viewer";
import { AGENT_VIEW_AGE_TICK_MS, AGENT_VIEW_DATA_CHANGE_COALESCE_MS } from "./agent-view-timings";
import {
	CARD_BODY_COL_INSET,
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	type ModalShortcut,
	planModalChrome,
	renderModalShell,
	sizingForArea,
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
 * Drops action chips when the roster is empty.
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
 * ModalShell footer chips for the Comms stream with remapped key hints.
 */
function commsShortcuts(expandHint: string, canFilter: boolean): readonly ModalShortcut[] {
	return [
		{ label: "up/down scroll" },
		...(expandHint ? [{ label: `${expandHint} expand` }] : []),
		// Dropped below two participants, by the same rule as the expand chip: with
		// one agent in the log there is nothing to narrow to, and a key that cycles
		// between "everything" and "everything" reads as a broken control.
		...(canFilter ? [{ label: "f filter" }] : []),
		{ label: "left/right view" },
		{ label: "esc close", clickable: true, id: "close" },
	];
}

/**
 * Lines of a message shown in the stream before folding the tail.
 */
const COMMS_PREVIEW_LINES = 3;

/**
 * Seconds between two epoch-millisecond timestamps for {@link formatAge}.
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
 * The Live roster: one row per existing or parked agent in this conversation.
 */
/**
 * Narrowest a model badge is worth drawing.
 *
 * `claude-son…` is a model you can recognise; `clau…` is four columns spent on
 * nothing. Below this the row keeps the space for the status and the age.
 */
const MIN_MODEL_BADGE = 10;

/**
 * Format an action failure notice for the dashboard notice line.
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
 * Column widths for formatted roster rows across all displayed agents.
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
		 * Current timestamp supplier evaluated at render time to keep age labels fresh.
		 */
		private readonly now: () => number,
		/**
		 * Callback reporting drawn row width after gutter allocation for accurate hit testing.
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
			this.agents.reduce((w, a) => Math.max(w, visibleWidth(measure(a))), 0);
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

const TERMINATION_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "esc dismiss", clickable: true, id: "close" },
	{ label: "enter yes, terminate", clickable: true, id: "confirm" },
];

/**
 * Confirmation dialog for agent termination mounted over the roster.
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
			return Array(height).fill(padding(width));
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
 * Display badge labels for non-default delivery outcomes (`woken`, `revived`).
 */
const OUTCOME_BADGE: Partial<Record<IrcLogEntry["outcome"], string>> = {
	woken: "woke",
	revived: "revived",
};

/** One message's contribution to the stream, before it is turned into rows. */
interface CommsPaneOptions {
	entries: readonly IrcLogEntry[];
	/**
	 * Resolves an agent ID to its display call sign matching the Live roster.
	 */
	nameFor: (id: string) => string;
	/**
	 * Rows scrolled past, or `"tail"` to anchor to newest messages at render time.
	 */
	scrollOffset: number | "tail";
	maxVisible: number;
	/** Ctrl+O: show every line of every message instead of the first few. */
	expanded: boolean;
	/**
	 * Keybinding hint for expanding folded message previews, or `""` if unbound.
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
 * The Comms stream: displays inter-agent IRC message traffic from {@link IrcBus},
 * including sender, recipient, delivery outcome badges, and reply links.
 */
class CommsPane implements Component {
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
	 * Conversation ID to scope the dashboard to (`SessionManager.getSessionId()`).
	 */
	scope?: string;
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
	/**
	 * Agent ID the Comms stream is filtered to, or `undefined` for all messages.
	 */
	#commsFilter: string | undefined;

	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;
	#dataChangeTimer: NodeJS.Timeout | undefined;
	/** Set by {@link dispose}, so async work started at open cannot land after close. */
	#disposed = false;

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
	/**
	 * Width the roster rows were last drawn at, reported by the pane itself.
	 *
	 * This is {@link #contentWidth} minus the scrollbar gutter WHEN the view took
	 * one, which only the view knows. It positions the row-local `[x]` hit test.
	 */
	#rosterContentWidth = 0;
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

		this.#refreshLiveAgents();
		this.#comms = this.#scopedComms();
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
				this.#comms = this.#scopedComms();
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
			: registerPersistedSubagents(this.#registry, deps.sessionFile, deps.scope).then(registered => {
					// Only when the scan actually added something. A session with no
					// subagents on disk would otherwise rebuild the roster and repaint the
					// card one microtask after opening it, to draw the same rows again.
					if (registered === 0) return;
					// And only while the card is still open. The scan walks a session
					// tree, so a card closed before it lands used to rebuild a layout
					// nobody was looking at and ask the host to repaint it, which is the
					// exact work `dispose` exists to stop.
					if (this.#disposed) return;
					this.#refreshLiveAgents();
					this.#buildLayout();
					this.onRequestRender?.();
				});

		this.#buildLayout();
	}

	/**
	 * True when no subagents exist beyond the main driving session.
	 */
	get isEmpty(): boolean {
		return this.#liveAgents.every(agent => agent.id === MAIN_AGENT_ID);
	}

	/**
	 * Dispose subscriptions, timers, and overlay components.
	 */
	dispose(): void {
		this.#disposed = true;
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
		this.#liveAgents = collectLiveAgents(this.#registry.listInScope(this.#deps.scope));
		// Keep the cursor on the AGENT, not on the row number: a spawn or a park
		// reorders the roster under an operator who is about to press Enter.
		const kept = selectedId ? this.#liveAgents.findIndex(agent => agent.id === selectedId) : -1;
		this.#liveSelectedIndex =
			kept >= 0 ? kept : clampLow(this.#liveSelectedIndex, 0, Math.max(0, this.#liveAgents.length - 1));
	}

	/**
	 * Inter-agent message log filtered to the active conversation's scope.
	 */
	#scopedComms(): IrcLogEntry[] {
		const scope = this.#deps.scope;
		if (!scope) return this.#irc.log();
		return this.#irc.log().filter(entry => AgentRegistry.sameScope(entry.scope, scope));
	}

	#observableFor(id: string): ObservableSession | undefined {
		return this.#observers?.getSessions().find(session => session.id === id);
	}

	/**
	 * Resolve an agent ID to its display call sign based on current roster state.
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
	 * The traffic the stream is currently showing: everything, or one agent's
	 * half of it (as sender OR recipient, since a conversation is both).
	 */
	#filteredComms(): IrcLogEntry[] {
		const filter = this.#commsFilter;
		if (!filter) return this.#comms;
		return this.#comms.filter(entry => entry.message.from === filter || entry.message.to === filter);
	}

	/**
	 * Unique agent IDs in the message log in order of first appearance.
	 */
	#commsParticipants(): string[] {
		const seen: string[] = [];
		for (const entry of this.#comms) {
			for (const id of [entry.message.from, entry.message.to]) {
				if (!seen.includes(id)) seen.push(id);
			}
		}
		return seen;
	}

	/**
	 * Cycle the Comms filter to the next participant, wrapping back to all messages.
	 */
	#cycleCommsFilter(): void {
		const participants = this.#commsParticipants();
		// A filter with nothing left to filter still has to be clearable. The
		// early return here used to be `participants.length === 0`, which is
		// exactly the state `forgetAgents` produces on `/new`, `/resume` and
		// `/handoff`: the log empties under a filter that is still set, so the
		// pane showed `0 messages · Kestrel only`, the hint and the chip both
		// vanished because they key off the participant count, and no key cleared
		// it. Closing and reopening the card was the only way out.
		if (participants.length === 0) {
			if (this.#commsFilter === undefined) return;
			this.#commsFilter = undefined;
		} else {
			const current = this.#commsFilter === undefined ? -1 : participants.indexOf(this.#commsFilter);
			const next = current + 1;
			this.#commsFilter = next >= participants.length ? undefined : participants[next];
		}
		this.#commsScrollOffset = "tail";
		this.#buildLayout();
		this.onRequestRender?.();
	}

	/** Whether `f` would do anything: cycle a filter, or clear one that is stuck. */
	#canFilterComms(): boolean {
		return this.#commsParticipants().length > 1 || this.#commsFilter !== undefined;
	}

	/**
	 * Summary line for the Comms view showing message count, undelivered count, and filter.
	 */
	#commsSummary(): string {
		const shown = this.#filteredComms();
		const failed = countWhere(shown, entry => entry.outcome === "failed");
		const parts = [`${shown.length} ${shown.length === 1 ? "message" : "messages"}`];
		if (failed > 0) parts.push(theme.fg("error", `${failed} undelivered`));
		const filterHint = this.#canFilterComms() ? " (f)" : "";
		parts.push(
			this.#commsFilter === undefined
				? `all agents${filterHint}`
				: theme.fg("accent", `${replaceTabs(this.#callSignFor(this.#commsFilter))} only${filterHint}`),
		);
		return theme.fg("dim", " ") + parts.join(theme.fg("dim", " · "));
	}

	/**
	 * Build tab strip definitions with running agent counts and message totals.
	 */
	#viewTabs(): ViewTab[] {
		return [
			// The count is ROWS BEHIND THE TAB, which is what {@link ViewTab.count}
			// promises and what the reader compares against the list in front of
			// them. It used to count only the RUNNING agents while the pane listed
			// every one of them, so a roster with three parked agents read
			// "Live (17)" above twenty rows and the strip contradicted the body.
			{ id: "live", label: "Live", count: this.#liveAgents.length },
			{ id: "comms", label: "Comms", count: this.#filteredComms().length },
		];
	}

	/** Live terminal height so the dashboard tracks resize while open. */
	#terminalRows(): number {
		return process.stdout.rows || this.#terminalHeight || 24;
	}

	/**
	 * Height in rows allocated to the active pane content, matching scroll and hit-test boundaries.
	 */
	#computeBodyHeight(): number {
		// Chrome inside the card: tab bar + spacer, plus the notice line when one is
		// showing. ModalShell owns everything outside the body, and how much that is
		// comes from {@link #bodyBudget}, which render() takes from the shell.
		const budget = Math.max(1, this.#bodyBudget - 2 - (this.#notice ? 2 : 0));
		// Comms also carries its summary line and a spacer. Charging the pane for
		// them is what keeps the stream's last row on screen: a body longer than the
		// budget is truncated silently, so two uncounted rows at the top drop two
		// rows off the tail, which on a feed pinned to the newest message means the
		// newest message.
		if (this.#activeView !== "live") return Math.max(1, budget - 2);
		return Math.min(budget, Math.max(AgentDashboard.#MIN_ROSTER_ROWS, this.#liveAgents.length));
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
		return this.#activeView === "live"
			? liveShortcuts(this.#liveAgents.length)
			: commsShortcuts(this.#expandHint(), this.#canFilterComms());
	}

	/**
	 * Floating ModalShell card: titled chrome, tab bar, body, centered shortcut
	 * chips. Transcript visible around the card (host overlay is fullscreen so the
	 * alt-screen + mouse tracking stay active for the card's lifetime).
	 */
	override render(width: number): readonly string[] {
		// The card is laid out against the WHOLE terminal, not against its own
		// height. Passing the card's height as the area left the shell no slack to
		// centre in, so the card sat flush against the top of the screen while
		// every other modal floated in the middle. The shell shrinks the card to
		// `preferredBodyRows` below and re-centres it in this area.
		const area = this.#terminalRows();
		const sizing = sizingForArea(MODAL_SIZING_LARGE, area);
		const dims = computeModalDims(width, area, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array(area).fill(padding(width));
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
		if (area !== this.#builtRows || dims.contentWidth !== this.#builtCols) {
			this.#buildLayout();
		}

		const body = super.render(dims.contentWidth);
		const shell = renderModalShell({
			title: "Agent Control Center",
			sizing,
			areaWidth: width,
			areaHeight: area,
			body,
			preferredBodyRows: this.#preferredBodyRows(body.length),
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});

		this.#shellGeometry = shell.geometry;
		// The body's left edge: the card's border plus the ONE column `row()` in
		// overlay-box insets every line by (`│ ` … ` │`). That inset is fixed and
		// is NOT `sizing.hPad` — hPad narrows the content through
		// `computeModalDims`, it does not move where the content starts. This used
		// to add hPad and so landed one column right on any card whose padding was
		// not compact, which put the row-local [x] permanently out of reach of the
		// pointer while still drawing it under the cursor.
		this.#bodyColStart = (shell.geometry?.cardColStart ?? 0) + CARD_BODY_COL_INSET;
		return shell.lines;
	}

	#switchView(direction: 1 | -1): void {
		const index = VIEW_ORDER.indexOf(this.#activeView);
		this.#activeView = VIEW_ORDER[(index + direction + VIEW_ORDER.length) % VIEW_ORDER.length];
		this.#notice = undefined;
		this.#liveHoveredIndex = -1;
		if (this.#activeView === "live") this.#refreshLiveAgents();
		if (this.#activeView === "comms") this.#comms = this.#scopedComms();
		this.#buildLayout();
	}

	/**
	 * Move selection cursor (Live) or scroll offset (Comms) by a signed delta.
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
	 * Page selection up or down by one body height.
	 */
	#movePage(direction: -1 | 1): void {
		this.#moveSelection(direction * Math.max(1, this.#computeBodyHeight()));
	}

	// ========================================================================
	// Opening an agent
	// ========================================================================

	/**
	 * Hand the main view over to the selected agent's session, reviving parked agents
	 * or falling back to the transcript viewer if no live session exists.
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
	 * Open the read-only transcript viewer for an agent in this conversation.
	 */
	openTranscript(id: string): void {
		const ref = this.#registry.get(id);
		if (!ref) return;
		if (!AgentRegistry.sameScope(ref.scope, this.#deps.scope)) return;
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
	 * Prompt for confirmation before terminating the selected subagent.
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
	 * Terminate an agent, aborting active turns before releasing session resources.
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
				await this.#lifecycle().terminate(agent.id, USER_INTERRUPT_LABEL);
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
	 * Render the view selector tab strip using shared overlay tab theme styles.
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
					width => {
						this.#rosterContentWidth = width;
					},
				),
			);
		} else {
			this.addChild(new Text(this.#commsSummary(), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(
				new CommsPane({
					entries: this.#filteredComms(),
					nameFor: id => this.#callSignFor(id),
					scrollOffset: this.#commsScrollOffset,
					maxVisible: this.#computeBodyHeight(),
					expanded: this.#commsExpanded,
					expandHint: this.#expandHint(),
					onResolvedStart: start => {
						this.#commsResolvedStart = start;
					},
					filtered: this.#commsFilter !== undefined,
				}),
			);
		}

		this.#builtRows = this.#terminalRows();
		this.#builtCols = this.#contentWidth;
	}

	/**
	 * Minimum roster rows reserved to prevent modal resizing jitter during initial spawns.
	 */
	static readonly #MIN_ROSTER_ROWS = 4;

	/**
	 * Preferred body height padding to the minimum roster floor in Live view.
	 */
	#preferredBodyRows(bodyRows: number): number {
		if (this.#activeView !== "live") return bodyRows;
		return Math.max(bodyRows, this.#paneRowOffset() + AgentDashboard.#MIN_ROSTER_ROWS);
	}

	/** Body rows the tab strip and any notice occupy before the pane starts. */
	#paneRowOffset(): number {
		return 2 + (this.#notice ? 2 : 0);
	}

	/**
	 * Calculate roster row index at a given screen row, accounting for scroll offset.
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
		// The width the roster actually drew, reported by the pane itself. Do not
		// re-derive it here by predicting the scrollbar: `sv.contentWidth` already
		// owns that rule, and a second copy of it drifts the [x] hit box off the
		// glyph the moment the two disagree.
		const actionStart = this.#bodyColStart + this.#rosterContentWidth - 3;
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
	 * Route SGR mouse events to tabs, roster rows, close actions, and termination dialogs.
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

		// `f`: narrow the stream to one agent's traffic. A plain letter, like `x`
		// on the roster, because the card owns every key while it is open.
		if (data === "f") {
			this.#cycleCommsFilter();
		}
	}
}
