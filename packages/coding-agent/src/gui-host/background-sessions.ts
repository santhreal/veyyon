import type * as net from "node:net";
import type { AuthStorage } from "@veyyon/ai";
import { errorMessage, logger } from "@veyyon/utils";
import type { AgentSession } from "../session/agent-session";
import { ExtensionChrome } from "./extension-chrome";
import {
	adoptAgentSession,
	type BackgroundSession,
	type ClientSessionState,
	dropStreaming,
	endBackgroundSession,
	type LiveTurn,
} from "./turns";

/**
 * Whether a session has work that leaving it must not end: a turn in flight or
 * still settling, a compaction, or a decision waiting on the operator.
 */
export function isWorking(live: LiveTurn & { activeTurnPromise?: Promise<boolean> }): boolean {
	const session = live.agentSession;
	if (!session) return false;
	return (
		session.isStreaming ||
		session.isCompacting ||
		session.hasPostPromptWork ||
		live.activeTurnPromise !== undefined ||
		live.interactions?.isEmpty === false
	);
}

/** The background session `session` names, by id or by file, or `undefined`. */
export function backgroundSession(state: ClientSessionState, session: string): BackgroundSession | undefined {
	const byId = state.background?.get(session);
	if (byId) return byId;
	for (const background of state.background?.values() ?? []) {
		if (background.agentSession.sessionManager.getSessionFile() === session) return background;
	}
	return undefined;
}

/**
 * Move the open session to the background, when it is still working, before
 * the window opens another. Returns whether it moved; an idle session is left
 * open for the caller to reload in place or dispose.
 *
 * Everything that draws the session lets go of it first: its event and entry
 * listeners, its status line, its command catalogue and the stream the window
 * holds for it, which is cleared before anything of the next thread is sent.
 * The window files a stream and an appended entry under the thread it has
 * open, so anything the session wrote from here on would be drawn over the
 * wrong one. Its goal and loop stand down, since their bridges drive the
 * client's open session. What it needs to run on moves with it: its agent,
 * which goes on persisting every entry to its own file; its decisions, which
 * keep reaching the window stamped with its own id; its console, which does
 * the same; and what its extensions draw, which moves to a chrome of its own
 * stamped with its id, so the window keeps it filed under the thread.
 */
export function parkOpenSession(state: ClientSessionState, socket: net.Socket): boolean {
	const agentSession = state.agentSession;
	if (!agentSession || !isWorking(state)) return false;
	const id = agentSession.sessionManager.getSessionId();
	state.unsubscribeSession?.();
	state.unsubscribeSession = undefined;
	state.unsubscribeCommands?.();
	state.unsubscribeCommands = undefined;
	state.goalDriver?.unsubscribeFromSession();
	state.goalDriver?.cancelContinuation();
	state.goalDriver = undefined;
	state.goalBridge = undefined;
	state.loopDriver?.unsubscribeFromSession();
	state.loopDriver?.cancelAutoSubmit();
	state.loopDriver = undefined;
	state.loopBridge = undefined;
	const tool =
		state.streamingTool !== undefined && state.streamingToolCallId !== undefined
			? { name: state.streamingTool, id: state.streamingToolCallId }
			: undefined;
	dropStreaming(socket, state);
	const chrome = new ExtensionChrome(socket, () => id);
	state.extensionChrome?.handOver(chrome);
	state.uiContext?.chromeRoute.drawInto(chrome);
	state.presentationLedger.clear();
	const background: BackgroundSession = {
		id,
		agentSession,
		interactions: state.interactions,
		autoswarm: state.autoswarm,
		uiContext: state.uiContext,
		chrome,
		tool,
		activeTurnPromise: state.activeTurnPromise,
		planModePreviousTools: state.planModePreviousTools,
		unsubscribe: () => {},
	};
	state.agentSession = undefined;
	state.sessionManager = undefined;
	state.interactions = undefined;
	state.autoswarm = undefined;
	state.uiContext = undefined;
	state.activeTurnPromise = undefined;
	state.planModePreviousTools = undefined;
	state.hasMessageEntry = undefined;
	state.lastQueuedPromptsSignature = undefined;
	state.lastTodoSignature = undefined;
	state.background ??= new Map();
	state.background.set(id, background);
	const unsubscribe = agentSession.subscribe(event => {
		// The call in flight follows the rules the open session's run bar
		// does, so a thread opened mid-call draws the call it is on.
		switch (event.type) {
			case "tool_execution_start":
				background.tool = { name: event.toolName, id: event.toolCallId };
				return;
			case "tool_execution_end":
			case "turn_end":
				background.tool = undefined;
				return;
			case "message_end":
				if (event.message.role === "assistant") background.tool = undefined;
				return;
			case "agent_end":
				background.tool = undefined;
				// The row is listed from the session's file, which trails the
				// prompt until the reply lands, so it reads `Pending` until a
				// listing after the turn replaces it; the files the turn edited
				// stop changing here.
				void state.refreshSessionList?.();
				void state.republishWorkspace?.();
				releaseWhenIdle(state, background);
				return;
			default:
				return;
		}
	});
	// A decision cancelled or timed out with the agent idle ends nothing the
	// agent would report, so the ledger draining is watched as well.
	background.interactions?.onDrained(() => releaseIfIdle(state, background));
	background.unsubscribe = () => {
		unsubscribe();
		background.interactions?.onDrained(undefined);
	};
	const turn = background.activeTurnPromise;
	if (turn) {
		// The prompt's own settle clears the open session's copy, which this
		// no longer is, so the background copy is cleared here.
		const settled = () => {
			if (background.activeTurnPromise === turn) background.activeTurnPromise = undefined;
			releaseIfIdle(state, background);
		};
		void turn.then(settled, settled);
	}
	releaseWhenIdle(state, background);
	return true;
}

/** Release the background session once its agent goes idle, if nothing else holds it. */
function releaseWhenIdle(state: ClientSessionState, background: BackgroundSession): void {
	background.agentSession.waitForIdle().then(
		() => releaseIfIdle(state, background),
		(error: unknown) =>
			logger.warn("GUI host could not wait on a background session", {
				session: background.id,
				error: errorMessage(error),
			}),
	);
}

/**
 * Dispose the background session when nothing is left for it to do, so a
 * thread the operator left does not hold its agent for the life of the
 * connection. Its file already holds everything it did; opening the thread
 * again reads it from there.
 */
export function releaseIfIdle(state: ClientSessionState, background: BackgroundSession): void {
	if (state.background?.get(background.id) !== background || isWorking(background)) return;
	void endBackgroundSession(state, background.id);
}

/**
 * Take a background session back on screen, as the window opens its thread
 * again: the same agent, with its turn still running, its decisions still
 * open and what its extensions drew, adopted as the client's open session.
 * The open session must already be let go of.
 */
export async function resumeBackgroundSession(
	state: ClientSessionState,
	socket: net.Socket,
	background: BackgroundSession,
	options: { cwd: string; agentDir: string; authStorage: () => Promise<AuthStorage> },
): Promise<AgentSession> {
	state.background?.delete(background.id);
	background.unsubscribe();
	state.interactions = background.interactions;
	state.autoswarm = background.autoswarm;
	state.activeTurnPromise = background.activeTurnPromise;
	state.planModePreviousTools = background.planModePreviousTools;
	if (state.extensionChrome) {
		background.chrome.handOver(state.extensionChrome);
		background.uiContext?.chromeRoute.returnHome();
	}
	state.uiContext = background.uiContext;
	// Restated with the reply, behind the transcript: see `restateStreamingReply`.
	state.streamingTool = background.tool?.name;
	state.streamingToolCallId = background.tool?.id;
	await adoptAgentSession(background.agentSession, socket, state, options);
	return background.agentSession;
}
