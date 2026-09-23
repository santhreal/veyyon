/**
 * Guest side of a collab live session.
 *
 * `/join <link>` writes the host's snapshot to a replica session file and
 * drives it through the normal `/resume` machinery, then applies live frames:
 * entries → SessionManager + agent.replaceMessages, events →
 * EventController.handleEvent, state → status-line overrides plus real
 * model/thinking state applied to the replica agent. The host's agent
 * ecosystem is mirrored too: agent snapshots populate a local AgentRegistry
 * (the agent dashboard), EventBus traffic (observer HUD) is republished, and hub
 * actions (chat/kill/revive/transcript reads) round-trip over the wire.
 * Host ask dialogs (`ui-request` select/editor) present through the same
 * hook selector/editor seam and answer with `ui-response`; `ui-request-end`
 * dismisses a pending presentation without responding.
 * Everything renders through the same components, so ctrl+o, theming, and
 * transcript behavior are native by construction.
 */
import * as path from "node:path";
import type { ThinkingLevel } from "@veyyon/agent-core";
import type { ImageContent } from "@veyyon/ai";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { getConfigRootDir, logger } from "@veyyon/utils";
import { SNAPSHOT_PROGRESS_TIMEOUT_MS, TRANSCRIPT_TIMEOUT_MS, WELCOME_TIMEOUT_MS } from "@veyyon/wire";
import type {
	AgentTranscriptRemote,
	AgentTranscriptRemoteRead,
} from "../modes/terminal/components/dashboard/agent-transcript-viewer";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "../session/agent-session-types";
import { shouldDisableReasoning, toReasoningEffort } from "../thinking";
import { importRoomKey } from "./crypto";
import { collabDisplayName } from "./display-name";
import type { CollabGuestSession, CollabGuestSurface } from "./guest-surface";
import {
	type AgentSnapshot,
	COLLAB_PROTO,
	type CollabFrame,
	type CollabSessionState,
	type CollabUiRequest,
	fromWireAgentEvent,
	fromWireModel,
	fromWireSessionEntry,
	parseCollabLink,
} from "./protocol";
import { CollabSocket } from "./relay-client";

// The three join budgets are protocol-level and shared with every other guest
// implementation; see @veyyon/wire, which documents each one and owns its value.

type WelcomeFrame = Extract<CollabFrame, { t: "welcome" }>;
type SnapshotChunkFrame = Extract<CollabFrame, { t: "snapshot-chunk" }>;

/** Accumulator for an in-flight chunked welcome — see {@link CollabGuestLink}. */
interface PendingSnapshot {
	header: WelcomeFrame["header"];
	state: WelcomeFrame["state"];
	agents: AgentSnapshot[];
	readOnly: boolean;
	entryCount: number;
	entries: SessionEntry[];
	isResync: boolean;
}

export class CollabGuestLink implements CollabGuestSession {
	#surface: CollabGuestSurface;
	#socket: CollabSocket | null = null;
	#roomId = "";
	/** Previous session file to restore on leave; null = previous session was unsaved. */
	#returnSessionFile: string | null = null;
	/** The restore in flight, so every path that asks awaits the same one. */
	#restoring?: Promise<void>;
	/** Frames apply strictly in arrival order through this chain. */
	#applyChain: Promise<void> = Promise.resolve();
	/** True after the initial snapshot has been written to disk and resumed. */
	#welcomed = false;
	#left = false;
	/**
	 * Buffer for the in-flight chunked welcome. Set by the small `welcome`
	 * frame, accumulated by every `snapshot-chunk`, drained when the final
	 * chunk lands (or the snapshot-progress timer fires).
	 */
	#pendingSnapshot: PendingSnapshot | null = null;
	/**
	 * Fires `firstWelcome.reject` from a stalled welcome/snapshot during the
	 * initial join. Set in {@link join}, cleared on resolve/reject; arming a
	 * timer after that point is a no-op so reconnect-time stalls fall through
	 * to the normal socket close handling instead of aborting the live session.
	 */
	#joinReject: ((err: Error) => void) | null = null;
	#welcomeTimer: Timer | null = null;
	#snapshotProgressTimer: Timer | null = null;
	/** base64url write token from a full link; absent when joined via a view link. */
	#writeToken: string | undefined;
	/** True when the host marked this peer read-only (view link). */
	#readOnly = false;
	/** False until the first assistant message_start (real or synthesized) since (re)sync. */
	#assistantStreamSynced = false;
	state: CollabSessionState | null = null;
	/** Local mirror of the host's agent ecosystem (refs carry `session: null`). */
	readonly agentRegistry = new AgentRegistry();
	/** Per-agent `hasSessionFile` from the last snapshot; gates remote transcript fetches. */
	#agentHasTranscript = new Map<string, boolean>();
	#pendingTranscripts = new Map<number, (r: AgentTranscriptRemoteRead | null) => void>();
	/** Host `ui-request`s presented (or queued) locally, keyed by reqId; aborting dismisses. */
	#pendingUiRequests = new Map<number, AbortController>();
	#nextReqId = 1;
	readonly #agentRemote: AgentTranscriptRemote = {
		chat: (id, text) => {
			if (this.#rejectReadOnly()) return;
			this.#socket?.send({ t: "agent-cmd", cmd: "chat", agentId: id, text });
		},
		kill: id => {
			if (this.#rejectReadOnly()) return;
			this.#socket?.send({ t: "agent-cmd", cmd: "kill", agentId: id });
		},
		revive: id => {
			if (this.#rejectReadOnly()) return;
			this.#socket?.send({ t: "agent-cmd", cmd: "revive", agentId: id });
		},
		readTranscript: (id, fromByte) => {
			const socket = this.#socket;
			if (!socket || this.#agentHasTranscript.get(id) === false) {
				return Promise.resolve(null);
			}
			const reqId = this.#nextReqId++;
			const { promise, resolve } = Promise.withResolvers<AgentTranscriptRemoteRead | null>();
			const timer = setTimeout(() => {
				this.#pendingTranscripts.delete(reqId);
				resolve(null);
			}, TRANSCRIPT_TIMEOUT_MS);
			this.#pendingTranscripts.set(reqId, result => {
				clearTimeout(timer);
				resolve(result);
			});
			socket.send({ t: "fetch-transcript", reqId, agentId: id, fromByte });
			return promise;
		},
	};

	/** Agent actions routed to the host over the wire (a guest has no local sessions). */
	get agentRemote(): AgentTranscriptRemote {
		return this.#agentRemote;
	}

	/** True when this guest joined through a read-only (view) link. */
	get readOnly(): boolean {
		return this.#readOnly;
	}

	/** Shows the read-only status hint when applicable; true when the action must be dropped. */
	#rejectReadOnly(): boolean {
		if (!this.#readOnly) return false;
		this.#surface.showStatus("This collab link is read-only");
		return true;
	}

	constructor(surface: CollabGuestSurface) {
		this.#surface = surface;
	}

	async join(link: string): Promise<void> {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#roomId = parsed.roomId;
		this.#writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const key = await importRoomKey(parsed.key);

		this.#returnSessionFile = this.#surface.sessionManager.getSessionFile() ?? null;

		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		this.#socket = socket;

		const firstWelcome = Promise.withResolvers<void>();
		let joined = false;
		this.#joinReject = err => firstWelcome.reject(err);

		const finishJoin = (): void => {
			if (joined) return;
			joined = true;
			firstWelcome.resolve();
		};

		socket.onOpen = () => {
			// (Re)connect: re-introduce ourselves; the host answers with a fresh
			// welcome which (re)syncs the replica. Discard any partially-streamed
			// snapshot from a prior connection: the host will resend the full
			// chunk train.
			this.#welcomed = false;
			this.#pendingSnapshot = null;
			this.#clearSnapshotProgressTimer();
			this.#armWelcomeTimer();
			socket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: collabDisplayName(this.#surface),
				writeToken: this.#writeToken,
			});
		};
		socket.onFrame = frame => {
			this.#applyChain = this.#applyChain
				.then(async () => {
					if (frame.t === "welcome") {
						this.#clearWelcomeTimer();
						this.#beginWelcome(frame, joined);
						if (frame.entryCount === 0) {
							await this.#finalizeSnapshot();
							finishJoin();
						}
						return;
					}
					if (frame.t === "snapshot-chunk") {
						const ready = this.#accumulateSnapshotChunk(frame);
						if (ready) {
							await this.#finalizeSnapshot();
							finishJoin();
						}
						return;
					}
					if (frame.t === "error" && !this.#welcomed && !this.#left) {
						// Pre-welcome errors are the host's targeted reply to our
						// hello (e.g. protocol mismatch): no welcome will follow.
						// Fail the join with the host's message instead of hanging
						// until the welcome timeout.
						this.#clearWelcomeTimer();
						if (joined) this.#surface.showError(`Collab host: ${frame.message}`);
						else firstWelcome.reject(new Error(frame.message));
						return;
					}
					if (!this.#welcomed || this.#left) return;
					this.#applyFrame(frame);
				})
				.catch(err => {
					logger.warn("collab guest frame apply failed", { type: frame.t, error: String(err) });
					if (!joined && (frame.t === "welcome" || frame.t === "snapshot-chunk")) {
						firstWelcome.reject(err instanceof Error ? err : new Error(String(err)));
					}
				});
		};
		socket.onClose = (reason, willReconnect) => {
			this.#clearWelcomeTimer();
			this.#clearSnapshotProgressTimer();
			this.#flushPendingTranscripts();
			if (this.#left) return;
			if (!joined) {
				firstWelcome.reject(new Error(reason));
				return;
			}
			if (willReconnect) {
				this.#surface.setConnected(false);
				this.#surface.showStatus(`Collab connection lost (${reason}), reconnecting…`, { dim: true });
				return;
			}
			this.#surface.showStatus(`Collab session ended (${reason})`);
			void this.#restoreLocalSession();
		};
		socket.connect();
		// Cover the connect phase too: if the relay blackholes the WebSocket
		// handshake (no onOpen, no onClose), onOpen never arms the welcome timer,
		// so without this the join would hang forever. onOpen re-arms (resetting
		// the budget) once the socket actually opens.
		this.#armWelcomeTimer();

		try {
			await firstWelcome.promise;
		} catch (err) {
			this.#left = true;
			socket.close();
			this.#socket = null;
			throw err;
		} finally {
			this.#joinReject = null;
			this.#clearWelcomeTimer();
			this.#clearSnapshotProgressTimer();
		}

		this.#surface.setGuestLink(this);
		this.#surface.agentsChanged();
	}

	/** User-initiated leave (or post-disconnect cleanup): restore the previous session. */
	async leave(_reason: string): Promise<void> {
		if (this.#left) return;
		this.#socket?.close();
		await this.#restoreLocalSession();
	}

	sendPrompt(text: string, images?: ImageContent[]): void {
		if (this.#rejectReadOnly()) return;
		this.#socket?.send({ t: "prompt", text, images: images && images.length > 0 ? images : undefined });
	}

	sendAbort(): void {
		if (this.#rejectReadOnly()) return;
		this.#socket?.send({ t: "abort" });
	}

	/**
	 * Latch the welcome metadata and prime the snapshot accumulator. The
	 * heavy resume work (file write, `switchSession`, render) only happens in
	 * {@link #finalizeSnapshot}, so the small welcome frame clears the join
	 * timeout immediately even when the transcript still has to stream in.
	 */
	#beginWelcome(frame: WelcomeFrame, isResync: boolean): void {
		if (this.#left) return;
		this.#pendingSnapshot = {
			header: frame.header,
			state: frame.state,
			agents: frame.agents,
			readOnly: frame.readOnly === true,
			entryCount: frame.entryCount,
			entries: [],
			isResync,
		};
		this.#armSnapshotProgressTimer();
	}

	/**
	 * Append a chunk to the pending snapshot. Returns `true` when the
	 * accumulator has gathered every entry the welcome promised, or the host
	 * tagged this chunk as `final`. The caller is responsible for invoking
	 * {@link #finalizeSnapshot} on the same applyChain microtask.
	 */
	#accumulateSnapshotChunk(frame: SnapshotChunkFrame): boolean {
		const pending = this.#pendingSnapshot;
		if (!pending) {
			logger.debug("collab guest dropping orphan snapshot-chunk");
			return false;
		}
		for (let ei = 0; ei < frame.entries.length; ei++) pending.entries.push(fromWireSessionEntry(frame.entries[ei]!));
		const complete = frame.final || pending.entries.length >= pending.entryCount;
		if (complete) {
			this.#clearSnapshotProgressTimer();
		} else {
			this.#armSnapshotProgressTimer();
		}
		return complete;
	}

	/** Write the accumulated welcome snapshot to the replica file and (re)load it through the resume machinery. */
	async #finalizeSnapshot(): Promise<void> {
		const pending = this.#pendingSnapshot;
		this.#pendingSnapshot = null;
		this.#clearSnapshotProgressTimer();
		if (!pending || this.#left) return;
		const replicaPath = path.join(getConfigRootDir(), "collab", `${this.#roomId}.jsonl`);
		const lines = [pending.header, ...pending.entries].map(entry => JSON.stringify(entry)).join("\n");
		await Bun.write(replicaPath, `${lines}\n`);

		// Resume sequence minus applyCwdChange: the guest process never chdirs
		// to a host path. The SessionManager still adopts the header cwd for display.
		this.#clearUiRequests();
		this.#surface.clearTransientState();
		this.#clearAgentMirror();
		await this.#surface.session.switchSession(replicaPath);
		this.state = pending.state;
		this.#surface.setHostStreaming(pending.state.isStreaming);
		this.#applyHostState(pending.state);
		this.#surface.resetObservers();
		this.#applyAgentSnapshots(pending.agents);
		this.#surface.agentsChanged();
		this.#assistantStreamSynced = false;
		this.#surface.setSessionTitle(pending.state.sessionName ?? pending.header.title, pending.state.cwd);
		await this.#surface.redrawSession();
		this.#updateStatusSegment();
		this.#readOnly = pending.readOnly;
		this.#welcomed = true;
		this.#surface.setConnected(true);
		const suffix = this.#readOnly ? " (read-only)" : "";
		this.#surface.showStatus(
			pending.isResync ? `Reconnected to collab session${suffix}` : `Joined collab session${suffix}`,
		);
	}

	#armWelcomeTimer(): void {
		if (this.#joinReject === null) return;
		this.#clearWelcomeTimer();
		this.#welcomeTimer = setTimeout(() => {
			this.#welcomeTimer = null;
			this.#joinReject?.(new Error("timed out waiting for the host's welcome"));
		}, WELCOME_TIMEOUT_MS);
	}

	#clearWelcomeTimer(): void {
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	#armSnapshotProgressTimer(): void {
		if (this.#joinReject === null) return;
		this.#clearSnapshotProgressTimer();
		this.#snapshotProgressTimer = setTimeout(() => {
			this.#snapshotProgressTimer = null;
			this.#joinReject?.(new Error("timed out waiting for the host's session snapshot"));
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearSnapshotProgressTimer(): void {
		if (this.#snapshotProgressTimer !== null) {
			clearTimeout(this.#snapshotProgressTimer);
			this.#snapshotProgressTimer = null;
		}
	}

	#applyFrame(frame: CollabFrame): void {
		switch (frame.t) {
			case "entry": {
				// Entries are never rendered directly — rendering is events-only
				// (prevents double-render). They keep the replica file, the agent's
				// message array (/dump, context estimates), and todos current.
				const entry = fromWireSessionEntry(frame.entry);
				this.#surface.sessionManager.ingestReplicatedEntry(entry);
				if (entry.type === "message") {
					this.#surface.session.agent.replaceMessages(this.#surface.session.messages.concat([entry.message]));
				}
				break;
			}
			case "event":
				this.#applyEvent(fromWireAgentEvent(frame.event));
				break;
			case "state": {
				this.state = frame.state;
				this.#surface.setSessionTitle(frame.state.sessionName, frame.state.cwd);
				this.#updateStatusSegment();
				this.#surface.setHostStreaming(frame.state.isStreaming);
				break;
			}
			case "bus":
				// Mirrored host EventBus traffic (task agent lifecycle/progress)
				// feeding the observer HUD and the agent dashboard's activity column.
				this.#surface.eventBus?.emit(frame.channel, frame.data);
				break;
			case "agents":
				this.#applyAgentSnapshots(frame.agents);
				this.#surface.agentsChanged();
				break;
			case "ui-request":
				this.#presentUiRequest(frame.request);
				break;
			case "ui-request-end":
				this.#endUiRequest(frame.reqId);
				break;
			case "transcript": {
				const resolve = this.#pendingTranscripts.get(frame.reqId);
				if (resolve) {
					this.#pendingTranscripts.delete(frame.reqId);
					resolve({ text: frame.text, newSize: frame.newSize, error: frame.error });
				}
				break;
			}
			case "bye": {
				this.#surface.showStatus(`Collab session ended (${frame.reason})`);
				this.#socket?.close();
				void this.#restoreLocalSession();
				break;
			}
			case "error":
				this.#surface.showError(`Collab host: ${frame.message}`);
				break;
			default:
				logger.debug("collab guest ignoring unexpected frame", { type: frame.t });
		}
	}

	#applyEvent(event: AgentSessionEvent): void {
		// Orphan-delta guard: when joining mid-turn the message_start for the
		// in-flight assistant message predates the snapshot. message_update
		// carries the full accumulating message, so synthesize the missing start
		// before the first orphaned update; every other handler is tolerant of
		// unknown anchors (guarded by streamingComponent/pendingTools lookups).
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.#assistantStreamSynced = true;
		} else if (
			event.type === "message_update" &&
			event.message.role === "assistant" &&
			!this.#assistantStreamSynced
		) {
			this.#assistantStreamSynced = true;
			this.#surface.handleEvent({ type: "message_start", message: event.message });
		}
		this.#surface.handleEvent(event);
	}

	/**
	 * Apply the host's real model/thinking state to the replica agent so model
	 * display and context-window math are native (no display-string overrides).
	 * Pure agent-state mutation: session.setModel/setThinkingLevel would
	 * persist entries and clamp to local credentials.
	 */
	#applyHostState(state: CollabSessionState): void {
		const session = this.#surface.session;
		if (
			state.model &&
			(session.agent.state.model?.id !== state.model.id ||
				session.agent.state.model?.provider !== state.model.provider)
		) {
			session.agent.setModel(fromWireModel(state.model));
		}
		const level = state.thinkingLevel as ThinkingLevel | undefined;
		session.agent.setThinkingLevel(toReasoningEffort(level));
		session.agent.setDisableReasoning(shouldDisableReasoning(level));
	}

	/** Diff a host agent snapshot into the local registry (refs keep `session: null`). */
	#applyAgentSnapshots(agents: AgentSnapshot[]): void {
		const seen = new Set<string>();
		for (const snap of agents) seen.add(snap.id);
		for (const ref of this.agentRegistry.list()) {
			if (!seen.has(ref.id)) {
				this.agentRegistry.unregister(ref.id);
				this.#agentHasTranscript.delete(ref.id);
			}
		}
		for (const snap of agents) {
			if (this.agentRegistry.get(snap.id)) {
				this.agentRegistry.mirrorStatus(snap.id, snap.status);
			} else {
				this.agentRegistry.register({
					id: snap.id,
					displayName: snap.displayName,
					kind: snap.kind,
					parentId: snap.parentId,
					session: null,
					status: snap.status,
					model: snap.model,
				});
			}
			// Refs are returned by reference: patch host timestamps directly so
			// hub age/activity columns reflect the host, not local registration.
			const ref = this.agentRegistry.get(snap.id);
			if (ref) {
				ref.createdAt = snap.createdAt;
				ref.lastActivity = snap.lastActivity;
				ref.displayName = snap.displayName;
			}
			this.#agentHasTranscript.set(snap.id, snap.hasSessionFile);
		}
	}

	#clearAgentMirror(): void {
		for (const ref of this.agentRegistry.list()) {
			this.agentRegistry.unregister(ref.id);
		}
		this.#agentHasTranscript.clear();
	}

	/** Resolve every in-flight transcript request with null (resolvers clear their own timers). */
	#flushPendingTranscripts(): void {
		for (const resolve of this.#pendingTranscripts.values()) {
			resolve(null);
		}
		this.#pendingTranscripts.clear();
	}

	/**
	 * Surface a host `ui-request` (ask select/editor) through the local
	 * hook-dialog seam. The dialog settles on user submit/cancel — both send a
	 * `ui-response` (cancel carries `value: undefined`, mirroring the web
	 * client's Cancel button) — or when {@link #endUiRequest} aborts it because
	 * the host settled the request elsewhere; that path must NOT respond.
	 */
	#presentUiRequest(request: CollabUiRequest): void {
		// The host only targets writable peers; drop defensively on a read-only link.
		if (this.#readOnly || this.#pendingUiRequests.has(request.reqId)) return;
		const abort = new AbortController();
		this.#pendingUiRequests.set(request.reqId, abort);
		this.#surface
			.askGuest(request, abort.signal)
			.then(value => {
				// Identity check: only the presentation that still owns the reqId
				// may respond. An abort from #endUiRequest / #clearUiRequests
				// removes (or replaces, on resync replay) the entry before this
				// microtask runs, so a dismissed dialog stays silent.
				if (this.#pendingUiRequests.get(request.reqId) !== abort) return;
				this.#pendingUiRequests.delete(request.reqId);
				this.#socket?.send({ t: "ui-response", reqId: request.reqId, value });
			})
			.catch(err => {
				if (this.#pendingUiRequests.get(request.reqId) === abort) {
					this.#pendingUiRequests.delete(request.reqId);
				}
				logger.warn("collab guest ui-request presentation failed", {
					reqId: request.reqId,
					error: String(err),
				});
			});
	}

	/** Host settled the request (answered elsewhere or aborted): dismiss without responding. */
	#endUiRequest(reqId: number): void {
		const abort = this.#pendingUiRequests.get(reqId);
		if (!abort) return;
		this.#pendingUiRequests.delete(reqId);
		abort.abort();
	}

	/**
	 * Dismiss every locally presented `ui-request` without responding: on
	 * resync the host replays the ones still pending, and on leave they are no
	 * longer ours to answer. Queued dialogs abort before the presented one
	 * (reverse insertion order) so settling the active dialog cannot flash the
	 * next queued one onto the surface first.
	 */
	#clearUiRequests(): void {
		if (this.#pendingUiRequests.size === 0) return;
		const aborts = Array.from(this.#pendingUiRequests.values());
		this.#pendingUiRequests.clear();
		for (const abort of aborts.reverse()) abort.abort();
	}

	/**
	 * Put the host back on its own session, once, however many paths ask.
	 *
	 * A leave closes the socket, and the close handler starts the restore
	 * before `leave` reaches its own call. Returning the one in flight is what
	 * makes `leave` finish when the restore has finished: without it the
	 * caller is told it left while the previous session is still being opened,
	 * and a host that replies on that promise states a session it is not on.
	 */
	#restoreLocalSession(): Promise<void> {
		this.#restoring ??= this.#restoreOnce();
		return this.#restoring;
	}

	async #restoreOnce(): Promise<void> {
		if (this.#left) return;
		this.#left = true;
		this.#socket = null;
		this.#surface.setGuestLink(undefined);
		this.#surface.setCollabStatus(null);
		this.#flushPendingTranscripts();
		this.#clearAgentMirror();
		this.#surface.agentsChanged();
		this.#surface.resetObservers();
		this.#clearUiRequests();
		this.#surface.clearTransientState();
		// Replica file stays on disk: it is a valid session file outside the
		// sessions dir, so it never shows up in /resume but remains readable.
		await this.#surface.restoreSession(this.#returnSessionFile);
	}

	#updateStatusSegment(): void {
		this.#surface.setCollabStatus({
			role: "guest",
			participantCount: this.state?.participants.length ?? 1,
			stateOverride: this.state,
		});
	}
}
