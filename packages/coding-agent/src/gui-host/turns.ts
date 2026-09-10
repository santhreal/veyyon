import type * as net from "node:net";
import * as path from "node:path";
import type { AuthStorage, ImageContent, VideoContent } from "@veyyon/ai";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import type { PtySession } from "@veyyon/natives";
import { errorMessage, logger } from "@veyyon/utils";
import { formatBytes } from "@veyyon/utils/format";
import { SUPPORTED_IMAGE_MIME_TYPES, SUPPORTED_VIDEO_MIME_TYPES } from "@veyyon/utils/mime";
import { initializeExtensions } from "../modes/runtime-init";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-types";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { MAX_IMAGE_INPUT_BYTES } from "../utils/image-loading";
import { base64DecodedBytes, MAX_PROMPT_ATTACHMENT_BYTES, MAX_VIDEO_INPUT_BYTES } from "../utils/video-loading";
import { writeFrame } from "./frames";
import { GuiHostUIContext, InteractionLedger } from "./interactions";
import { publishModelsView } from "./models-view";
import { enterPlanModeIfConfigured } from "./plan-approval";
import type { PresentationLedger } from "./presentation";
import { reportQueuedPrompts } from "./queued-prompts";
import {
	agentMessageToTranscriptEntry,
	appendedEntryToTranscriptEntry,
	seedFirstMessagePosition,
} from "./transcript-conversion";
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
	presentationLedger: PresentationLedger;
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
	/**
	 * Signature of the last queued prompts frame written for this session, used
	 * to suppress redundant frames when the queues have not changed.
	 */
	lastQueuedPromptsSignature?: string;
	/**
	 * Re-state the session index to this client, installed per connection.
	 *
	 * The rail draws each row's status from the last listing it received, and
	 * a session's status is read from its file, where a turn in flight is a
	 * trailing prompt with no reply after it: `pending`, which the row draws
	 * as `Working`. Nothing in a turn's own frames carries a status, so the
	 * row reports a finished turn as running until a listing replaces it.
	 */
	refreshSessionList?: () => Promise<void>;
	/**
	 * Re-state the workspace domains a turn changes, installed per connection.
	 *
	 * The host answers `Changes`, `FileTree`, `Usage` and `Processes` only when
	 * a client asks, and the desktop asks once, at the handshake. Without this
	 * the panel keeps drawing the workspace as it stood when the session
	 * opened, however many files the turn just edited.
	 */
	republishWorkspace?: () => Promise<void>;
	/**
	 * The directory this client last loaded a file tree for, so the
	 * re-statement covers the tree it is looking at and a client that never
	 * loaded one is sent none.
	 */
	fileTreeRoot?: string;
	/**
	 * Whether this client has been sent a process list. Answering one is what
	 * starts the project's supervisor, so a client that never asked is never
	 * re-stated: the host would otherwise start a broker behind a workspace
	 * that supervises nothing.
	 */
	processesListed?: boolean;
	/**
	 * Whether the open session has recorded a message yet. A live entry arrives
	 * one at a time with no list around it, so the flag is what tells a setting
	 * the session opened in from a change made inside its conversation; it is
	 * seeded from the session's entries when a session is attached.
	 */
	hasMessageEntry?: boolean;
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
	// The session resolves its own model, through a longer chain than a
	// configuration read can reproduce, and until now nothing told the client
	// which one it picked: the composer kept offering to select a model while
	// a prompt would have run on this one.
	await publishModelsView(socket, { clientState: state, ...options });
	return session;
}

/**
 * Attach transcript and streaming listeners from an AgentSession to the client socket.
 */
export function attachTurnListeners(session: AgentSession, socket: net.Socket, state: ClientSessionState): void {
	state.unsubscribeSession?.();

	const sm = session.sessionManager;
	state.sessionManager = sm;
	seedFirstMessagePosition(state, sm.getEntries());

	sm.onEntryAppended = (entry: SessionEntry) => {
		state.revision += 1;
		const transcriptEntry = appendedEntryToTranscriptEntry(state, entry, state.revision, {
			ledger: state.presentationLedger,
			session: state.agentSession,
		});

		if (entry.type === "message") {
			const msg = entry.message as { role?: string; toolCallId?: string; isError?: boolean };
			if (msg.role === "assistant") {
				for (const block of transcriptEntry.content) {
					if ("ToolCall" in block) {
						state.presentationLedger.recordCall(
							block.ToolCall.id,
							block.ToolCall.name,
							block.ToolCall.arguments,
							entry.id,
							transcriptEntry,
						);
					}
				}
			} else if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
				state.presentationLedger.recordResult(
					msg.toolCallId,
					entry.message,
					msg.isError,
					entry.id,
					transcriptEntry,
				);
				const updatedAssistant = state.presentationLedger.markResultAvailable(msg.toolCallId, name =>
					state.agentSession?.getToolByName(name),
				);
				if (updatedAssistant) {
					writeFrame(socket, {
						TranscriptUpdated: {
							revision: state.revision,
							entry: updatedAssistant,
						},
					});
				}
			}
		}

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
				const accumulating = agentMessageToTranscriptEntry(event.message, state.revision, state.streamingEntry, {
					ledger: state.presentationLedger,
					session: state.agentSession,
					isStreaming: true,
				});
				for (const block of accumulating.content) {
					if ("ToolCall" in block) {
						state.presentationLedger.recordCall(block.ToolCall.id, block.ToolCall.name, block.ToolCall.arguments);
					}
				}
				writeStreaming(socket, state, accumulating);
			}
			break;
		}
		case "tool_execution_start": {
			// The run bar reads `tool`; a call that starts between two assistant
			// deltas still carries the entry it belongs to.
			state.streamingTool = event.toolName;
			state.streamingToolCallId = event.toolCallId;
			state.presentationLedger.recordCall(event.toolCallId, event.toolName, event.args);
			if (state.streamingAccumulating) writeStreaming(socket, state, state.streamingAccumulating);
			break;
		}
		case "tool_execution_update": {
			state.presentationLedger.recordResult(event.toolCallId, event.partialResult, event.partialResult.isError);
			if (state.streamingAccumulating) {
				const updated = state.presentationLedger.regenerateCallEntryPresentation(
					state.streamingAccumulating,
					name => state.agentSession?.getToolByName(name),
					{ partial: true },
				);
				if (updated) state.streamingAccumulating = updated;
				writeStreaming(socket, state, state.streamingAccumulating);
			}
			break;
		}
		case "tool_execution_end": {
			state.streamingTool = undefined;
			state.streamingToolCallId = undefined;
			state.presentationLedger.recordResult(event.toolCallId, event.result, event.isError);
			if (state.streamingAccumulating) {
				const updated = state.presentationLedger.regenerateCallEntryPresentation(
					state.streamingAccumulating,
					name => state.agentSession?.getToolByName(name),
				);
				if (updated) state.streamingAccumulating = updated;
				writeStreaming(socket, state, state.streamingAccumulating);
			}
			break;
		}
		case "message_end": {
			if (event.message.role === "assistant") clearStreaming(socket, state);
			break;
		}
		case "turn_end": {
			clearStreaming(socket, state);
			reportQueuedPrompts(socket, state);
			break;
		}
		case "agent_end": {
			clearStreaming(socket, state);
			reportQueuedPrompts(socket, state);
			// The session is idle here, and only here: a tool call ends a turn
			// mid-loop, and the file then trails a tool result, which lists as
			// an interrupted session. Listing on `turn_end` would draw `Failed`
			// on a row whose turn is still running.
			void state.refreshSessionList?.();
			// The same moment is when the files the turn edited, the files it
			// created, the processes it launched and the tokens it spent stop
			// changing, and nothing else asks for any of them again.
			void state.republishWorkspace?.();
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
 * Start a prompt turn and settle once the session has accepted it: the turn
 * has begun (`agent_start`), or it was queued behind a running turn, or the
 * prompt resolved without a turn (a slash command handled locally). A
 * rejection before that point is the caller's failure; one after it is a
 * turn error, which the session records on the transcript entry itself.
 * Returns whether a turn was started.
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

	const accepted = Promise.withResolvers<boolean>();
	let settled = false;
	const settle = (outcome: { started: boolean } | { error: unknown }) => {
		if (settled) {
			// A turn error after acceptance lands on the transcript entry; here
			// it is only kept out of the unhandled-rejection path.
			if ("error" in outcome) {
				const message = errorMessage(outcome.error);
				logger.warn("GUI host turn ended in error", { error: message });
			}
			return;
		}
		settled = true;
		if ("error" in outcome) accepted.reject(outcome.error);
		else accepted.resolve(outcome.started);
	};
	const unsubscribe = session.subscribe(event => {
		if (event.type === "agent_start") settle({ started: true });
	});
	const promptPromise = session.prompt(promptText, {
		images: images.length > 0 ? images : undefined,
		videos: videos.length > 0 ? videos : undefined,
		streamingBehavior,
	});
	state.activeTurnPromise = promptPromise;
	void promptPromise
		.then(
			started => settle({ started }),
			(error: unknown) => settle({ error }),
		)
		.finally(() => {
			if (state.activeTurnPromise === promptPromise) state.activeTurnPromise = undefined;
		});
	try {
		return await accepted.promise;
	} finally {
		unsubscribe();
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
	state.presentationLedger?.clear();
	if (state.agentSession) {
		const session = state.agentSession;
		state.agentSession = undefined;
		await session.dispose();
	}
	state.lastQueuedPromptsSignature = undefined;
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
