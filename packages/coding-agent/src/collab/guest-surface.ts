/**
 * What the guest side of a collab session needs from the host drawing it.
 *
 * `CollabGuestLink` replicates the host's session: it writes the snapshot to a
 * replica file, switches to it, and then applies live frames. Every one of
 * those steps ends in something drawn — a transcript redrawn from its first
 * entry, a status segment stating the room, a host question put to the
 * operator — and the terminal was the only place any of it could land, which
 * is why a window could host a share and not join one.
 *
 * This is the same shape `CollabHostSurface` takes for the hosting side: the
 * replication stays in the link, and what a host draws stays with the host. A
 * terminal draws a container and a status line; a window sends a snapshot
 * section and raises a decision card.
 */

import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { Settings } from "../config/settings";
import type { InteractiveModeContext } from "../modes/terminal/types";
import type { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-types";
import type { EventBus } from "../utils/event-bus";
import { setSessionTerminalTitle } from "../utils/title-generator";
import type { CollabSessionState, CollabUiRequest } from "./protocol";

/** The share segment a guest states, or null once it is no longer in one. */
export interface CollabGuestStatus {
	role: "guest";
	participantCount: number;
	/** The host's own state, which the guest displays instead of its local one. */
	stateOverride: CollabSessionState | null;
}

export interface CollabGuestSurface {
	/** The session the replica is loaded into. */
	readonly session: AgentSession;
	/** Where a replicated entry is ingested and the replica file is read from. */
	readonly sessionManager: SessionManager;
	/** Read for the display name the guest introduces itself with. */
	readonly settings: Settings;
	/** Where mirrored host bus traffic is republished, when the host has one. */
	readonly eventBus?: EventBus;

	/** Apply one mirrored host event as if the local session had raised it. */
	handleEvent(event: AgentSessionEvent): void;

	/** Hold the live link, or drop it once the guest has left. */
	setGuestLink(link: CollabGuestSession | undefined): void;

	/** Draw the session just switched to, from its first entry. */
	redrawSession(): Promise<void>;

	/** State the session's name and directory where the host states them. */
	setSessionTitle(name: string | undefined, cwd: string | undefined): void;

	/** Drop what was drawn for the previous session: streams, queues, loaders. */
	clearTransientState(): void;

	/** Drop the per-session observers the previous session registered. */
	resetObservers(): void;

	/** Restate the mirrored agents after a snapshot or an `agents` frame. */
	agentsChanged(): void;

	/** Fold the host's activity window into the meter it is measured in. */
	setHostStreaming(streaming: boolean): void;

	/** State the room and its party count, or clear the segment when null. */
	setCollabStatus(status: CollabGuestStatus | null): void;

	/**
	 * State whether the relay socket is up: false while a dropped connection
	 * is retried, true once the welcome that follows has been applied.
	 */
	setConnected(connected: boolean): void;

	showStatus(message: string, options?: { dim?: boolean }): void;

	showError(message: string): void;

	/**
	 * Put the host's question to the operator, answering with what they chose
	 * or wrote, and with `undefined` when they dismissed it.
	 *
	 * `signal` aborts the presentation when the host settles the request
	 * elsewhere; an aborted presentation answers nothing, so it must not
	 * resolve to a value.
	 */
	askGuest(request: CollabUiRequest, signal: AbortSignal): Promise<string | undefined>;

	/**
	 * Open what was open before the join: `file` when the guest replaced a
	 * session, and a new one when it replaced nothing.
	 */
	restoreSession(file: string | null): Promise<void>;
}

/**
 * The link as its host holds it: what a host stores, states and drives from a
 * command, without naming the replication behind it.
 */
export interface CollabGuestSession {
	/** True when the room was joined through a read-only link. */
	readonly readOnly: boolean;
	/** The host's last reported state, or null before the first welcome. */
	readonly state: CollabSessionState | null;
	/** The host's agents, mirrored; a guest has none of its own to list. */
	readonly agentRegistry: AgentRegistry;
	leave(reason: string): Promise<void>;
}

export type TerminalGuestSurfaceContext = Pick<
	InteractiveModeContext,
	| "chatContainer"
	| "clearWorkingLoader"
	| "collabGuest"
	| "compactionQueuedMessages"
	| "eventBus"
	| "eventController"
	| "handleResumeSession"
	| "pendingMessagesContainer"
	| "pendingTools"
	| "reloadTodos"
	| "renderInitialMessages"
	| "resetObserverRegistry"
	| "session"
	| "sessionManager"
	| "settings"
	| "showError"
	| "showHookEditor"
	| "showHookSelector"
	| "showStatus"
	| "statusContainer"
	| "statusLine"
	| "streamingComponent"
	| "streamingMessage"
	| "syncRunningAgentBadge"
	| "ui"
	| "updateEditorBorderColor"
>;

export type CollabGuestContext = TerminalGuestSurfaceContext;

/**
 * Construct a CollabGuestSurface backed by terminal interactive context components.
 */
export function createTerminalCollabGuestSurface(ctx: TerminalGuestSurfaceContext): CollabGuestSurface {
	return {
		get session() {
			return ctx.session;
		},
		get sessionManager() {
			return ctx.sessionManager;
		},
		get settings() {
			return ctx.settings;
		},
		get eventBus() {
			return ctx.eventBus;
		},
		handleEvent(event: AgentSessionEvent): void {
			void ctx.eventController.handleEvent(event);
		},
		setGuestLink(link: CollabGuestSession | undefined): void {
			ctx.collabGuest = link as unknown as typeof ctx.collabGuest;
		},
		async redrawSession(): Promise<void> {
			ctx.chatContainer.clear();
			ctx.renderInitialMessages({ clearTerminalHistory: true });
			await ctx.reloadTodos();
		},
		setSessionTitle(name: string | undefined, cwd: string | undefined): void {
			setSessionTerminalTitle(name, cwd);
		},
		clearTransientState(): void {
			ctx.statusContainer.clear();
			ctx.pendingMessagesContainer.clear();
			ctx.compactionQueuedMessages = [];
			ctx.streamingComponent = undefined;
			ctx.streamingMessage = undefined;
			ctx.pendingTools.clear();
			ctx.clearWorkingLoader();
		},
		resetObservers(): void {
			ctx.resetObserverRegistry();
		},
		agentsChanged(): void {
			ctx.syncRunningAgentBadge();
		},
		setHostStreaming(streaming: boolean): void {
			if (streaming) {
				ctx.statusLine.markActivityStart();
			} else {
				ctx.statusLine.markActivityEnd();
				ctx.clearWorkingLoader();
			}
		},
		setCollabStatus(status: CollabGuestStatus | null): void {
			ctx.statusLine.setCollabStatus(status);
			ctx.statusLine.invalidate();
			ctx.ui.requestRender();
		},
		setConnected(_connected: boolean): void {
			// Terminal implementation is inert; desktop draws it in share card.
		},
		showStatus(message: string, options?: { dim?: boolean }): void {
			ctx.showStatus(message, options);
		},
		showError(message: string): void {
			ctx.showError(message);
		},
		async askGuest(request: CollabUiRequest, signal: AbortSignal): Promise<string | undefined> {
			if (request.kind === "select") {
				return ctx.showHookSelector(request.title, request.options, {
					signal,
					initialIndex: request.initialIndex,
					selectionMarker: request.selectionMarker,
					checkedIndices: request.checkedIndices,
					markableCount: request.markableCount,
					helpText: request.helpText,
				});
			}
			return ctx.showHookEditor(request.title, request.prefill, { signal });
		},
		async restoreSession(file: string | null): Promise<void> {
			if (file) {
				await ctx.handleResumeSession(file);
				return;
			}
			await ctx.session.newSession();
			setSessionTerminalTitle(ctx.sessionManager.getSessionName(), ctx.sessionManager.getCwd());
			ctx.statusLine.invalidate();
			ctx.statusLine.resetActiveTime();
			ctx.ui.requestRender();
			ctx.updateEditorBorderColor();
			ctx.renderInitialMessages({ clearTerminalHistory: true });
			await ctx.reloadTodos();
			ctx.ui.requestRender(true, { clearScrollback: true });
		},
	};
}
