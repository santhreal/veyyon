import * as fs from "node:fs/promises";
import type * as net from "node:net";
import * as path from "node:path";
import { listSessions, listSessionsReadOnly } from "@veyyon/kernel/session/session-listing";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { errorMessage } from "@veyyon/utils";
import { writeFrame } from "../frames";
import { reportQueuedPrompts } from "../queued-prompts";
import { sessionHeaderToView, sessionInfoToSummary } from "../session-bridge";
import {
	appendedEntryToTranscriptEntry,
	seedFirstMessagePosition,
	sessionEntriesToTranscript,
} from "../transcript-conversion";
import { type ClientSessionState, disposeTurnSession, settleRunningTurn } from "../turns";
import type { ErrorScope, TranscriptEntry } from "../wire";
import { sessionFiles } from "./session-files";
import type { ActionContext } from "./types";

export const sessionStorage = new FileSessionStorage();

export function sessionDirFor(cwd: string, agentDir: string): string {
	return computeDefaultSessionDir(cwd, sessionStorage, path.join(agentDir, "sessions"));
}

/** Resolve a session id or file path to the file on disk, or `undefined`. */
export async function findSessionPath(session: string, cwd: string, agentDir: string): Promise<string | undefined> {
	try {
		await fs.access(session);
		return session;
	} catch {
		// Not a path: resolve it as a session id below.
	}
	const currentDir = sessionDirFor(cwd, agentDir);
	const sessions = await listSessions(currentDir, sessionStorage);
	const current = sessions.find(s => s.id === session || s.path === session)?.path;
	if (current) return current;
	const directories = new Set((await sessionFiles(agentDir)).map(file => path.dirname(file)));
	for (const directory of directories) {
		if (directory === currentDir) continue;
		const found = (await listSessionsReadOnly(directory, sessionStorage)).find(
			s => s.id === session || s.path === session,
		);
		if (found) return found.path;
	}
	return undefined;
}

export function activeManager(ctx: ActionContext): SessionManager | undefined {
	return ctx.clientState.sessionManager ?? ctx.clientState.agentSession?.sessionManager;
}

export function activeCwd(state: ClientSessionState, fallback: string): string {
	return (state.sessionManager ?? state.agentSession?.sessionManager)?.getCwd() ?? fallback;
}

function rescopeWorkspace(ctx: ActionContext, previousCwd: string, manager: SessionManager): void {
	const cwd = manager.getCwd();
	if (path.resolve(previousCwd) === path.resolve(cwd)) return;
	if (ctx.clientState.fileTreeRoot !== undefined) ctx.clientState.fileTreeRoot = cwd;
	// Process subscriptions are workspace-scoped; terminal instances remain independent.
	for (const stop of ctx.clientState.processFollowers?.values() ?? []) stop();
	ctx.clientState.processFollowers?.clear();
}

export function isActive(sm: SessionManager | undefined, session: string): sm is SessionManager {
	return sm !== undefined && (sm.getSessionId() === session || sm.getSessionFile() === session);
}

export function replyError(ctx: ActionContext, code: string, error: unknown, scope: ErrorScope = "Session"): void {
	ctx.reply.failure({
		scope,
		code,
		message: errorMessage(error),
		retryable: false,
	});
}

export function replySessionNotFound(ctx: ActionContext, session: string): void {
	ctx.reply.failure({
		scope: "Session",
		code: "SESSION_NOT_FOUND",
		message: `Session '${session}' was not found`,
		retryable: false,
	});
}

/**
 * State the header of the session the client is now on.
 *
 * The `Transcript` section carries no session id, and the desktop files one
 * under the last header it received (`reducer/snapshot.rs`), so an action that
 * changes which session is active states the header before it sends anything
 * belonging to that session. Without it the entries land in the pane of the
 * session the operator was reading, and every later append addresses the
 * wrong one.
 */
export function emitActiveSession(ctx: ActionContext, sm: SessionManager): void {
	ctx.clientState.revision += 1;
	ctx.reply.snapshot({
		ActiveSession: {
			revision: ctx.clientState.revision,
			value: sessionHeaderToView(sm.getHeader(), sm.getEntries()),
		},
	});
}

export function emitActiveSessionAndTranscript(
	ctx: ActionContext,
	sm: SessionManager,
	entries?: TranscriptEntry[],
): void {
	emitActiveSession(ctx, sm);
	ctx.clientState.revision += 1;
	const ledger = ctx.clientState.presentationLedger;
	const session = ctx.clientState.agentSession;
	const transcriptEntries =
		entries ?? sessionEntriesToTranscript(sm.getEntries(), ctx.clientState.revision, { ledger, session });
	ctx.reply.snapshot({
		Transcript: { revision: ctx.clientState.revision, value: transcriptEntries },
	});
	reportQueuedPrompts(ctx.socket, ctx.clientState);
}

/**
 * State the session index to one client, outside any request.
 *
 * A row's status is whatever the last listing reported, and a session's status
 * is derived from its file: a turn in flight leaves a trailing prompt with no
 * reply after it, which lists as `pending`, so the row keeps drawing `Working`
 * until another listing replaces it. The listing that replaces it is owed when
 * the turn ends, which is not a request the client sent.
 */
export async function writeSessionList(
	socket: net.Socket,
	clientState: ClientSessionState,
	cwd: string,
	agentDir: string,
): Promise<void> {
	const sessions = await listSessions(sessionDirFor(cwd, agentDir), sessionStorage);
	clientState.revision += 1;
	writeFrame(socket, {
		Snapshot: { Sessions: [{ revision: clientState.revision, value: sessions.map(sessionInfoToSummary) }, []] },
	});
}

export function emitSessionList(ctx: ActionContext): Promise<void> {
	return writeSessionList(ctx.socket, ctx.clientState, ctx.cwd, ctx.agentDir);
}

export function wireSessionManager(ctx: ActionContext, sm: SessionManager): void {
	ctx.clientState.sessionManager = sm;
	seedFirstMessagePosition(ctx.clientState, sm.getEntries());
	sm.onEntryAppended = entry => {
		ctx.clientState.revision += 1;
		const ledger = ctx.clientState.presentationLedger;
		const session = ctx.clientState.agentSession;
		const transcriptEntry = appendedEntryToTranscriptEntry(ctx.clientState, entry, ctx.clientState.revision, {
			ledger,
			session,
		});

		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role === "assistant") {
			for (const block of transcriptEntry.content) {
				if ("ToolCall" in block) {
					ledger?.recordCall(
						block.ToolCall.id,
						block.ToolCall.name,
						block.ToolCall.arguments,
						entry.id,
						transcriptEntry,
					);
				}
			}
		} else if (message?.role === "toolResult") {
			ledger?.recordResult(message.toolCallId, message, message.isError, entry.id, transcriptEntry);
			const updatedAssistant = ledger?.markResultAvailable(message.toolCallId, name => session?.getToolByName(name));
			if (updatedAssistant) {
				writeFrame(ctx.socket, {
					TranscriptUpdated: { revision: ctx.clientState.revision, entry: updatedAssistant },
				});
			}
		}

		writeFrame(ctx.socket, {
			TranscriptAppended: { revision: ctx.clientState.revision, entries: [transcriptEntry] },
		});
	};
}

/**
 * Make `session` the client's active session. A live agent session switches
 * in place, so its extensions see `session_before_switch` and its listeners
 * stay attached; without one the session file is opened as a plain manager,
 * and the first prompt attaches an agent over it. Returns `undefined` when
 * the session does not exist or an extension cancelled the switch, after
 * replying with the failure.
 */
export async function activateSession(ctx: ActionContext, session: string): Promise<SessionManager | undefined> {
	const current = activeManager(ctx);
	if (isActive(current, session)) return current;
	const previousCwd = ctx.cwd;

	const sessionPath = await findSessionPath(session, ctx.cwd, ctx.agentDir);
	if (!sessionPath) {
		replySessionNotFound(ctx, session);
		return undefined;
	}

	const agent = ctx.clientState.agentSession;
	if (agent) {
		// The turn ends before the file under it is replaced, and only once the
		// session is known to exist: a switch to a session that is not there
		// leaves the turn running.
		await settleRunningTurn(ctx.clientState);
		ctx.clientState.presentationLedger?.clear();
		if (!(await agent.switchSession(sessionPath))) {
			ctx.reply.failure({
				scope: "Session",
				code: "SWITCH_CANCELLED",
				message: "An extension cancelled the session switch",
				retryable: true,
			});
			return undefined;
		}
		rescopeWorkspace(ctx, previousCwd, agent.sessionManager);
		return agent.sessionManager;
	}

	ctx.clientState.presentationLedger?.clear();
	await disposeTurnSession(ctx.clientState);
	const sm = await SessionManager.open(sessionPath, undefined, undefined, { suppressBreadcrumb: true });
	wireSessionManager(ctx, sm);
	rescopeWorkspace(ctx, previousCwd, sm);
	return sm;
}
