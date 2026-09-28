import * as fs from "node:fs/promises";
import type * as net from "node:net";
import * as path from "node:path";
import { listSessions, listSessionsReadOnly, type SessionInfo } from "@veyyon/kernel/session/session-listing";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { errorMessage } from "@veyyon/utils";
import { goalFromModeData } from "../../goals/driver";
import type { Goal } from "../../goals/state";
import { backgroundSession, parkOpenSession, resumeBackgroundSession } from "../background-sessions";
import { foregroundSection } from "../foreground-view";
import { writeFrame } from "../frames";
import { goalSection } from "../goal-view";
import { reportQueuedPrompts } from "../queued-prompts";
import { sessionHeaderToView, sessionInfoToSummary } from "../session-bridge";
import { DesktopStatusBridge } from "../status-bridge";
import { todoSection } from "../todo-view";
import {
	appendedEntryToTranscriptEntry,
	seedFirstMessagePosition,
	sessionEntriesToTranscript,
} from "../transcript-conversion";
import { type ClientSessionState, disposeTurnSession, restateStreamingReply } from "../turns";
import type { ErrorScope, GoalStatus, GoalView, TranscriptEntry } from "../wire";
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
	// A session taken back from the background may be mid-reply, and the
	// window cleared its stream when it left.
	restateStreamingReply(ctx.socket, ctx.clientState);
	reportQueuedPrompts(ctx.socket, ctx.clientState);
	// A window that opens a session mid-wait draws the control from this
	// section; the subscription only reports the edges, so without it the
	// control stays absent until the command exits.
	const openSession = sm.getSessionId();
	if (openSession) {
		ctx.reply.snapshot({
			ForegroundCommand: { session: openSession, command: foregroundSection(openSession) },
		});
		// The branch, the pace, the serving login and its quota are stated
		// once on open; after that they move only at the edges the bridge
		// follows.
		ctx.clientState.status ??= new DesktopStatusBridge(ctx.socket);
		ctx.clientState.status.publishOpened(openSession, sm.getCwd());
		// A session that reloaded in place kept its extensions, so what they
		// set is stated under the id it moved to.
		ctx.clientState.extensionChrome?.follow();
	}
	// A session resumed with a plan on it holds that plan before any turn
	// runs, so the card is drawn from the board the file recorded rather than
	// waiting for the next `todo` call to state one.
	if (ctx.clientState.agentSession) {
		const section = todoSection(ctx.clientState.agentSession);
		ctx.clientState.lastTodoSignature = JSON.stringify(section);
		ctx.reply.snapshot(section);
	}
	if (ctx.clientState.agentSession) {
		ctx.reply.snapshot(
			goalSection(ctx.clientState.agentSession, ctx.clientState.goalDriver, ctx.clientState.goalBridge?.stoodDown),
		);
	} else {
		let goal: Goal | undefined;
		let mode: string | undefined;
		const entries = sm.getEntries();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry?.type === "mode_change") {
				mode = entry.mode;
				if (mode === "goal" || mode === "goal_paused") {
					const payload =
						("data" in entry ? entry.data : undefined) ?? ("modeData" in entry ? entry.modeData : undefined);
					if (payload && typeof payload === "object") {
						goal = goalFromModeData(payload as Record<string, unknown>);
					}
				}
				break;
			}
		}
		if (goal) {
			const status: GoalStatus = goal.status === "budget-limited" ? "budget_limited" : goal.status;
			const view: GoalView = {
				objective: goal.objective,
				status,
				driving: mode === "goal",
				tokens_used: goal.tokensUsed,
				token_budget: goal.tokenBudget ?? null,
				turns_completed: goal.turnsCompleted,
				time_used_seconds: goal.timeUsedSeconds,
				created_at_ms: goal.createdAt,
				updated_at_ms: goal.updatedAt,
				stood_down: null,
			};
			ctx.reply.snapshot({ Goal: { session: sm.getSessionId(), goal: view } });
		} else {
			ctx.reply.snapshot({ Goal: { session: sm.getSessionId(), goal: null } });
		}
	}
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
	const sessions = await listEverySession(cwd, agentDir);
	clientState.revision += 1;
	writeFrame(socket, {
		Snapshot: { Sessions: [{ revision: clientState.revision, value: sessions.map(sessionInfoToSummary) }, []] },
	});
}

/**
 * Every session of the profile, across every project directory, newest first.
 *
 * The window groups its sidebar by project, so the listing covers all of them.
 * The current project's directory is listed with orphan-backup repair, the way
 * the terminal lists it on start; every other directory is read without
 * mutation, since no session of it is open.
 */
async function listEverySession(cwd: string, agentDir: string): Promise<SessionInfo[]> {
	const currentDir = sessionDirFor(cwd, agentDir);
	const directories = new Set((await sessionFiles(agentDir)).map(file => path.dirname(file)));
	directories.delete(currentDir);
	const listings = await Promise.all([
		listSessions(currentDir, sessionStorage),
		...Array.from(directories, directory => listSessionsReadOnly(directory, sessionStorage)),
	]);
	return listings.flat().sort((a, b) => b.modified.getTime() - a.modified.getTime());
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
 * Make `session` the client's active session.
 *
 * The session being left keeps whatever it is still doing: a session with a
 * turn in flight or a decision open moves to the background and runs on (see
 * `parkOpenSession`). A session in the background is taken back as it is. An
 * idle live agent session otherwise switches in place, so its extensions see
 * `session_before_switch` and its listeners stay attached; without one the
 * session file is opened as a plain manager, and the first prompt attaches an
 * agent over it. Returns `undefined` when the session does not exist or an
 * extension cancelled the switch, after replying with the failure; the session
 * on screen is left as it was either way.
 */
export async function activateSession(ctx: ActionContext, session: string): Promise<SessionManager | undefined> {
	const current = activeManager(ctx);
	if (isActive(current, session)) return current;
	const previousCwd = ctx.cwd;

	const background = backgroundSession(ctx.clientState, session);
	if (background) {
		parkOpenSession(ctx.clientState, ctx.socket);
		await disposeTurnSession(ctx.clientState);
		const agent = await resumeBackgroundSession(ctx.clientState, ctx.socket, background, ctx);
		rescopeWorkspace(ctx, previousCwd, agent.sessionManager);
		return agent.sessionManager;
	}

	const sessionPath = await findSessionPath(session, ctx.cwd, ctx.agentDir);
	if (!sessionPath) {
		replySessionNotFound(ctx, session);
		return undefined;
	}
	parkOpenSession(ctx.clientState, ctx.socket);

	const agent = ctx.clientState.agentSession;
	if (agent) {
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
		if (ctx.clientState.goalBridge) {
			ctx.clientState.goalDriver?.unsubscribeFromSession();
			ctx.clientState.goalBridge = undefined;
			ctx.clientState.goalDriver = undefined;
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
