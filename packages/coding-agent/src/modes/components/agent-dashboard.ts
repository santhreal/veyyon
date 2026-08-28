import {
	Container,
	matchesKey,
	type OverlayHandle,
	padding,
	replaceTabs,
	routeSgrMouseInput,
	Spacer,
	sanitizeSingleLine,
	Text,
	type TUI,
	visibleWidth,
} from "@veyyon/tui";
import { clampLow, getProjectDir, logger } from "@veyyon/utils";
import type { KeyId } from "../../config/keybindings";
import { IrcBus, type IrcLogEntry } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry } from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-subagents";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { getTabBarTheme } from "../shared";
import { theme } from "../theme/theme";
import { keyHint } from "../utils/key-hint";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { collectLiveAgents, type LiveAgent } from "./agent-activity";
import {
	type AgentDashboardDeps,
	AgentTerminationDialog,
	actionFailedNotice,
	CommsPane,
	commsShortcuts,
	LiveRosterPane,
	liveShortcuts,
	type RosterExtras,
	VIEW_ORDER,
	type ViewId,
	type ViewTab,
} from "./agent-dashboard-helpers";
import { modelBadgeFromSelector } from "./agent-model-badge";
import { AgentTranscriptViewer } from "./agent-transcript-viewer";
import { AGENT_VIEW_AGE_TICK_MS, AGENT_VIEW_DATA_CHANGE_COALESCE_MS } from "./agent-view-timings";
import {
	CARD_BODY_COL_INSET,
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	type ModalShellGeometry,
	type ModalShortcut,
	planModalChrome,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";
import { clampSelection, handleTabSwitchKey } from "./selector-helpers";

export type { AgentDashboardDeps } from "./agent-dashboard-helpers";

export class AgentDashboard extends Container {
	#activeView: ViewId = "live";

	/**
	 * Whether the roster and the stream show the whole process or one
	 * conversation. `#deps.scope` stays the conversation this card was opened
	 * for, so narrowing back is exact rather than a guess.
	 */
	#processScope: boolean;

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
	 * Agent id the stream is narrowed to, or `undefined` for every message.
	 *
	 * A four-agent run interleaves four conversations into one column, and the
	 * question an operator actually has is almost never "what was said" but "what
	 * did Kestrel say and hear". Cycled with `f` over the agents that appear in
	 * the log rather than over the roster, because an agent that has since been
	 * released still said what it said and its half of the exchange is exactly
	 * what you go looking for after it is gone.
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
		this.#processScope = deps.processScope ?? false;
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
	 * Whether the roster has nothing worth opening the card for.
	 *
	 * The driving session is always registered, so it does not count: a card
	 * raised by the `←←` gesture must stay inert until there is a SUBAGENT to
	 * look at. Agents persisted by previous runs arrive later; callers that need
	 * those included wait for {@link persistedSubagentsReady} first.
	 */
	get isEmpty(): boolean {
		return this.#liveAgents.every(agent => agent.kind === "main");
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

	/**
	 * The conversation the roster and the stream are filtered to, or undefined
	 * for the whole process.
	 *
	 * One accessor rather than a check at each read site, so the roster, the
	 * stream and the transcript guard cannot disagree about what the card is
	 * currently showing — a card that LISTS a row it then refuses to open is
	 * worse than one that never listed it.
	 */
	#effectiveScope(): string | undefined {
		return this.#processScope ? undefined : this.#deps.scope;
	}

	/**
	 * `a`: widen to every conversation in the process, or narrow back.
	 *
	 * A plain letter, like `x` and `f`, because the card owns every key while it
	 * is open, and Tab is already the view switch. Selection is not carried
	 * across: the rows either side of the toggle are different sets, and keeping
	 * an index would land the cursor on an unrelated agent.
	 */
	toggleProcessScope(): void {
		this.#processScope = !this.#processScope;
		this.#notice = undefined;
		this.#liveSelectedIndex = 0;
		this.#liveScrollOffset = 0;
		this.#refreshLiveAgents();
		this.#comms = this.#scopedComms();
		this.#buildLayout();
	}

	/** Whether the card is currently showing every conversation in the process. */
	get showingWholeProcess(): boolean {
		return this.#processScope;
	}

	#refreshLiveAgents(): void {
		const selectedId = this.#liveAgents[this.#liveSelectedIndex]?.id;
		this.#liveHoveredIndex = -1;
		this.#liveAgents = collectLiveAgents(this.#registry.listInScope(this.#effectiveScope()));
		// Keep the cursor on the AGENT, not on the row number: a spawn or a park
		// reorders the roster under an operator who is about to press Enter.
		const kept = selectedId ? this.#liveAgents.findIndex(agent => agent.id === selectedId) : -1;
		this.#liveSelectedIndex =
			kept >= 0 ? kept : clampLow(this.#liveSelectedIndex, 0, Math.max(0, this.#liveAgents.length - 1));
	}

	/**
	 * The bus log, minus the traffic of other conversations sharing this process.
	 *
	 * The bus is process-global, so an ACP or cmux host driving several sessions
	 * at once, or a session resumed over a previous one, had every one of them
	 * reading the same stream. Filtered on the scope the BUS stamped on the line
	 * when it recorded it, not on who is in the registry now.
	 *
	 * That distinction is the whole fix. Filtering by current membership got both
	 * directions wrong: an agent released moments ago is unregistered, so its
	 * last words dropped off the pane that promises to keep them, and a stranger
	 * whose conversation had run an agent of the same name showed up under a live
	 * local id. A recorded stamp answers "whose line is this" once, at the only
	 * moment both endpoints were still addressable.
	 */
	#scopedComms(): IrcLogEntry[] {
		const scope = this.#effectiveScope();
		if (!scope) return this.#irc.log();
		return this.#irc.log().filter(entry => AgentRegistry.sameScope(entry.scope, scope));
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
	 * The traffic the stream is currently showing: everything, or one agent's
	 * half of it (as sender OR recipient, since a conversation is both).
	 */
	#filteredComms(): IrcLogEntry[] {
		const filter = this.#commsFilter;
		if (!filter) return this.#comms;
		return this.#comms.filter(entry => entry.message.from === filter || entry.message.to === filter);
	}

	/**
	 * Every agent that appears in the log, in the order they first appear.
	 *
	 * Order matters because `f` cycles through this list: an order that shuffled
	 * as messages arrived would move the filter under a repeated keypress, and
	 * first-appearance is stable for a log that only ever grows at the end.
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
	 * `f`: advance the filter one agent, wrapping through "everything".
	 *
	 * Cycling rather than opening a picker: the list is the handful of agents in
	 * this run, and a modal over a modal to choose one of three is more ceremony
	 * than the choice is worth. Returning to the stream's top is deliberate — a
	 * filter change replaces what is on screen, and holding a scroll offset from
	 * the previous set lands you in the middle of a conversation you did not ask
	 * to enter.
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
	 * The line above the stream: how much traffic there is, how much of it never
	 * landed, and what the stream is narrowed to.
	 *
	 * The undelivered count is the reason this line exists. A failure is stated
	 * on its own row, but a failed message five screens up is invisible, and "did
	 * anything not arrive" is the question you ask when a run has stalled and you
	 * are looking for why.
	 */
	#commsSummary(): string {
		const shown = this.#filteredComms();
		const failed = shown.filter(entry => entry.outcome === "failed").length;
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
			{ id: "comms", label: "Comms", count: this.#filteredComms().length },
		];
	}

	/** Live terminal height so the dashboard tracks resize while open. */
	#terminalRows(): number {
		return process.stdout.rows || this.#terminalHeight || 24;
	}

	/**
	 * Rows the pane actually draws, which is also the height scrolling and click
	 * hit-testing measure against, so all three agree.
	 *
	 * The Live roster hugs its content: it is a LIST whose length is known, and a
	 * roster padded to the full budget is the empty space under one agent that
	 * this card kept drawing. The Comms stream takes the whole budget instead,
	 * because it is a feed whose rows depend on the width it wraps at, and a feed
	 * that resizes its own frame as messages arrive is jitter.
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

	/**
	 * The chip names the scope the key moves TO, not the one you are in, so it
	 * reads as an action like every other chip. Dropped when the card has no
	 * conversation to narrow to (collab guest, render-only host), because
	 * offering a toggle between "everything" and "everything" is the same broken
	 * control the filter chip is dropped to avoid.
	 */
	#scopeHint(): string {
		if (this.#processScope) return this.#deps.scope ? "a this conversation" : "";
		return this.#deps.scope ? "a all conversations" : "";
	}

	#currentShortcuts(): readonly ModalShortcut[] {
		return this.#activeView === "live"
			? liveShortcuts(this.#liveAgents.length, this.#scopeHint())
			: commsShortcuts(this.#expandHint(), this.#canFilterComms(), this.#scopeHint());
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
			return Array.from({ length: area }, () => padding(width));
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
			// The title states the scope, because the two rosters look alike: a
			// conversation with no subagents and a process with one conversation
			// draw the same single row, and the chip below names where the key
			// GOES rather than where you are.
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
	 *
	 * Refuses an agent outside this card's conversation. The roster it is
	 * normally driven from is already scoped, but this is a public method taking
	 * a bare id, and the id is the whole authorization: a transcript is the most
	 * complete record an agent leaves, so opening one from a conversation this
	 * card does not belong to hands over the entire contents of somebody else's
	 * session.
	 */
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
		return agent.kind !== "main" && agent.kind !== "advisor";
	}

	/**
	 * `x`: ask before terminating the selected agent.
	 *
	 * A conversation is not terminated here, whether it is the one on screen or
	 * one running off it: stopping a conversation ends a turn, closes a provider
	 * stream and settles a transcript, which is the owning session's job and is
	 * what `session.newKeepsBackground` decides. An advisor is a read-only
	 * transcript rather than a running peer. Every real subagent opens the same
	 * focused confirmation card whether the request came from the keyboard or
	 * the row-local [x].
	 */
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
	 * Roster rows the card keeps room for even when fewer agents exist.
	 *
	 * This floor stops the first spawns from resizing the card under the cursor.
	 * The card is CENTRED, so a resize moves it at both edges at once: a roster
	 * that grew a row would shift the whole card up half a row while you read it.
	 *
	 * It was eight, on the reasoning that a resize while you read is worse than
	 * some empty space. That reasoning does not survive the common case. The card
	 * already grows past the floor as agents register, so it already resizes
	 * during a run; the floor only prevented SHRINKING below eight. It bought no
	 * stability where jitter actually happens and charged for it in the session
	 * shape most people have, one agent, which drew a single row and then six
	 * rows of bordered nothing.
	 *
	 * Four is the smallest floor that still buys the stability the floor is FOR:
	 * a one-agent card and a four-agent card are the same card, so the batch of
	 * subagents a run usually spawns lands without moving the panel. Below four
	 * the card twitches on the second spawn; above four it pays in empty rows for
	 * agents that are not there.
	 */
	static readonly #MIN_ROSTER_ROWS = 4;

	/**
	 * Body rows to ask the card for, which is the content it has plus the roster
	 * floor when the Live view has less than the floor to show.
	 *
	 * The floor cannot come from the pane: {@link #computeBodyHeight} is a CAP on
	 * what the roster may draw, and a roster of one agent draws one row whatever
	 * the cap is. Asking the shell for the taller body is what actually reserves
	 * the space, and it pads with blank rows inside the card rather than leaving
	 * the card to hug a single row and jump on the next spawn.
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

		// Bound above the per-view keys so it works from the roster AND the stream:
		// widening only one of them would make the two panes disagree about which
		// conversations the card is showing. Ignored where there is nothing to
		// narrow to, so the key matches the chip.
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
