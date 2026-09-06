import type * as net from "node:net";
import * as path from "node:path";
import type { AuthStorage, ImageContent, VideoContent } from "@veyyon/ai";
import type { PtySession } from "@veyyon/natives";
import { logger } from "@veyyon/utils";
import { formatBytes } from "@veyyon/utils/format";
import { SUPPORTED_IMAGE_MIME_TYPES, SUPPORTED_VIDEO_MIME_TYPES } from "@veyyon/utils/mime";
import { initializeExtensions } from "../modes/runtime-init";
import { createAgentSession } from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import type { SessionEntry } from "../session/session-entries";
import { SessionManager } from "../session/session-manager";
import { computeDefaultSessionDir } from "../session/session-paths";
import { FileSessionStorage } from "../session/session-storage";
import { MAX_IMAGE_INPUT_BYTES } from "../utils/image-loading";
import { base64DecodedBytes, MAX_PROMPT_ATTACHMENT_BYTES, MAX_VIDEO_INPUT_BYTES } from "../utils/video-loading";
import { writeFrame } from "./frames";
import { GuiHostUIContext, InteractionLedger } from "./interactions";
import { enterPlanModeIfConfigured } from "./plan-approval";
import { agentMessageToTranscriptEntry, sessionEntryToTranscriptEntry } from "./session-bridge";
import type { AttachmentSubmission, AuthFlowState, TerminalStatus, TranscriptEntry } from "./wire";

export interface ActiveAuthFlow {
	provider: string;
	state: AuthFlowState;
	url: string | null;
	prompt: string | null;
	message: string | null;
	type?: "oauth" | "api_key";
	abortController?: AbortController;
	secretResolver?: (secret: string) => void;
	secretRejecter?: (error: Error) => void;
	retry?: () => void;
}

export interface TerminalInstance {
	id: string;
	cwd: string;
	shell: string;
	cols: number;
	rows: number;
	status: TerminalStatus;
	pty?: PtySession;
	seq: number;
	scrollback: Buffer;
	pendingChunks: Buffer[];
	pendingBytes: number;
	flushTimer: NodeJS.Timeout | null;
	resetNextChunk: boolean;
	killed?: boolean;
}

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
	/** The tool call in flight inside the streaming reply, for the run bar. */
	streamingTool?: string;
	/** The id of that call, so `CancelTool` can tell the running call from a stale one. */
	streamingToolCallId?: string;
	/** The last accumulating entry sent, re-sent when only `tool` changes. */
	streamingAccumulating?: TranscriptEntry;
	/**
	 * The decisions the session is waiting on: tool approvals, `ask`
	 * questions, extension prompts and plan reviews. Created with the session
	 * and installed as its UI surface, so a prompt raised by any of them
	 * reaches the client as a `Snapshot.Interactions` section.
	 */
	interactions?: InteractionLedger;
	terminals?: Map<string, TerminalInstance>;
	processFollowers?: Map<string, () => void>;
	/** `Steer` or `Queue`: how a prompt sent while a turn runs is delivered. */
	queueMode?: "Steer" | "Queue";
	selectedChangeScope?: string;
	unsubscribeAgents?: () => void;
	authFlow?: ActiveAuthFlow;
}

/**
 * Lazily initialize and attach an AgentSession for a client connection.
 */
export async function getOrCreateAgentSession(
	state: ClientSessionState,
	socket: net.Socket,
	options: { cwd: string; agentDir: string; authStorage: () => Promise<AuthStorage> },
): Promise<AgentSession> {
	if (state.agentSession) {
		return state.agentSession;
	}

	const storage = new FileSessionStorage();
	const sessionDir = computeDefaultSessionDir(options.cwd, storage, path.join(options.agentDir, "sessions"));
	const sm = state.sessionManager ?? SessionManager.create(options.cwd, sessionDir, storage);
	state.sessionManager = sm;
	const { session, setToolUIContext } = await createAgentSession({
		cwd: sm.getHeader()?.cwd ?? options.cwd,
		agentDir: options.agentDir,
		authStorage: await options.authStorage(),
		sessionManager: sm,
		hasUI: false,
	});

	// One surface for both seams that ask the operator something: the tool
	// wrapper's approval card reads the tool context store, and the `ask`
	// tool and extensions read the extension runner's context.
	const ledger = new InteractionLedger(socket, () => sm.getSessionId());
	const uiContext = new GuiHostUIContext(ledger);
	setToolUIContext(uiContext, true);
	await initializeExtensions(session, {
		uiContext,
		reportSendError: (action, error) => logger.error("GUI host extension send failed", { action, error }),
		reportRuntimeError: error =>
			logger.error("GUI host extension error", { extension: error.extensionPath, event: error.event, error }),
	});
	state.interactions = ledger;

	state.agentSession = session;
	attachTurnListeners(session, socket, state);
	await enterPlanModeIfConfigured(session, ledger);
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
				writeStreaming(
					socket,
					state,
					agentMessageToTranscriptEntry(event.message, state.revision, state.streamingEntry),
				);
			}
			break;
		}
		case "tool_execution_start": {
			// The run bar reads `tool`; a call that starts between two assistant
			// deltas still carries the entry it belongs to.
			state.streamingTool = event.toolName;
			state.streamingToolCallId = event.toolCallId;
			if (state.streamingAccumulating) writeStreaming(socket, state, state.streamingAccumulating);
			break;
		}
		case "tool_execution_end": {
			state.streamingTool = undefined;
			state.streamingToolCallId = undefined;
			if (state.streamingAccumulating) writeStreaming(socket, state, state.streamingAccumulating);
			break;
		}
		case "message_end": {
			if (event.message.role === "assistant") clearStreaming(socket, state);
			break;
		}
		case "turn_end":
		case "agent_end": {
			clearStreaming(socket, state);
			break;
		}
		default:
			break;
	}
}

function writeStreaming(socket: net.Socket, state: ClientSessionState, accumulating: TranscriptEntry): void {
	if (!state.streamingEntry) return;
	state.streamingAccumulating = accumulating;
	writeFrame(socket, {
		StreamingChanged: {
			entry: state.streamingEntry,
			tool: state.streamingTool ?? null,
			accumulating,
			revision: state.revision,
		},
	});
}

function clearStreaming(socket: net.Socket, state: ClientSessionState): void {
	if (!state.streamingEntry && !state.streamingTool) return;
	state.streamingEntry = undefined;
	state.streamingAccumulating = undefined;
	state.streamingTool = undefined;
	state.streamingToolCallId = undefined;
	writeFrame(socket, { StreamingChanged: null });
}

/**
 * Start a prompt turn and settle when the prompt finishes or is queued. An
 * idle turn that ends with a provider error rejects with the provider's real
 * detail, so the request registry and native GUI cannot mistake acceptance for
 * completion and then wait forever. Returns whether a turn was started.
 */
export class AttachmentValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AttachmentValidationError";
	}
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export async function executePromptTurn(
	session: AgentSession,
	state: ClientSessionState,
	promptText: string,
	attachments: AttachmentSubmission[] = [],
	streamingBehavior?: "steer" | "followUp",
): Promise<boolean> {
	const images: ImageContent[] = [];
	const videos: VideoContent[] = [];
	let totalAttachmentBytes = 0;

	for (const att of attachments) {
		if (typeof att.data !== "string" || att.data.length % 4 !== 0 || !BASE64_RE.test(att.data)) {
			throw new AttachmentValidationError(`Attachment "${att.name}" carries invalid base64 data.`);
		}
		const decodedBytes = base64DecodedBytes(att.data);
		totalAttachmentBytes += decodedBytes;

		if (SUPPORTED_IMAGE_MIME_TYPES.has(att.media_type)) {
			if (decodedBytes > MAX_IMAGE_INPUT_BYTES) {
				throw new AttachmentValidationError(
					`Attachment "${att.name}" (${att.media_type}) size ${formatBytes(decodedBytes)} exceeds ${formatBytes(MAX_IMAGE_INPUT_BYTES)} limit.`,
				);
			}
			images.push({
				type: "image",
				data: att.data,
				mimeType: att.media_type,
			});
		} else if (SUPPORTED_VIDEO_MIME_TYPES.has(att.media_type)) {
			if (decodedBytes > MAX_VIDEO_INPUT_BYTES) {
				throw new AttachmentValidationError(
					`Attachment "${att.name}" (${att.media_type}) size ${formatBytes(decodedBytes)} exceeds ${formatBytes(MAX_VIDEO_INPUT_BYTES)} limit.`,
				);
			}
			videos.push({
				type: "video",
				data: att.data,
				mimeType: att.media_type,
			});
		} else {
			const accepted = [...SUPPORTED_IMAGE_MIME_TYPES, ...SUPPORTED_VIDEO_MIME_TYPES].join(", ");
			throw new AttachmentValidationError(
				`Attachment "${att.name}" has unsupported media type "${att.media_type}". Accepted types: ${accepted}.`,
			);
		}
	}

	if (totalAttachmentBytes > MAX_PROMPT_ATTACHMENT_BYTES) {
		throw new AttachmentValidationError(
			`Total attachment size ${formatBytes(totalAttachmentBytes)} exceeds ${formatBytes(MAX_PROMPT_ATTACHMENT_BYTES)} prompt limit.`,
		);
	}

	const promptPromise = session.prompt(promptText, {
		images: images.length > 0 ? images : undefined,
		videos: videos.length > 0 ? videos : undefined,
		streamingBehavior,
	});
	state.activeTurnPromise = promptPromise;
	try {
		const started = await promptPromise;
		if (started && streamingBehavior === undefined) {
			const failed = session.messages.findLast(
				message => message.role === "assistant" && message.stopReason === "error",
			);
			if (failed?.role === "assistant") {
				throw new Error(failed.errorMessage ?? "Model turn failed without provider error detail");
			}
		}
		return started;
	} finally {
		if (state.activeTurnPromise === promptPromise) state.activeTurnPromise = undefined;
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
 *
 * Terminals, process followers and an auth flow belong to the client, not
 * the session: a session switch or a new session leaves them running. They
 * end with the connection, in `disposeClientState`.
 */
export async function disposeTurnSession(state: ClientSessionState): Promise<void> {
	state.unsubscribeSession?.();
	state.unsubscribeSession = undefined;
	state.unsubscribeAgents?.();
	state.unsubscribeAgents = undefined;
	if (state.sessionManager) {
		state.sessionManager.onEntryAppended = undefined;
	}
	// Decisions are cancelled before the session is disposed: a tool blocked
	// on one sees its default answer and unwinds while the session can still
	// record the result, rather than hanging on a client that is gone.
	state.interactions?.cancelAll();
	state.interactions = undefined;
	if (state.agentSession) {
		const session = state.agentSession;
		state.agentSession = undefined;
		await session.dispose();
	}
}

/**
 * Everything a client holds, ended: its session, then its terminals, its
 * process log followers and any auth flow waiting on a secret.
 */
export async function disposeClientState(state: ClientSessionState): Promise<void> {
	await disposeTurnSession(state);
	if (state.terminals) {
		for (const terminal of state.terminals.values()) {
			terminal.killed = true;
			if (terminal.flushTimer) {
				clearTimeout(terminal.flushTimer);
				terminal.flushTimer = null;
			}
			if (terminal.pty) {
				try {
					terminal.pty.kill();
				} catch {
					// The process may already have exited; there is nothing left to end.
				}
			}
		}
		state.terminals.clear();
	}
	if (state.processFollowers) {
		for (const stop of state.processFollowers.values()) stop();
		state.processFollowers.clear();
	}
	if (state.authFlow) {
		state.authFlow.abortController?.abort();
		state.authFlow.secretRejecter?.(new Error("The client disconnected before a secret arrived"));
		state.authFlow = undefined;
	}
}
