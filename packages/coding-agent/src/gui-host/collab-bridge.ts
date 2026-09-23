import type * as net from "node:net";
import { errorMessage, logger } from "@veyyon/utils";
import { resolveRelayUrl } from "@veyyon/wire";
import { collabDisplayName } from "../collab/display-name";
import { CollabHost } from "../collab/host";
import type { CollabHostSurface } from "../collab/host-surface";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { writeFrame } from "./frames";
import type { ClientSessionState } from "./turns";
import type { ShareParticipantView, SharePhase, ShareView, SnapshotSection } from "./wire";

/**
 * The `CollabHostSurface` a desktop window is shown a share through.
 *
 * A share belongs to the connection that started it, so the window to state a
 * change to is the one holding this bridge's socket.
 */
export class DesktopCollabBridge implements CollabHostSurface {
	readonly session: AgentSession;
	readonly clientState: ClientSessionState;
	readonly socket?: net.Socket;
	collabHost?: CollabHost;
	phase: SharePhase = "off";
	error: string | null = null;
	readOnly = false;

	constructor(session: AgentSession, clientState: ClientSessionState, socket?: net.Socket) {
		this.session = session;
		this.clientState = clientState;
		this.socket = socket;
	}

	buildView(): ShareView {
		const relayUrl = resolveRelayUrl(this.session.settings.get("collab.relayUrl") || "") || null;

		if (!this.collabHost || this.phase === "off") {
			return {
				state: this.phase,
				role: this.phase === "off" ? "Off" : "Hosting",
				relay_url: relayUrl,
				link: null,
				web_link: null,
				view_link: null,
				web_view_link: null,
				participants: [],
				guest: null,
				error: this.error,
			};
		}

		const host = this.collabHost;
		const participants: ShareParticipantView[] = [
			{ id: 0, name: collabDisplayName(this.session), can_write: true, is_host: true },
		];
		for (const [id, peer] of host.peers) {
			participants.push({
				id,
				name: peer.name,
				can_write: peer.canWrite,
				is_host: false,
			});
		}

		return {
			state: this.phase,
			role: "Hosting",
			relay_url: relayUrl,
			link: this.readOnly ? null : host.link || null,
			web_link: this.readOnly ? null : host.webLink || null,
			view_link: host.viewLink || null,
			web_view_link: host.webViewLink || null,
			participants,
			guest: null,
			error: this.error,
		};
	}

	currentSection(): SnapshotSection {
		return { Share: this.buildView() };
	}

	changed(): void {
		if (!this.socket || this.socket.destroyed) return;
		writeFrame(this.socket, { Snapshot: this.currentSection() });
	}

	setCollabStatus(): void {
		this.changed();
	}

	requestRender(): void {
		this.changed();
	}

	updatePendingMessagesDisplay(): void {
		// Terminal-specific message queue rendering; inert on desktop GUI host.
	}

	showStatus(message: string, type?: { dim?: boolean }): void {
		logger.info(message, { dim: type?.dim });
	}

	getCachedContextBreakdown(): null {
		return null;
	}

	async start(readOnly = false): Promise<void> {
		// A share that is already running is not replaced. Starting again would
		// mint a second room and drop the first, so every guest holding the link
		// this session handed out would be left on a room nothing is hosting,
		// with nothing said to them. The card draws no start control while
		// hosting; this refuses the action itself, which is reachable without it.
		if (this.phase !== "off") {
			throw new Error(`A share is already ${this.phase}; stop it before starting another`);
		}
		const relayUrl = resolveRelayUrl(this.session.settings.get("collab.relayUrl") || "");
		if (!relayUrl) {
			this.error = "No relay configured. Set collab.relayUrl in settings.";
			this.phase = "off";
			this.changed();
			throw new Error("No relay configured. Set collab.relayUrl in settings.");
		}

		const webUrl = this.session.settings.get("collab.webUrl") || "";
		// Built before the phase moves, so the only path that states `starting`
		// is one whose failures are caught below. A throw from here with the
		// phase already moved would leave a share that never starts and cannot
		// be started again, since a second start is refused while one is live.
		const host = new CollabHost({
			session: this.session,
			sessionManager: this.session.sessionManager,
			settings: this.session.settings,
			surface: this,
		});
		this.phase = "starting";
		this.error = null;
		this.readOnly = readOnly;
		this.changed();

		try {
			await host.start(relayUrl, webUrl);
			this.collabHost = host;
			this.phase = "hosting";
			this.changed();
		} catch (err) {
			this.phase = "off";
			this.error = errorMessage(err);
			this.collabHost = undefined;
			this.changed();
			throw err;
		}
	}

	async stop(): Promise<void> {
		if (!this.collabHost || this.phase === "off") return;
		this.phase = "stopping";
		this.changed();
		try {
			await this.collabHost.stop("host stopped");
		} finally {
			this.collabHost = undefined;
			this.phase = "off";
			this.changed();
		}
	}
}

export function attachCollabBridge(
	session: AgentSession,
	state: ClientSessionState,
	socket?: net.Socket,
): DesktopCollabBridge {
	if (state.collabBridge && state.collabBridge.session === session) {
		return state.collabBridge;
	}
	const bridge = new DesktopCollabBridge(session, state, socket);
	state.collabBridge = bridge;
	return bridge;
}

/**
 * The share a window is shown: the one it hosts, the one it joined, or none.
 *
 * A window is on one side at a time — hosting refuses a join and a guest
 * refuses a start — so whichever bridge is off yields to the other. With
 * neither there is no share, and the card still states the relay a start
 * would dial, resolved from the settings the action acts on rather than from
 * a session that need not exist yet.
 */
export function shareSection(state?: ClientSessionState, settings?: Settings): SnapshotSection {
	const guest = state?.collabGuestBridge;
	if (guest && guest.phase !== "off") return guest.currentSection();
	const host = state?.collabBridge;
	if (host) return host.currentSection();
	const relayUrl = resolveRelayUrl(settings?.get("collab.relayUrl") || "") || null;
	return {
		Share: {
			state: "off",
			role: "Off",
			relay_url: relayUrl,
			link: null,
			web_link: null,
			view_link: null,
			web_view_link: null,
			participants: [],
			guest: null,
			error: null,
		},
	};
}
