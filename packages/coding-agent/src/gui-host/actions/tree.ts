import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import {
	flattenSessionTree,
	isTreeEntryShown,
	sessionTreeActivePath,
	treeEntryRow,
} from "../../presentation/session-tree";
import { actingSettings } from "../acting-settings";
import { reportQueuedPrompts } from "../queued-prompts";
import { getOrCreateAgentSession } from "../turns";
import { SESSION_TREE_FILTERS, type SessionTreeEntryKind, type SessionTreeView } from "../wire";
import {
	activateSession,
	activeManager,
	emitActiveSessionAndTranscript,
	emitSessionList,
	isActive,
	replyError,
	replySessionNotFound,
	startingWork,
} from "./active-session";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

/** The kind a message entry's row is toned by, by the message's role; any other role is `other`. */
const KIND_BY_ROLE: Partial<Record<string, SessionTreeEntryKind>> = {
	user: "user",
	developer: "developer",
	assistant: "assistant",
	toolResult: "tool_result",
	bashExecution: "bash",
};

/** The kind every other entry's row is toned by, by entry type; an unlisted type is `other`. */
const KIND_BY_ENTRY: Partial<Record<SessionEntry["type"], SessionTreeEntryKind>> = {
	custom_message: "custom_message",
	compaction: "compaction",
	branch_summary: "branch_summary",
	model_change: "model_change",
	thinking_level_change: "thinking_change",
	label: "label",
	custom: "custom",
};

interface SessionRef {
	session?: string;
}

interface NavigateTreePayload extends SessionRef {
	entry?: string;
	summarize?: boolean;
	instructions?: string | null;
}

interface SetEntryLabelPayload extends SessionRef {
	entry?: string;
	label?: string | null;
}

/**
 * `sm`'s tree as the terminal's `/tree` picker draws it: every entry in
 * pre-order with the current branch first, each row's text, and the filter
 * modes that show it, so the window filters without re-deriving the rules.
 */
async function sessionTreeView(ctx: ActionContext, sm: SessionManager): Promise<SessionTreeView> {
	const settings = await actingSettings(ctx);
	const leaf = sm.getLeafId();
	const { nodes, toolCalls } = flattenSessionTree(sm.getTree(), leaf);
	const onPath = sessionTreeActivePath(nodes, leaf);
	return {
		leaf,
		nodes: nodes.map(({ node, depth }) => {
			const { entry } = node;
			const row = treeEntryRow(node, toolCalls);
			return {
				id: entry.id,
				parent: entry.parentId ?? null,
				depth,
				kind:
					entry.type === "message"
						? (KIND_BY_ROLE[entry.message.role] ?? "other")
						: (KIND_BY_ENTRY[entry.type] ?? "other"),
				prefix: row.prefix,
				text: row.text,
				label: node.label ?? null,
				on_path: onPath.has(entry.id),
				shown_in: SESSION_TREE_FILTERS.filter(filter => isTreeEntryShown(node, filter, leaf)),
			};
		}),
		summary_offered: settings.get("branchSummary.enabled"),
		filter: settings.get("treeFilterMode"),
	};
}

async function emitSessionTree(ctx: ActionContext, sm: SessionManager): Promise<void> {
	ctx.reply.snapshot({ SessionTree: { session: sm.getSessionId(), tree: await sessionTreeView(ctx, sm) } });
}

/** The session the payload names, or `undefined` after refusing a payload that names none. */
function namedSession(ctx: ActionContext, payload: SessionRef | undefined): string | undefined {
	const session = payload?.session?.trim();
	if (session) return session;
	ctx.reply.failure({
		scope: "Session",
		code: "INVALID_ARGUMENTS",
		message: `${ctx.actionTag} requires session`,
		retryable: false,
	});
	return undefined;
}

/**
 * The session the window has open, when the payload names it. The tree sheet
 * acts on the thread on screen; naming any other session is refused rather than
 * switching to it, so reading or labelling a tree never moves the client.
 */
function openSession(ctx: ActionContext, payload: SessionRef | undefined): SessionManager | undefined {
	const session = namedSession(ctx, payload);
	if (!session) return undefined;
	const sm = activeManager(ctx);
	if (isActive(sm, session)) return sm;
	replySessionNotFound(ctx, session);
	return undefined;
}

/** The entry the payload names, or `undefined` after refusing a payload that names none. */
function namedEntry(ctx: ActionContext, entry: string | undefined): string | undefined {
	const id = entry?.trim();
	if (id) return id;
	ctx.reply.failure({
		scope: "Session",
		code: "INVALID_ARGUMENTS",
		message: `${ctx.actionTag} requires entry`,
		retryable: false,
	});
	return undefined;
}

/**
 * Fork the session into a new file holding the same entries, as `/fork` does,
 * and move the window onto the fork.
 */
const handleForkSession: ActionHandler<SessionRef | undefined> = async (ctx, payload) => {
	const session = namedSession(ctx, payload);
	if (!session) return;
	try {
		const sm = await activateSession(ctx, session);
		if (!sm) return;
		const agent = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
		if (agent.isStreaming) {
			ctx.reply.failure({
				scope: "Session",
				code: "TURN_IN_PROGRESS",
				message: "Wait for the current response to finish or abort it before forking.",
				retryable: true,
			});
			return;
		}
		if (!(await agent.fork())) {
			ctx.reply.failure({
				scope: "Session",
				code: "FORK_FAILED",
				message: "Fork failed (session not persisted or cancelled)",
				retryable: false,
			});
			return;
		}
		// The fork is a new file; the session list reads the directory.
		await agent.sessionManager.ensureOnDisk();
		emitActiveSessionAndTranscript(ctx, agent.sessionManager);
		await emitSessionList(ctx);
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "FORK_SESSION_FAILED", error);
	}
};

const handleLoadSessionTree: ActionHandler<SessionRef | undefined> = async (ctx, payload) => {
	const sm = openSession(ctx, payload);
	if (!sm) return;
	try {
		await emitSessionTree(ctx, sm);
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "LOAD_SESSION_TREE_FAILED", error);
	}
};

/**
 * Move the session's leaf to an entry, summarizing the branch it leaves when
 * asked, as the terminal's `/tree` picker does. A user message lands the leaf
 * on its parent and hands its text back to the composer.
 *
 * The navigation is work on its way to starting until it settles: a leave
 * arriving meanwhile waits for it rather than reloading the agent onto the
 * next session while the leaf moves. `AbortBranchSummary` ends a summary
 * early; frames dispatch concurrently, so it reaches the session mid-call.
 */
const handleNavigateTree: ActionHandler<NavigateTreePayload | undefined> = async (ctx, payload) => {
	const sm = openSession(ctx, payload);
	if (!sm) return;
	const entry = namedEntry(ctx, payload?.entry);
	if (!entry) return;
	await startingWork(ctx, sm.getSessionId(), async () => {
		try {
			const agent = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
			if (agent.isStreaming) {
				ctx.reply.failure({
					scope: "Session",
					code: "TURN_IN_PROGRESS",
					message: "Wait for the current response to finish or abort it before navigating the tree.",
					retryable: true,
				});
				return;
			}
			const result = await agent.navigateTree(entry, {
				summarize: payload?.summarize === true,
				customInstructions: payload?.instructions?.trim() || undefined,
			});
			if (result.aborted) {
				ctx.reply.failure({
					scope: "Session",
					code: "BRANCH_SUMMARY_CANCELLED",
					message: "Branch summarization cancelled",
					retryable: true,
				});
				return;
			}
			if (result.cancelled) {
				ctx.reply.failure({
					scope: "Session",
					code: "NAVIGATION_CANCELLED",
					message: "Navigation cancelled",
					retryable: true,
				});
				return;
			}
			emitActiveSessionAndTranscript(ctx, agent.sessionManager);
			await emitSessionTree(ctx, agent.sessionManager);
			if (result.editorText) reportQueuedPrompts(ctx.socket, ctx.clientState, { restored: result.editorText });
			ctx.reply.success();
		} catch (error) {
			replyError(ctx, "NAVIGATE_TREE_FAILED", error);
		}
	});
};

const handleAbortBranchSummary: ActionHandler<SessionRef | undefined> = (ctx, payload) => {
	if (!openSession(ctx, payload)) return;
	ctx.clientState.agentSession?.abortBranchSummary();
	ctx.reply.success();
};

/** Set or clear an entry's label, as the terminal's label editor does, and state the tree again. */
const handleSetEntryLabel: ActionHandler<SetEntryLabelPayload | undefined> = async (ctx, payload) => {
	const sm = openSession(ctx, payload);
	if (!sm) return;
	const entry = namedEntry(ctx, payload?.entry);
	if (!entry) return;
	try {
		sm.appendLabelChange(entry, payload?.label?.trim() || undefined);
		await emitSessionTree(ctx, sm);
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "SET_ENTRY_LABEL_FAILED", error);
	}
};

export const treeActionHandlers: ActionHandlersMap = {
	ForkSession: handleForkSession,
	LoadSessionTree: handleLoadSessionTree,
	NavigateTree: handleNavigateTree,
	AbortBranchSummary: handleAbortBranchSummary,
	SetEntryLabel: handleSetEntryLabel,
};
