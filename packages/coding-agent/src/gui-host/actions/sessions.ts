import { SessionManager } from "../../session/session-manager";
import { sessionEntryToTranscriptEntry, sessionHeaderToView } from "../session-bridge";
import { disposeTurnSession, getOrCreateAgentSession } from "../turns";
import {
	activateSession as activate,
	activeManager,
	emitActiveSessionAndTranscript,
	emitSessionList,
	replyError as failure,
	findSessionPath,
	isActive,
	replySessionNotFound as notFound,
	sessionDirFor,
	sessionStorage as storage,
	wireSessionManager,
} from "./active-session";
import type { ActionHandler, ActionHandlersMap } from "./types";

const handleListSessions: ActionHandler = async ctx => {
	await emitSessionList(ctx);
	ctx.reply.success();
};

interface SessionRef {
	session?: string;
}

const handleOpenSession: ActionHandler<SessionRef | undefined> = async (ctx, payload) => {
	if (!payload?.session) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "OpenSession missing session identifier",
			retryable: false,
		});
		return;
	}
	try {
		const sm = await activate(ctx, payload.session);
		if (!sm) return;
		emitActiveSessionAndTranscript(ctx, sm);
		ctx.reply.success();
	} catch (error) {
		failure(ctx, "OPEN_SESSION_FAILED", error);
	}
};

interface CreateSessionPayload {
	workspace?: string;
	title?: string;
}

const handleCreateSession: ActionHandler<CreateSessionPayload | undefined> = async (ctx, payload) => {
	try {
		const workspace = payload?.workspace ?? ctx.cwd;
		const agent = ctx.clientState.agentSession;
		let sm: SessionManager;
		if (agent && workspace === agent.sessionManager.getCwd()) {
			if (!(await agent.newSession())) {
				ctx.reply.failure({
					scope: "Session",
					code: "SWITCH_CANCELLED",
					message: "An extension cancelled the new session",
					retryable: true,
				});
				return;
			}
			sm = agent.sessionManager;
		} else {
			await disposeTurnSession(ctx.clientState);
			sm = SessionManager.create(workspace, sessionDirFor(workspace, ctx.agentDir), storage);
			wireSessionManager(ctx, sm);
		}
		if (payload?.title) await sm.setSessionName(payload.title, "user");
		// The rail lists what the store has, so a session the operator created
		// is discoverable before its first message, as ACP's session/new does.
		await sm.ensureOnDisk();
		emitActiveSessionAndTranscript(ctx, sm);
		await emitSessionList(ctx);
		ctx.reply.success();
	} catch (error) {
		failure(ctx, "CREATE_SESSION_FAILED", error);
	}
};

interface RenameSessionPayload {
	session?: string;
	title?: string;
}

const handleRenameSession: ActionHandler<RenameSessionPayload | undefined> = async (ctx, payload) => {
	const title = payload?.title?.trim();
	if (!payload?.session || !title) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "RenameSession requires session and a non-empty title",
			retryable: false,
		});
		return;
	}
	try {
		const active = activeManager(ctx);
		if (isActive(active, payload.session)) {
			const agent = ctx.clientState.agentSession;
			if (agent) await agent.setSessionName(title, "user");
			else await active.setSessionName(title, "user");
			ctx.clientState.revision += 1;
			ctx.reply.snapshot({
				ActiveSession: { revision: ctx.clientState.revision, value: sessionHeaderToView(active.getHeader()) },
			});
		} else {
			const sessionPath = await findSessionPath(payload.session, ctx.cwd, ctx.agentDir);
			if (!sessionPath) {
				notFound(ctx, payload.session);
				return;
			}
			const sm = await SessionManager.open(sessionPath, undefined, undefined, { suppressBreadcrumb: true });
			await sm.setSessionName(title, "user");
		}
		await emitSessionList(ctx);
		ctx.reply.success();
	} catch (error) {
		failure(ctx, "RENAME_SESSION_FAILED", error);
	}
};

const handleDeleteSession: ActionHandler<SessionRef | undefined> = async (ctx, payload) => {
	if (!payload?.session) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "DeleteSession missing session identifier",
			retryable: false,
		});
		return;
	}
	try {
		const sessionPath = await findSessionPath(payload.session, ctx.cwd, ctx.agentDir);
		if (!sessionPath) {
			notFound(ctx, payload.session);
			return;
		}
		if (isActive(activeManager(ctx), payload.session)) {
			await disposeTurnSession(ctx.clientState);
			ctx.clientState.sessionManager = undefined;
		}
		await storage.deleteSessionWithArtifacts(sessionPath);
		await emitSessionList(ctx);
		ctx.reply.success();
	} catch (error) {
		failure(ctx, "DELETE_SESSION_FAILED", error);
	}
};

interface BranchSessionPayload {
	session?: string;
	entry?: string;
}

const handleBranchSession: ActionHandler<BranchSessionPayload | undefined> = async (ctx, payload) => {
	if (!payload?.session || !payload?.entry) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "BranchSession requires session and entry",
			retryable: false,
		});
		return;
	}
	try {
		const sm = await activate(ctx, payload.session);
		if (!sm) return;
		const agent = ctx.clientState.agentSession;
		if (agent) {
			const result = await agent.branch(payload.entry);
			if (result.cancelled) {
				ctx.reply.failure({
					scope: "Session",
					code: "SWITCH_CANCELLED",
					message: "An extension cancelled the branch",
					retryable: true,
				});
				return;
			}
		} else {
			sm.branch(payload.entry);
		}
		emitActiveSessionAndTranscript(ctx, sm);
		await emitSessionList(ctx);
		ctx.reply.success();
	} catch (error) {
		failure(ctx, "BRANCH_SESSION_FAILED", error);
	}
};

interface ExportSessionPayload {
	session?: string;
	format?: string;
}

const handleExportSession: ActionHandler<ExportSessionPayload | undefined> = async (ctx, payload) => {
	if (!payload?.session) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "ExportSession missing session identifier",
			retryable: false,
		});
		return;
	}
	const format = payload.format?.toLowerCase() ?? "html";
	if (format !== "html" && format !== "json") {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: `ExportSession format '${format}' is not one of html, json`,
			retryable: false,
		});
		return;
	}
	try {
		const sm = await activate(ctx, payload.session);
		if (!sm) return;
		if (format === "json") {
			ctx.reply.snapshot({
				Export: { session: payload.session, format, path: null, content: JSON.stringify(sm.getEntries(), null, 2) },
			});
		} else {
			const agent = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
			const outputPath = await agent.exportToHtml();
			ctx.reply.snapshot({ Export: { session: payload.session, format, path: outputPath, content: null } });
		}
		ctx.reply.success();
	} catch (error) {
		failure(ctx, "EXPORT_SESSION_FAILED", error);
	}
};

const handleCompactSession: ActionHandler<SessionRef | undefined> = async (ctx, payload) => {
	if (!payload?.session) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "CompactSession missing session identifier",
			retryable: false,
		});
		return;
	}
	try {
		const sm = await activate(ctx, payload.session);
		if (!sm) return;
		const agent = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
		await agent.compact();
		emitActiveSessionAndTranscript(ctx, sm);
		ctx.reply.success();
	} catch (error) {
		failure(ctx, "COMPACT_SESSION_FAILED", error);
	}
};

interface HandoffSessionPayload {
	session?: string;
	target?: string;
}

const handleHandoffSession: ActionHandler<HandoffSessionPayload | undefined> = async (ctx, payload) => {
	if (!payload?.session) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "HandoffSession requires session",
			retryable: false,
		});
		return;
	}
	try {
		const sm = await activate(ctx, payload.session);
		if (!sm) return;
		const agent = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
		// A handoff tears the live turn's session down under it; the TUI and RPC
		// hosts refuse it mid-stream for the same reason.
		if (agent.isStreaming) {
			ctx.reply.failure({
				scope: "Session",
				code: "TURN_IN_PROGRESS",
				message: "Cannot hand off while a response is in progress",
				retryable: true,
			});
			return;
		}
		const result = await agent.handoff(payload.target?.trim() || undefined);
		if (!result) {
			ctx.reply.failure({
				scope: "Session",
				code: "SWITCH_CANCELLED",
				message: "An extension cancelled the handoff",
				retryable: true,
			});
			return;
		}
		emitActiveSessionAndTranscript(ctx, sm);
		await emitSessionList(ctx);
		ctx.reply.success();
	} catch (error) {
		failure(ctx, "HANDOFF_SESSION_FAILED", error);
	}
};

interface LoadTranscriptPayload {
	session?: string;
	before?: string | null;
}

const handleLoadTranscript: ActionHandler<LoadTranscriptPayload | undefined> = async (ctx, payload) => {
	if (!payload?.session) {
		ctx.reply.failure({
			scope: "Transcript",
			code: "INVALID_ARGUMENTS",
			message: "LoadTranscript missing session identifier",
			retryable: false,
		});
		return;
	}
	if (payload.before !== null && payload.before !== undefined) {
		ctx.reply.failure({
			scope: "Transcript",
			code: "PAGING_UNSUPPORTED",
			message: "The session store holds the whole transcript; paging with 'before' is not supported",
			retryable: false,
		});
		return;
	}
	try {
		const sm = await activate(ctx, payload.session);
		if (!sm) return;
		ctx.clientState.revision += 1;
		const entries = sm.getEntries().map(e => sessionEntryToTranscriptEntry(e, ctx.clientState.revision));
		ctx.reply.snapshot({ Transcript: { revision: ctx.clientState.revision, value: entries } });
		ctx.reply.success();
	} catch (error) {
		failure(ctx, "LOAD_TRANSCRIPT_FAILED", error, "Transcript");
	}
};

export const sessionsActionHandlers: ActionHandlersMap = {
	ListSessions: handleListSessions,
	OpenSession: handleOpenSession,
	CreateSession: handleCreateSession,
	RenameSession: handleRenameSession,
	DeleteSession: handleDeleteSession,
	BranchSession: handleBranchSession,
	ExportSession: handleExportSession,
	CompactSession: handleCompactSession,
	HandoffSession: handleHandoffSession,
	LoadTranscript: handleLoadTranscript,
};
