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
import { AgentRegistry } from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-subagents";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type { SessionMessageEntry } from "../../session/session-entries";
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

type ViewId = "live" | "comms";

interface ViewTab {
	id: ViewId;
	label: string;
	count: number;
}

const VIEW_ORDER: readonly ViewId[] = ["live", "comms"];

const SCROLL_VIEW_THEME = { track: (t: string) => theme.fg("muted", t), thumb: (t: string) => theme.fg("accent", t) };

function liveShortcuts(rosterRows: number, scopeHint: string): readonly ModalShortcut[] {
	return [
		...(rosterRows > 0
			? [{ label: "up/down navigate" }, { label: "enter open agent" }, { label: "x terminate" }]
			: []),
		...(scopeHint ? [{ label: scopeHint }] : []),
		{ label: "left/right view" },
		{ label: "esc close", clickable: true, id: "close" },
	];
}

function commsShortcuts(expandHint: string, canFilter: boolean, scopeHint: string): readonly ModalShortcut[] {
	return [
		{ label: "up/down scroll" },
		...(expandHint ? [{ label: `${expandHint} expand` }] : []),
		...(canFilter ? [{ label: "f filter" }] : []),
		...(scopeHint ? [{ label: scopeHint }] : []),
		{ label: "left/right view" },
		{ label: "esc close", clickable: true, id: "close" },
	];
}

const COMMS_PREVIEW_LINES = 3;

function ageSeconds(now: number, at: number): number {
	return Math.max(1, Math.round((now - at) / 1000));
}

const PAD2: readonly string[] = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

function clockTime(at: number): string {
	const date = new Date(at);
	return `${PAD2[date.getHours()]}:${PAD2[date.getMinutes()]}:${PAD2[date.getSeconds()]}`;
}

interface RosterExtras {
	unread: number;
	task?: string;
	model?: string;
}

const MIN_MODEL_BADGE = 10;

function actionFailedNotice(action: string, callSign: string, error: unknown): string {
	return `Could not ${action} ${callSign}: ${errorMessage(error)}`;
}

const PART_GAP = "  ";

const MIN_NAME_COLUMN = 8;

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
		private readonly now: () => number,
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
		let signWidth = 0;
		let typeWidth = 0;
		let statusWidth = 0;
		let ageWidth = 0;
		for (let ai = 0; ai < this.agents.length; ai++) {
			const agent = this.agents[ai]!;
			const sw = visibleWidth(agent.callSign);
			if (sw > signWidth) signWidth = sw;
			const tw = visibleWidth(agentType(agent));
			if (tw > typeWidth) typeWidth = tw;
			const dw = visibleWidth(agentDisplayState(agent));
			if (dw > statusWidth) statusWidth = dw;
			const aw = visibleWidth(formatAge(ageSeconds(now, agent.lastActivity)));
			if (aw > ageWidth) ageWidth = aw;
		}
		const cap = Math.max(MIN_NAME_COLUMN, Math.floor(width / 4));
		const columns: RosterColumns = {
			sign: Math.min(signWidth, cap),
			type: Math.min(typeWidth, cap),
			status: statusWidth,
			age: ageWidth,
		};

		const start = this.scrollOffset;
		const end = Math.min(start + this.maxVisible, this.agents.length);
		const sv = new ScrollView([], {
			height: end - start,
			scrollbar: "auto",
			totalRows: this.agents.length,
			theme: SCROLL_VIEW_THEME,
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

	#row(
		agent: LiveAgent,
		selected: boolean,
		hovered: boolean,
		columns: RosterColumns,
		width: number,
		now: number,
	): string {
		const terminable = this.canTerminate(agent);
		const contentWidth = width;
		const extras = this.extrasFor(agent);
		const sign = truncateToWidth(replaceTabs(agent.callSign), columns.sign, undefined, true);
		const name = theme.bold(sign);
		const type = truncateToWidth(replaceTabs(agentType(agent)), columns.type, undefined, true);
		const kind = theme.fg("link", type);

		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : padding(visibleWidth(theme.nav.cursor));
		const state = agentDisplayState(agent);
		const parts = [`${cursor} ${agentStatusGlyph(state)} ${name}  ${kind}`];
		parts.push(theme.fg("dim", agentStatusWord(state)) + padding(columns.status - visibleWidth(state)));
		const age = formatAge(ageSeconds(now, agent.lastActivity));
		parts.push(theme.fg("dim", age) + padding(columns.age - visibleWidth(age)));
		if (extras.model) {
			const room = contentWidth - visibleWidth(parts.join(PART_GAP)) - PART_GAP.length;
			if (room >= Math.min(visibleWidth(extras.model), MIN_MODEL_BADGE)) {
				parts.push(truncateToWidth(extras.model, room));
			}
		}
		if (agent.parentId) {
			let parentIsMain = false;
			for (let ri = 0; ri < this.agents.length; ri++) {
				const row = this.agents[ri]!;
				if (row.id === agent.parentId && row.kind === "main") {
					parentIsMain = true;
					break;
				}
			}
			if (!parentIsMain) parts.push(theme.fg("dim", `↳ ${replaceTabs(agent.parentId)}`));
		}
		if (agent.kind === "advisor") parts.push(theme.fg("warning", "read-only"));
		if (extras.unread > 0)
			parts.push(theme.fg("warning", withIcon(theme.symbol("icon.unread"), String(extras.unread))));

		const head = parts.join(PART_GAP);
		const doing = agent.activity ?? extras.task;
		const gistWidth = contentWidth - visibleWidth(head) - 2;
		const content =
			doing && gistWidth >= 12
				? `${head}  ${theme.fg("muted", truncateToWidth(sanitizeSingleLine(doing), gistWidth))}`
				: head;
		const contentPadded = truncateToWidth(content, contentWidth, undefined, true);
		const actionWidth = 4;
		const prefixWidth = Math.max(0, width - actionWidth);
		const line =
			terminable && hovered
				? `${truncateToWidth(content, prefixWidth, undefined, true)} ${theme.fg("error", "[x]")}`
				: contentPadded;
		if (!selected) return line;
		return selectionBand(theme.fg("accent", line), width);
	}

	invalidate(): void {}
}

const TERMINATION_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "esc dismiss", clickable: true, id: "close" },
	{ label: "enter yes, terminate", clickable: true, id: "confirm" },
];

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
			return new Array(height).fill(padding(width));
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

const OUTCOME_BADGE: Partial<Record<IrcLogEntry["outcome"], string>> = {
	woken: "woke",
	revived: "revived",
};

interface CommsPaneOptions {
	entries: readonly IrcLogEntry[];
	nameFor: (id: string) => string;
	scrollOffset: number | "tail";
	maxVisible: number;
	expanded: boolean;
	expandHint: string;
	onResolvedStart?: (start: number) => void;
	filtered?: boolean;
}

class CommsPane implements Component {
	constructor(private readonly options: CommsPaneOptions) {}

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
		if (replyToSender !== undefined) {
			const mark = replyToSender === message.to ? "↩" : `↩ re ${replaceTabs(nameFor(replyToSender))}`;
			parts.push(theme.fg("dim", mark));
		}
		const badge = OUTCOME_BADGE[entry.outcome];
		if (badge) parts.push(theme.fg("warning", badge));
		return truncateToWidth(parts.join(" "), width);
	}

	static layout(
		entries: readonly IrcLogEntry[],
		width: number,
		expanded: boolean,
		nameFor: (id: string) => string,
		expandHint: string,
	): string[] {
		const senderOf = new Map<string, string>();
		for (let ei = 0; ei < entries.length; ei++) {
			senderOf.set(entries[ei]!.message.id, entries[ei]!.message.from);
		}

		const rows: string[] = [];
		for (let ei2 = 0; ei2 < entries.length; ei2++) {
			const entry = entries[ei2]!;
			const { message } = entry;
			const replyToSender = message.replyTo === undefined ? undefined : senderOf.get(message.replyTo);
			rows.push(CommsPane.#head(entry, replyToSender, nameFor, width));

			const wrapped: string[] = [];
			const bodyLines = message.body.split("\n");
			for (let bli = 0; bli < bodyLines.length; bli++) {
				const wrappedLines = wrapTextWithAnsi(replaceTabs(bodyLines[bli]!), Math.max(10, width - 4));
				for (let wli = 0; wli < wrappedLines.length; wli++) wrapped.push(wrappedLines[wli]!);
			}
			const shown = expanded ? wrapped : wrapped.slice(0, COMMS_PREVIEW_LINES);
			for (let si = 0; si < shown.length; si++) {
				rows.push(truncateToWidth(`  ${theme.fg("muted", shown[si]!)}`, width));
			}
			if (wrapped.length > shown.length) {
				const more = `  … ${formatMoreLines(wrapped.length - shown.length)}`;
				rows.push(theme.fg("dim", expandHint ? `${more} · ${expandHint}` : more));
			}

			if (entry.outcome === "failed") {
				const why = entry.error ? `: ${sanitizeSingleLine(entry.error)}` : "";
				rows.push(truncateToWidth(theme.fg("error", `  not delivered${why}`), width));
			}
			rows.push("");
		}
		if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
		return rows;
	}

	render(width: number): readonly string[] {
		const { entries, nameFor, expanded, expandHint, maxVisible, scrollOffset, onResolvedStart, filtered } =
			this.options;
		if (entries.length === 0) {
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
		const maxStart = Math.max(0, rows.length - maxVisible);
		const start = scrollOffset === "tail" ? maxStart : Math.min(scrollOffset, maxStart);
		onResolvedStart?.(start);
		const windowed = rows.slice(start, start + maxVisible);
		const sv = new ScrollView(windowed, {
			height: windowed.length,
			scrollbar: "auto",
			totalRows: rows.length,
			theme: SCROLL_VIEW_THEME,
		});
		sv.setScrollOffset(start);
		return sv.render(width);
	}

	invalidate(): void {}
}

export interface AgentDashboardDeps {
	terminalHeight?: number;
	expandKeys?: readonly KeyId[];
	hubKeys?: readonly KeyId[];
	registry?: AgentRegistry;
	irc?: IrcBus;
	lifecycle?: () => AgentLifecycleManager;
	observers?: SessionObserverRegistry;
	showModelBadge?: boolean;
	sessionFile?: string | null;
	scope?: string;
	processScope?: boolean;
	remote?: AgentTranscriptRemote;
	focusAgent?: (id: string) => Promise<void>;
	ui?: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd?: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandArgot?: (entries: SessionMessageEntry[]) => SessionMessageEntry[];
}

export class AgentDashboard extends Container {
	#activeView: ViewId = "live";

	#processScope: boolean;

	#liveAgents: LiveAgent[] = [];
	#liveSelectedIndex = 0;
	#liveScrollOffset = 0;
	#liveHoveredIndex = -1;
	#notice: string | undefined;

	#comms: IrcLogEntry[] = [];
	#commsScrollOffset: number | "tail" = "tail";
	#commsResolvedStart = 0;
	#commsExpanded = false;
	#commsFilter: string | undefined;

	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;
	#dataChangeTimer: NodeJS.Timeout | undefined;
	#disposed = false;

	#builtRows = -1;
	#builtCols = -1;
	#contentWidth = 80;
	#bodyBudget = 11;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#bodyColStart = 0;
	#rosterContentWidth = 0;
	#tabHits: Array<{ id: ViewId; start: number; end: number }> = [];

	#transcriptOverlay: OverlayHandle | undefined;
	#transcriptViewer: AgentTranscriptViewer | undefined;
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

	readonly persistedSubagentsReady: Promise<void>;

	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(deps: AgentDashboardDeps = {}) {
		super();
		this.#deps = deps;
		this.#processScope = deps.processScope ?? false;
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#irc = deps.irc ?? IrcBus.global();
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

		this.#unsubscribers.push(this.#registry.onChange(() => this.#scheduleDataChange()));
		if (this.#observers) {
			this.#unsubscribers.push(this.#observers.onChange(() => this.#scheduleDataChange()));
		}
		this.#unsubscribers.push(
			this.#irc.onMessage(() => {
				this.#comms = this.#scopedComms();
				this.#rebuildAndRender();
			}),
		);
		this.#ageTimer = setInterval(() => this.#ui.requestComponentRender?.(this), AGENT_VIEW_AGE_TICK_MS);
		this.#ageTimer.unref?.();

		this.persistedSubagentsReady = deps.remote
			? Promise.resolve()
			: registerPersistedSubagents(this.#registry, deps.sessionFile, deps.scope).then(registered => {
					if (registered === 0) return;
					if (this.#disposed) return;
					this.#refreshLiveAgents();
					this.#buildLayout();
					this.onRequestRender?.();
				});

		this.#buildLayout();
	}

	get isEmpty(): boolean {
		return this.#liveAgents.every(agent => agent.kind === "main");
	}

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

	#effectiveScope(): string | undefined {
		return this.#processScope ? undefined : this.#deps.scope;
	}

	toggleProcessScope(): void {
		this.#processScope = !this.#processScope;
		this.#notice = undefined;
		this.#liveSelectedIndex = 0;
		this.#liveScrollOffset = 0;
		this.#refreshLiveAgents();
		this.#comms = this.#scopedComms();
		this.#buildLayout();
	}

	get showingWholeProcess(): boolean {
		return this.#processScope;
	}

	#refreshLiveAgents(): void {
		const selectedId = this.#liveAgents[this.#liveSelectedIndex]?.id;
		this.#liveHoveredIndex = -1;
		this.#liveAgents = collectLiveAgents(this.#registry.listInScope(this.#effectiveScope()));
		const kept = selectedId ? this.#liveAgents.findIndex(agent => agent.id === selectedId) : -1;
		this.#liveSelectedIndex =
			kept >= 0 ? kept : clampLow(this.#liveSelectedIndex, 0, Math.max(0, this.#liveAgents.length - 1));
	}

	#scopedComms(): IrcLogEntry[] {
		const scope = this.#effectiveScope();
		if (!scope) return this.#irc.log();
		const log = this.#irc.log();
		const result: IrcLogEntry[] = [];
		for (let si = 0; si < log.length; si++) {
			if (AgentRegistry.sameScope(log[si]!.scope, scope)) result.push(log[si]!);
		}
		return result;
	}

	#observableFor(id: string): ObservableSession | undefined {
		const sessions = this.#observers?.getSessions();
		if (!sessions) return undefined;
		for (let si = 0; si < sessions.length; si++) {
			if (sessions[si]!.id === id) return sessions[si]!;
		}
		return undefined;
	}

	#callSignFor(id: string): string {
		for (let ai = 0; ai < this.#liveAgents.length; ai++) {
			if (this.#liveAgents[ai]!.id === id) return this.#liveAgents[ai]!.callSign;
		}
		return id;
	}

	#extrasFor(agent: LiveAgent): RosterExtras {
		const observed = this.#observableFor(agent.id);
		return {
			unread: this.#irc.unreadCount(agent.id),
			task: observed?.description ?? observed?.progress?.task,
			model: this.#deps.showModelBadge ? this.#modelBadge(agent, observed) : undefined,
		};
	}

	#modelBadge(agent: LiveAgent, observed: ObservableSession | undefined): string | undefined {
		const resolved = observed?.progress?.resolvedModel ?? agent.model;
		if (!resolved) return undefined;
		const badge = modelBadgeFromSelector(resolved, theme);
		return observed?.progress?.fellBackFrom ? `${theme.fg("dim", "↓")}${badge}` : badge;
	}

	#filteredComms(): IrcLogEntry[] {
		const filter = this.#commsFilter;
		if (!filter) return this.#comms;
		const result: IrcLogEntry[] = [];
		for (let fi = 0; fi < this.#comms.length; fi++) {
			const entry = this.#comms[fi]!;
			if (entry.message.from === filter || entry.message.to === filter) result.push(entry);
		}
		return result;
	}

	#commsParticipants(): string[] {
		const seenSet = new Set<string>();
		const seen: string[] = [];
		for (let ei = 0; ei < this.#comms.length; ei++) {
			const entry = this.#comms[ei]!;
			const ids = [entry.message.from, entry.message.to];
			for (let ii = 0; ii < ids.length; ii++) {
				const id = ids[ii]!;
				if (!seenSet.has(id)) {
					seenSet.add(id);
					seen.push(id);
				}
			}
		}
		return seen;
	}

	#cycleCommsFilter(): void {
		const participants = this.#commsParticipants();
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

	#canFilterComms(): boolean {
		return this.#commsParticipants().length > 1 || this.#commsFilter !== undefined;
	}

	#commsSummary(): string {
		const shown = this.#filteredComms();
		let failed = 0;
		for (let fi = 0; fi < shown.length; fi++) {
			if (shown[fi]!.outcome === "failed") failed++;
		}
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

	#viewTabs(): ViewTab[] {
		return [
			{ id: "live", label: "Live", count: this.#liveAgents.length },
			{ id: "comms", label: "Comms", count: this.#filteredComms().length },
		];
	}

	#terminalRows(): number {
		return process.stdout.rows || this.#terminalHeight || 24;
	}

	#computeBodyHeight(): number {
		const budget = Math.max(1, this.#bodyBudget - 2 - (this.#notice ? 2 : 0));
		if (this.#activeView !== "live") return Math.max(1, budget - 2);
		return Math.min(budget, Math.max(AgentDashboard.#MIN_ROSTER_ROWS, this.#liveAgents.length));
	}

	#expandHint(): string {
		return keyHint(this.#expandKeys);
	}

	#scopeHint(): string {
		if (this.#processScope) return this.#deps.scope ? "a this conversation" : "";
		return this.#deps.scope ? "a all conversations" : "";
	}

	#currentShortcuts(): readonly ModalShortcut[] {
		return this.#activeView === "live"
			? liveShortcuts(this.#liveAgents.length, this.#scopeHint())
			: commsShortcuts(this.#expandHint(), this.#canFilterComms(), this.#scopeHint());
	}

	override render(width: number): readonly string[] {
		const area = this.#terminalRows();
		const sizing = sizingForArea(MODAL_SIZING_LARGE, area);
		const dims = computeModalDims(width, area, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return new Array(area).fill(padding(width));
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
		if (area !== this.#builtRows || dims.contentWidth !== this.#builtCols) {
			this.#buildLayout();
		}

		const body = super.render(dims.contentWidth);
		const shell = renderModalShell({
			title: this.#processScope ? "Agent Control Center — all conversations" : "Agent Control Center",
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
		const from = this.#commsScrollOffset === "tail" ? this.#commsResolvedStart : this.#commsScrollOffset;
		const next = clampLow(from + delta, 0, Number.MAX_SAFE_INTEGER);
		this.#commsScrollOffset = next >= this.#commsResolvedStart && delta > 0 ? "tail" : next;
		this.#buildLayout();
	}

	#movePage(direction: -1 | 1): void {
		this.#moveSelection(direction * Math.max(1, this.#computeBodyHeight()));
	}

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
				this.#notice = actionFailedNotice("open", agent.callSign, error);
				this.#rebuildAndRender();
			},
		);
	}

	openTranscript(id: string): void {
		const ref = this.#registry.get(id);
		if (!ref) return;
		if (!AgentRegistry.sameScope(ref.scope, this.#effectiveScope())) return;
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
			expandArgot: this.#deps.expandArgot,
			expandKeys: this.#expandKeys.slice(),
			hubKeys: this.#hubKeys.slice(),
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

	#canTerminate(agent: LiveAgent): boolean {
		return agent.kind !== "main" && agent.kind !== "advisor";
	}

	killSelectedAgent(): void {
		const agent = this.#liveAgents[this.#liveSelectedIndex];
		if (!agent) return;
		this.#requestTermination(agent);
	}

	#requestTermination(agent: LiveAgent): void {
		if (agent.kind === "main") {
			this.#notice = this.#processScope
				? "A conversation is stopped by the session running it, not from this roster."
				: "The main session cannot be terminated from its own roster.";
			this.#rebuildAndRender();
			return;
		}
		if (agent.kind === "advisor") {
			this.#notice = `"${agent.id}" is a read-only advisor transcript, so there is nothing to terminate.`;
			this.#rebuildAndRender();
			return;
		}
		if (typeof this.#ui.showOverlay !== "function") {
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

	#renderTabBar(): string {
		const tabTheme = getTabBarTheme();
		const parts: string[] = [" "];
		this.#tabHits = [];
		let column = 1; // the leading space above
		const tabs = this.#viewTabs();
		for (let ti = 0; ti < tabs.length; ti++) {
			const tab = tabs[ti]!;
			const isActive = tab.id === this.#activeView;
			const text = `${tab.label} (${tab.count})`;
			const label = isActive ? `[${text}]` : ` ${text} `;
			this.#tabHits.push({ id: tab.id, start: column, end: column + visibleWidth(label) });
			column += visibleWidth(label);
			parts.push(isActive ? tabTheme.activeTab(label) : tabTheme.inactiveTab(label));
		}
		return parts.join("");
	}

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

	static readonly #MIN_ROSTER_ROWS = 4;

	#preferredBodyRows(bodyRows: number): number {
		if (this.#activeView !== "live") return bodyRows;
		return Math.max(bodyRows, this.#paneRowOffset() + AgentDashboard.#MIN_ROSTER_ROWS);
	}

	#paneRowOffset(): number {
		return 2 + (this.#notice ? 2 : 0);
	}

	#rosterIndexAt(row: number): number {
		const geometry = this.#shellGeometry;
		if (!geometry || this.#activeView !== "live") return -1;
		const offset = row - (geometry.bodyRowStart + this.#paneRowOffset());
		if (offset < 0 || offset >= this.#computeBodyHeight()) return -1;
		const index = this.#liveScrollOffset + offset;
		return index < this.#liveAgents.length ? index : -1;
	}

	#setHoveredRosterIndex(index: number): void {
		if (this.#liveHoveredIndex === index) return;
		this.#liveHoveredIndex = index;
		this.#buildLayout();
		this.onRequestRender?.();
	}

	#isTerminationActionAt(index: number, col: number): boolean {
		const agent = this.#liveAgents[index];
		if (!agent || !this.#canTerminate(agent)) return false;
		const actionStart = this.#bodyColStart + this.#rosterContentWidth - 3;
		return col >= actionStart && col < actionStart + 3;
	}

	#tabAt(row: number, col: number): ViewId | undefined {
		const geometry = this.#shellGeometry;
		if (!geometry || row !== geometry.bodyRowStart) return undefined;
		const column = col - this.#bodyColStart;
		return this.#tabHits.find(hit => column >= hit.start && column < hit.end)?.id;
	}

	#handleMouse(data: string): void {
		routeSgrMouseInput(data, event => {
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

		if (data === "a" && this.#deps.scope) {
			this.toggleProcessScope();
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

		for (const key of this.#expandKeys) {
			if (matchesKey(data, key)) {
				this.#commsExpanded = !this.#commsExpanded;
				this.#buildLayout();
				this.onRequestRender?.();
				return;
			}
		}

		if (data === "f") {
			this.#cycleCommsFilter();
		}
	}
}
