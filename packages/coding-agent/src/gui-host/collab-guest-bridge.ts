import type * as net from "node:net";
import { errorMessage, logger } from "@veyyon/utils";
import { parseCollabLink, resolveRelayUrl } from "@veyyon/wire";
import { CollabGuestLink } from "../collab/guest";
import type { CollabGuestSession, CollabGuestStatus, CollabGuestSurface } from "../collab/guest-surface";
import type { CollabUiRequest } from "../collab/protocol";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-types";
import { agentsSection } from "./actions/agents";
import { writeFrame } from "./frames";
import { sessionHeaderToView } from "./session-bridge";
import { cancelStreamingFrame } from "./streaming-frames";
import { sessionEntriesToTranscript } from "./transcript-conversion";
import { type ClientSessionState, handleSessionEvent } from "./turns";
import type { HostEvent, ShareGuestView, SharePhase, ShareView, SnapshotSection } from "./wire";

/**
 * The `CollabGuestSurface` a desktop window joins a share through.
 *
 * The replica lands in the window's own session, so everything a local turn
 * draws — the transcript, the run bar, a decision card — draws the host's turn
 * unchanged. What is left is the share card, which this bridge keeps current,
 * and the questions the host asks, which arrive as ordinary decisions.
 */
export class DesktopCollabGuestBridge implements CollabGuestSurface {
	readonly session: AgentSession;
	readonly clientState: ClientSessionState;
	readonly socket?: net.Socket;
	phase: SharePhase = "off";
	error: string | null = null;
	#link?: CollabGuestSession;
	#room = "";
	#status: CollabGuestStatus | null = null;
	#connected = false;

	constructor(session: AgentSession, clientState: ClientSessionState, socket?: net.Socket) {
		this.session = session;
		this.clientState = clientState;
		this.socket = socket;
	}

	get sessionManager(): AgentSession["sessionManager"] {
		return this.session.sessionManager;
	}

	get settings(): Settings {
		return this.session.settings;
	}

	/** The room this window is in, for a card that draws it and for `agentsSection`. */
	get link(): CollabGuestSession | undefined {
		return this.#link;
	}

	guestView(): ShareGuestView | null {
		if (!this.#link || this.phase === "off") return null;
		const host = this.#status?.stateOverride?.participants.find(peer => peer.role === "host");
		return {
			room: this.#room,
			host_name: host?.name ?? null,
			read_only: this.#link.readOnly,
			connected: this.#connected,
		};
	}

	buildView(): ShareView {
		return {
			state: this.phase,
			role: this.phase === "off" ? "Off" : "Guest",
			relay_url: resolveRelayUrl(this.settings.get("collab.relayUrl") || "") || null,
			link: null,
			web_link: null,
			view_link: null,
			web_view_link: null,
			participants: this.#participants(),
			guest: this.guestView(),
			error: this.error,
		};
	}

	currentSection(): SnapshotSection {
		return { Share: this.buildView() };
	}

	changed(): void {
		this.#write({ Snapshot: this.currentSection() });
	}

	/**
	 * Join the room the link names, leaving the window on the host's session.
	 *
	 * The link is parsed before the phase moves so a malformed one fails with
	 * the card still off, rather than leaving a window stuck in `joining` with
	 * nothing to leave.
	 */
	async join(url: string): Promise<void> {
		if (this.phase !== "off") {
			throw new Error(`This window is already ${this.phase} a share; leave it before joining another`);
		}
		const parsed = parseCollabLink(url);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#room = parsed.roomId;
		this.error = null;
		this.phase = "joining";
		this.changed();
		try {
			await new CollabGuestLink(this).join(url);
			this.phase = "joined";
			this.changed();
		} catch (error) {
			this.phase = "off";
			this.error = errorMessage(error);
			this.#link = undefined;
			this.#room = "";
			this.changed();
			throw error;
		}
	}

	/** Leave the room and return the window to the session it left. */
	async leave(reason = "left"): Promise<void> {
		const link = this.#link;
		if (!link || this.phase === "off") return;
		this.phase = "leaving";
		this.changed();
		try {
			await link.leave(reason);
		} finally {
			// `setGuestLink(undefined)` from the link itself already settles the
			// phase on the ordinary path; a leave that threw settles it here so
			// the card cannot be left drawing a room this window is out of.
			this.#link = undefined;
			this.#status = null;
			this.#connected = false;
			this.#room = "";
			this.phase = "off";
			this.changed();
		}
	}

	handleEvent(event: AgentSessionEvent): void {
		if (!this.socket || this.socket.destroyed) return;
		handleSessionEvent(event, this.socket, this.clientState);
	}

	setGuestLink(link: CollabGuestSession | undefined): void {
		this.#link = link;
		this.clientState.collabGuestLink = link;
		if (!link) {
			this.#status = null;
			this.#connected = false;
			this.#room = "";
			this.phase = "off";
		} else if (this.phase === "off") {
			this.phase = "joining";
		}
		this.changed();
	}

	async redrawSession(): Promise<void> {
		// The link switched the session in place, so the window is told the
		// header first and the transcript under it, in the order a session
		// switch states them: the transcript carries no session id and files
		// under the last header the window received.
		this.clientState.sessionManager = this.session.sessionManager;
		this.#emitActiveSession();
		const sm = this.session.sessionManager;
		this.clientState.revision += 1;
		this.#write({
			Snapshot: {
				Transcript: {
					revision: this.clientState.revision,
					value: sessionEntriesToTranscript(sm.getEntries(), this.clientState.revision, {
						ledger: this.clientState.presentationLedger,
						session: this.session,
					}),
				},
			},
		});
		this.agentsChanged();
	}

	setSessionTitle(name: string | undefined, cwd: string | undefined): void {
		this.#emitActiveSession(name, cwd);
	}

	clearTransientState(): void {
		cancelStreamingFrame(this.clientState);
		this.clientState.streamingEntry = undefined;
		this.clientState.streamingSeq = undefined;
		this.clientState.streamingTool = undefined;
		this.clientState.streamingToolCallId = undefined;
		this.clientState.streamingAccumulating = undefined;
		this.clientState.presentationLedger.clear();
		// A decision raised by the session being replaced is answered by nobody
		// once its transcript is gone; the signalled ones belong to the caller
		// holding the signal and are left to it.
		this.clientState.interactions?.cancelUnsignalled();
		this.#write({ StreamingChanged: null });
	}

	resetObservers(): void {
		// The terminal re-registers per-session transcript observers here. A
		// window holds none: what it drew for the previous session is the tool
		// view ledger, which `clearTransientState` empties.
	}

	agentsChanged(): void {
		this.#write({ Snapshot: { Agents: agentsSection(undefined, this.#link?.agentRegistry) } });
	}

	setHostStreaming(streaming: boolean): void {
		// A host that is streaming says so through the deltas it mirrors, which
		// the window draws as its own stream. What they cannot carry is the end
		// of a turn this window never saw start — a reconnect mid-turn — so an
		// idle host clears the stream the previous connection left open.
		if (streaming) return;
		cancelStreamingFrame(this.clientState);
		this.clientState.streamingEntry = undefined;
		this.clientState.streamingSeq = undefined;
		this.clientState.streamingTool = undefined;
		this.clientState.streamingToolCallId = undefined;
		this.clientState.streamingAccumulating = undefined;
		this.#write({ StreamingChanged: null });
	}

	setCollabStatus(status: CollabGuestStatus | null): void {
		this.#status = status;
		if (status && this.phase === "joining") this.phase = "joined";
		this.changed();
	}

	setConnected(connected: boolean): void {
		if (this.#connected === connected) return;
		this.#connected = connected;
		this.changed();
	}

	showStatus(message: string, options?: { dim?: boolean }): void {
		logger.info(message, { dim: options?.dim });
	}

	showError(message: string): void {
		this.error = message;
		this.changed();
	}

	askGuest(request: CollabUiRequest, signal: AbortSignal): Promise<string | undefined> {
		const ledger = this.clientState.interactions;
		if (!ledger) return Promise.resolve(undefined);
		if (request.kind === "select") {
			return ledger.choice(
				request.title,
				request.options.map(option => (typeof option === "string" ? option : { ...option })),
				{ signal, initialIndex: request.initialIndex, helpText: request.helpText },
			);
		}
		// A window's question card takes free text with no seeded value, so a
		// prefill is put where the operator can read and retype it rather than
		// dropped from the question the host asked.
		const prompt = request.prefill ? `${request.title}\n\n${request.prefill}` : request.title;
		return ledger.text(prompt, { signal });
	}

	async restoreSession(file: string | null): Promise<void> {
		if (file) await this.session.switchSession(file);
		else await this.session.newSession();
		this.clientState.sessionManager = this.session.sessionManager;
		await this.redrawSession();
		await this.clientState.refreshSessionList?.();
	}

	#participants(): ShareView["participants"] {
		const peers = this.#status?.stateOverride?.participants ?? [];
		return peers.map((peer, index) => ({
			id: index,
			name: peer.name,
			can_write: peer.readOnly !== true,
			is_host: peer.role === "host",
		}));
	}

	#emitActiveSession(title?: string, cwd?: string): void {
		const sm = this.session.sessionManager;
		const view = sessionHeaderToView(sm.getHeader(), sm.getEntries());
		this.clientState.revision += 1;
		this.#write({
			Snapshot: {
				ActiveSession: {
					revision: this.clientState.revision,
					value: { ...view, title: title ?? view.title, cwd: cwd ?? view.cwd },
				},
			},
		});
	}

	#write(event: HostEvent): void {
		if (!this.socket || this.socket.destroyed) return;
		writeFrame(this.socket, event);
	}
}

/** The guest bridge this client holds, created on the first join. */
export function attachCollabGuestBridge(
	session: AgentSession,
	state: ClientSessionState,
	socket?: net.Socket,
): DesktopCollabGuestBridge {
	if (state.collabGuestBridge && state.collabGuestBridge.session === session) {
		return state.collabGuestBridge;
	}
	const bridge = new DesktopCollabGuestBridge(session, state, socket);
	state.collabGuestBridge = bridge;
	return bridge;
}

/**
 * Why this window cannot join a share, or `undefined` when it can.
 *
 * A window hosts or joins, never both: a host that joined would replicate a
 * second session over the one its own guests are reading. The card and
 * `/join` refuse on the same sentence because they reach the same bridge.
 */
export function joinRefusal(state: ClientSessionState): string | undefined {
	const host = state.collabBridge;
	if (host && host.phase !== "off") {
		return "This window hosts a share. Stop it before joining another.";
	}
	return undefined;
}

/**
 * Out of the share this window is in, whichever side of it the window is on.
 *
 * `/leave` in the terminal ends a hosted share as well as a joined one, so
 * the action and the command behind the desktop's own `/leave` do too: one
 * spelling, one behaviour. A window in neither is left as it was.
 */
export async function leaveShareOnWindow(state: ClientSessionState): Promise<void> {
	const guest = state.collabGuestBridge;
	if (guest && guest.phase !== "off") {
		await guest.leave("left");
		return;
	}
	await state.collabBridge?.stop();
}
