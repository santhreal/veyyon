import type * as net from "node:net";
import * as path from "node:path";
import type { ImageContent } from "@veyyon/ai";
import { createAgentSession } from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import type { SessionEntry } from "../session/session-entries";
import { SessionManager } from "../session/session-manager";
import { computeDefaultSessionDir } from "../session/session-paths";
import { FileSessionStorage } from "../session/session-storage";
import { writeFrame } from "./frames";
import { agentMessageToTranscriptEntry, sessionEntryToTranscriptEntry } from "./session-bridge";
import type { AttachmentSubmission } from "./wire";

export interface ClientSessionState {
	revision: number;
	agentSession?: AgentSession;
	sessionManager?: SessionManager;
	unsubscribeSession?: () => void;
	activeTurnPromise?: Promise<boolean>;
	/**
	 * Identity of the reply currently streaming, held for as long as it streams.
	 * Every delta of one reply carries it, so the desktop replaces one
	 * accumulating entry instead of appending a new one per frame; it is dropped
	 * when the reply ends, and the next reply mints the next one.
	 */
	streamingEntry?: string;
	streamingSeq?: number;
}

/**
 * Lazily initialize and attach an AgentSession for a client connection.
 */
export async function getOrCreateAgentSession(
	state: ClientSessionState,
	socket: net.Socket,
	options: { cwd: string; agentDir: string },
): Promise<AgentSession> {
	if (state.agentSession) {
		return state.agentSession;
	}

	const storage = new FileSessionStorage();
	const sessionDir = computeDefaultSessionDir(options.cwd, storage, path.join(options.agentDir, "sessions"));
	const sm = state.sessionManager ?? SessionManager.create(options.cwd, sessionDir, storage);
	state.sessionManager = sm;
	const { session } = await createAgentSession({
		cwd: sm.getHeader()?.cwd ?? options.cwd,
		agentDir: options.agentDir,
		sessionManager: sm,
		hasUI: false,
	});

	state.agentSession = session;
	attachTurnListeners(session, socket, state);
	return session;
}

/**
 * Attach transcript and streaming listeners from an AgentSession to the client socket.
 */
export function attachTurnListeners(session: AgentSession, socket: net.Socket, state: ClientSessionState): void {
	state.unsubscribeSession?.();

	const sm = session.sessionManager;
	state.sessionManager = sm;

	sm.onEntryAppended = (entry: SessionEntry) => {
		state.revision += 1;
		const transcriptEntry = sessionEntryToTranscriptEntry(entry, state.revision);
		writeFrame(socket, {
			TranscriptAppended: {
				revision: state.revision,
				entries: [transcriptEntry],
			},
		});
	};

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		handleSessionEvent(event, socket, state);
	});

	state.unsubscribeSession = () => {
		unsubscribe();
		if (sm.onEntryAppended) {
			sm.onEntryAppended = undefined;
		}
	};
}

/**
 * Translate AgentSessionEvent stream notifications to wire protocol frames.
 */
export function handleSessionEvent(event: AgentSessionEvent, socket: net.Socket, state: ClientSessionState): void {
	switch (event.type) {
		case "message_update": {
			if (event.message.role === "assistant") {
				if (!state.streamingEntry) {
					state.streamingSeq = (state.streamingSeq ?? 0) + 1;
					state.streamingEntry = `stream-${state.streamingSeq}`;
				}
				const transcriptEntry = agentMessageToTranscriptEntry(event.message, state.revision, state.streamingEntry);
				writeFrame(socket, {
					StreamingChanged: {
						entry: state.streamingEntry,
						tool: null,
						accumulating: transcriptEntry,
						revision: state.revision,
					},
				});
			}
			break;
		}
		case "message_end": {
			if (event.message.role === "assistant") {
				state.streamingEntry = undefined;
				writeFrame(socket, { StreamingChanged: null });
			}
			break;
		}
		case "turn_end":
		case "agent_end": {
			state.streamingEntry = undefined;
			writeFrame(socket, { StreamingChanged: null });
			break;
		}
		default:
			break;
	}
}

/**
 * Run a prompt turn against the session, forwarding attachments if present.
 */
export async function executePromptTurn(
	session: AgentSession,
	state: ClientSessionState,
	promptText: string,
	attachments: AttachmentSubmission[] = [],
): Promise<boolean> {
	const images: ImageContent[] = [];
	for (const att of attachments) {
		if (att.media_type.startsWith("image/")) {
			images.push({
				type: "image",
				data: Buffer.from(att.data).toString("base64"),
				mimeType: att.media_type,
			});
		}
	}

	const promptPromise = session.prompt(promptText, {
		images: images.length > 0 ? images : undefined,
	});
	state.activeTurnPromise = promptPromise;
	try {
		return await promptPromise;
	} finally {
		if (state.activeTurnPromise === promptPromise) {
			state.activeTurnPromise = undefined;
		}
	}
}

/**
 * Abort an active turn on the session.
 */
export async function abortTurn(session: AgentSession): Promise<void> {
	await session.abort({ reason: USER_INTERRUPT_LABEL });
}

/**
 * Clean up session listeners and dispose the session instance.
 */
export async function disposeTurnSession(state: ClientSessionState): Promise<void> {
	state.unsubscribeSession?.();
	state.unsubscribeSession = undefined;
	if (state.sessionManager) {
		state.sessionManager.onEntryAppended = undefined;
	}
	if (state.agentSession) {
		const session = state.agentSession;
		state.agentSession = undefined;
		await session.dispose();
	}
}
