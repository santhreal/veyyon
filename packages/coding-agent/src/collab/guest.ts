import * as path from "node:path";
import type { ThinkingLevel } from "@veyyon/agent-core";
import type { ImageContent } from "@veyyon/ai";
import { getConfigRootDir, logger } from "@veyyon/utils";
import { SNAPSHOT_PROGRESS_TIMEOUT_MS, TRANSCRIPT_TIMEOUT_MS, WELCOME_TIMEOUT_MS } from "@veyyon/wire";
import type { AgentTranscriptRemote, AgentTranscriptRemoteRead } from "../modes/components/agent-transcript-viewer";
import type { InteractiveModeContext } from "../modes/types";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "../session/agent-session";
import type { SessionEntry } from "../session/session-entries";
import { shouldDisableReasoning, toReasoningEffort } from "../thinking";
import { setSessionTerminalTitle } from "../utils/title-generator";
import { importRoomKey } from "./crypto";
import { collabDisplayName } from "./display-name";
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

export const COLLAB_GUEST_ALLOWED_COMMANDS: Record<string, true> = {
	dump: true,
	export: true,
	copy: true,
	welcome: true, // `/help` is an alias of `/welcome`; the gate keys on the canonical name
	hotkeys: true,
	settings: true,
	leave: true,
	collab: true,
	exit: true,
	quit: true,
};

type WelcomeFrame = Extract<CollabFrame, { t: "welcome" }>;
type SnapshotChunkFrame = Extract<CollabFrame, { t: "snapshot-chunk" }>;

interface PendingSnapshot {
	header: WelcomeFrame["header"];
	state: WelcomeFrame["state"];
	agents: AgentSnapshot[];
	readOnly: boolean;
	entryCount: number;
	entries: SessionEntry[];
	isResync: boolean;
}

export interface GuestIdleReconcilerCtx {
	statusLine: { markActivityEnd: () => void };
	clearWorkingLoader: () => void;
}

export function reconcileGuestIdleHostState(ctx: GuestIdleReconcilerCtx, isStreaming: boolean): void {
	if (isStreaming) return;
	ctx.statusLine.markActivityEnd();
	ctx.clearWorkingLoader();
}

export interface GuestSnapshotActivityReconcilerCtx extends GuestIdleReconcilerCtx {
	statusLine: GuestIdleReconcilerCtx["statusLine"] & { markActivityStart: () => void };
}

export function reconcileGuestSnapshotHostState(ctx: GuestSnapshotActivityReconcilerCtx, isStreaming: boolean): void {
	if (isStreaming) {
		ctx.statusLine.markActivityStart();
		return;
	}
	reconcileGuestIdleHostState(ctx, false);
}

export type CollabGuestContext = Pick<
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
	| "syncRunningSubagentBadge"
	| "ui"
	| "updateEditorBorderColor"
>;

export class CollabGuestLink {
	#ctx: CollabGuestContext;
	#socket: CollabSocket | null = null;
	#roomId = "";
	#returnSessionFile: string | null = null;
	#applyChain: Promise<void> = Promise.resolve();
	#welcomed = false;
	#left = false;
	#pendingSnapshot: PendingSnapshot | null = null;
	#joinReject: ((err: Error) => void) | null = null;
	#welcomeTimer: Timer | null = null;
	#snapshotProgressTimer: Timer | null = null;
	#writeToken: string | undefined;
	#readOnly = false;
	#assistantStreamSynced = false;
	state: CollabSessionState | null = null;
	readonly agentRegistry = new AgentRegistry();
	#agentHasTranscript = new Map<string, boolean>();
	#pendingTranscripts = new Map<number, (r: AgentTranscriptRemoteRead | null) => void>();
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

	get agentRemote(): AgentTranscriptRemote {
		return this.#agentRemote;
	}

	get readOnly(): boolean {
		return this.#readOnly;
	}

	#rejectReadOnly(): boolean {
		if (!this.#readOnly) return false;
		this.#ctx.showStatus("This collab link is read-only");
		return true;
	}

	constructor(ctx: CollabGuestContext) {
		this.#ctx = ctx;
	}

	async join(link: string): Promise<void> {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#roomId = parsed.roomId;
		this.#writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const key = await importRoomKey(parsed.key);

		this.#returnSessionFile = this.#ctx.sessionManager.getSessionFile() ?? null;

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
			this.#welcomed = false;
			this.#pendingSnapshot = null;
			this.#clearSnapshotProgressTimer();
			this.#armWelcomeTimer();
			socket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: collabDisplayName(this.#ctx),
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
						this.#clearWelcomeTimer();
						if (joined) this.#ctx.showError(`Collab host: ${frame.message}`);
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
				this.#ctx.showStatus(`Collab connection lost (${reason}), reconnecting…`, { dim: true });
				return;
			}
			this.#ctx.showStatus(`Collab session ended (${reason})`);
			void this.#restoreLocalSession();
		};
		socket.connect();
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

		this.#ctx.collabGuest = this;
		this.#ctx.syncRunningSubagentBadge();
	}

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

	async #finalizeSnapshot(): Promise<void> {
		const pending = this.#pendingSnapshot;
		this.#pendingSnapshot = null;
		this.#clearSnapshotProgressTimer();
		if (!pending || this.#left) return;
		const replicaPath = path.join(getConfigRootDir(), "collab", `${this.#roomId}.jsonl`);
		const lines = [pending.header, ...pending.entries].map(entry => JSON.stringify(entry)).join("\n");
		await Bun.write(replicaPath, `${lines}\n`);

		this.#clearTransientUi();
		this.#clearAgentMirror();
		await this.#ctx.session.switchSession(replicaPath);
		this.state = pending.state;
		reconcileGuestSnapshotHostState(this.#ctx, pending.state.isStreaming);
		this.#applyHostState(pending.state);
		this.#ctx.resetObserverRegistry();
		this.#applyAgentSnapshots(pending.agents);
		this.#ctx.syncRunningSubagentBadge();
		this.#assistantStreamSynced = false;
		setSessionTerminalTitle(pending.state.sessionName ?? pending.header.title, pending.state.cwd);
		this.#ctx.chatContainer.clear();
		this.#ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.#ctx.reloadTodos();
		this.#updateStatusSegment();
		this.#readOnly = pending.readOnly;
		this.#welcomed = true;
		const suffix = this.#readOnly ? " (read-only)" : "";
		this.#ctx.showStatus(
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
				const entry = fromWireSessionEntry(frame.entry);
				this.#ctx.sessionManager.ingestReplicatedEntry(entry);
				if (entry.type === "message") {
					this.#ctx.session.agent.replaceMessages(this.#ctx.session.messages.concat([entry.message]));
				}
				break;
			}
			case "event":
				this.#applyEvent(fromWireAgentEvent(frame.event));
				break;
			case "state": {
				this.state = frame.state;
				this.#applyHostState(frame.state);
				setSessionTerminalTitle(frame.state.sessionName, frame.state.cwd);
				this.#updateStatusSegment();
				reconcileGuestIdleHostState(this.#ctx, frame.state.isStreaming);
				this.#ctx.statusLine.invalidate();
				this.#ctx.ui.requestRender();
				break;
			}
			case "bus":
				this.#ctx.eventBus?.emit(frame.channel, frame.data);
				break;
			case "agents":
				this.#applyAgentSnapshots(frame.agents);
				this.#ctx.syncRunningSubagentBadge();
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
				this.#ctx.showStatus(`Collab session ended (${frame.reason})`);
				this.#socket?.close();
				void this.#restoreLocalSession();
				break;
			}
			case "error":
				this.#ctx.showError(`Collab host: ${frame.message}`);
				break;
			default:
				logger.debug("collab guest ignoring unexpected frame", { type: frame.t });
		}
	}

	#applyEvent(event: AgentSessionEvent): void {
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.#assistantStreamSynced = true;
		} else if (
			event.type === "message_update" &&
			event.message.role === "assistant" &&
			!this.#assistantStreamSynced
		) {
			this.#assistantStreamSynced = true;
			void this.#ctx.eventController.handleEvent({ type: "message_start", message: event.message });
		}
		void this.#ctx.eventController.handleEvent(event);
	}

	#applyHostState(state: CollabSessionState): void {
		const session = this.#ctx.session;
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
				this.agentRegistry.setStatus(snap.id, snap.status);
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

	#flushPendingTranscripts(): void {
		for (const resolve of this.#pendingTranscripts.values()) {
			resolve(null);
		}
		this.#pendingTranscripts.clear();
	}

	#presentUiRequest(request: CollabUiRequest): void {
		if (this.#readOnly || this.#pendingUiRequests.has(request.reqId)) return;
		const abort = new AbortController();
		this.#pendingUiRequests.set(request.reqId, abort);
		const dialog =
			request.kind === "select"
				? this.#ctx.showHookSelector(request.title, request.options, {
						signal: abort.signal,
						initialIndex: request.initialIndex,
						selectionMarker: request.selectionMarker,
						checkedIndices: request.checkedIndices,
						markableCount: request.markableCount,
						helpText: request.helpText,
					})
				: this.#ctx.showHookEditor(request.title, request.prefill, { signal: abort.signal });
		dialog
			.then(value => {
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

	#endUiRequest(reqId: number): void {
		const abort = this.#pendingUiRequests.get(reqId);
		if (!abort) return;
		this.#pendingUiRequests.delete(reqId);
		abort.abort();
	}

	#clearUiRequests(): void {
		if (this.#pendingUiRequests.size === 0) return;
		const aborts = Array.from(this.#pendingUiRequests.values());
		this.#pendingUiRequests.clear();
		for (const abort of aborts.reverse()) abort.abort();
	}

	#clearTransientUi(): void {
		this.#clearUiRequests();
		this.#ctx.statusContainer.clear();
		this.#ctx.pendingMessagesContainer.clear();
		this.#ctx.compactionQueuedMessages = [];
		this.#ctx.streamingComponent = undefined;
		this.#ctx.streamingMessage = undefined;
		this.#ctx.pendingTools.clear();
		this.#ctx.clearWorkingLoader();
	}

	async #restoreLocalSession(): Promise<void> {
		if (this.#left) return;
		this.#left = true;
		this.#socket = null;
		this.#ctx.collabGuest = undefined;
		this.#ctx.statusLine.setCollabStatus(null);
		this.#flushPendingTranscripts();
		this.#clearAgentMirror();
		this.#ctx.syncRunningSubagentBadge();
		this.#ctx.resetObserverRegistry();
		this.#clearTransientUi();
		if (this.#returnSessionFile) {
			await this.#ctx.handleResumeSession(this.#returnSessionFile);
			return;
		}
		await this.#ctx.session.newSession();
		setSessionTerminalTitle(this.#ctx.sessionManager.getSessionName(), this.#ctx.sessionManager.getCwd());
		this.#ctx.statusLine.invalidate();
		this.#ctx.statusLine.resetActiveTime();
		this.#ctx.ui.requestRender();
		this.#ctx.updateEditorBorderColor();
		this.#ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.#ctx.reloadTodos();
		this.#ctx.ui.requestRender(true, { clearScrollback: true });
	}

	#updateStatusSegment(): void {
		this.#ctx.statusLine.setCollabStatus({
			role: "guest",
			participantCount: this.state?.participants.length ?? 1,
			stateOverride: this.state,
		});
	}
}
