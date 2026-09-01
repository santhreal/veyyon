import { abortTurn, executePromptTurn, getOrCreateAgentSession } from "../turns";
import type { AttachmentSubmission } from "../wire";
import { activateSession, replyError } from "./active-session";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

const QUEUE_MODES = ["Steer", "Queue"] as const;
type QueueMode = (typeof QUEUE_MODES)[number];

function isQueueMode(mode: string): mode is QueueMode {
	return (QUEUE_MODES as readonly string[]).includes(mode);
}

interface PromptPayload {
	session?: string;
	text?: string;
	attachments?: AttachmentSubmission[];
}

/**
 * Deliver `text` to `session`: as the next turn when idle, or, while a turn
 * runs, the way `behavior` says. The request settles when the session has
 * accepted the prompt, not when the turn ends; the turn's own outcome
 * reaches the client through the transcript and streaming frames.
 */
async function deliver(
	ctx: ActionContext,
	payload: PromptPayload | undefined,
	action: string,
	behavior: "Steer" | "Queue" | undefined,
): Promise<void> {
	const text = payload?.text?.trim();
	if (!payload?.session || !text) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: `${action} requires session and text`,
			retryable: false,
		});
		return;
	}
	try {
		if (!(await activateSession(ctx, payload.session))) return;
		const session = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
		const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
		const streaming = behavior === "Steer" ? "steer" : behavior === "Queue" ? "followUp" : undefined;
		if (session.isStreaming && !streaming) {
			ctx.reply.failure({
				scope: "Session",
				code: "TURN_IN_PROGRESS",
				message: "A turn is running; set a queue mode or use Steer / FollowUp",
				retryable: true,
			});
			return;
		}
		// On an idle session a steer or follow-up is the next turn; the session
		// only queues when one is running.
		await executePromptTurn(session, ctx.clientState, text, attachments, streaming);
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "PROMPT_REJECTED", error);
	}
}

const handleSubmitPrompt: ActionHandler<PromptPayload | undefined> = (ctx, payload) =>
	deliver(ctx, payload, "SubmitPrompt", ctx.clientState.queueMode);

const handleSteer: ActionHandler<PromptPayload | undefined> = (ctx, payload) => deliver(ctx, payload, "Steer", "Steer");

const handleFollowUp: ActionHandler<PromptPayload | undefined> = (ctx, payload) =>
	deliver(ctx, payload, "FollowUp", "Queue");

interface SessionRef {
	session?: string;
}

const handleAbortTurn: ActionHandler<SessionRef | undefined> = async (ctx, _payload) => {
	const session = ctx.clientState.agentSession;
	if (!session?.isStreaming) {
		ctx.reply.failure({
			scope: "Session",
			code: "NOT_RUNNING",
			message: "No turn is in flight to abort",
			retryable: false,
		});
		return;
	}
	try {
		await abortTurn(session);
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "ABORT_FAILED", error);
	}
};

interface SetQueueModePayload {
	session?: string;
	mode?: string;
}

const handleSetQueueMode: ActionHandler<SetQueueModePayload | undefined> = (ctx, payload) => {
	if (!payload?.mode || !isQueueMode(payload.mode)) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: `SetQueueMode mode must be one of ${QUEUE_MODES.join(", ")}`,
			retryable: false,
		});
		return;
	}
	ctx.clientState.queueMode = payload.mode;
	ctx.reply.success();
};

interface CancelToolPayload {
	session?: string;
	tool_call_id?: string;
}

/**
 * The runtime has no per-call cancellation: a tool runs inside the turn and
 * the turn is what stops. The id is still checked so a stale card cannot
 * abort a later call.
 */
const handleCancelTool: ActionHandler<CancelToolPayload | undefined> = async (ctx, payload) => {
	if (!payload?.tool_call_id) {
		ctx.reply.failure({
			scope: "Tool",
			code: "INVALID_ARGUMENTS",
			message: "CancelTool requires tool_call_id",
			retryable: false,
		});
		return;
	}
	const session = ctx.clientState.agentSession;
	if (!session?.isStreaming || ctx.clientState.streamingToolCallId !== payload.tool_call_id) {
		ctx.reply.failure({
			scope: "Tool",
			code: "TOOL_NOT_RUNNING",
			message: `Tool call '${payload.tool_call_id}' is not running`,
			retryable: false,
		});
		return;
	}
	try {
		await abortTurn(session);
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "CANCEL_FAILED", error, "Tool");
	}
};

interface RespondToInteractionPayload {
	session?: string;
	interaction_id?: string;
	response?: unknown;
}

const handleRespondToInteraction: ActionHandler<RespondToInteractionPayload | undefined> = (ctx, payload) => {
	if (!payload?.interaction_id) {
		ctx.reply.failure({
			scope: "Interaction",
			code: "INVALID_ARGUMENTS",
			message: "RespondToInteraction requires interaction_id",
			retryable: false,
		});
		return;
	}
	const rejection = ctx.clientState.interactions
		? ctx.clientState.interactions.answer(payload.interaction_id, payload.response)
		: { code: "INTERACTION_NOT_FOUND", message: "No session is attached, so nothing is waiting on an answer" };
	if (rejection) {
		ctx.reply.failure({ scope: "Interaction", ...rejection, retryable: false });
		return;
	}
	ctx.reply.success();
};

export const turnActionHandlers: ActionHandlersMap = {
	SubmitPrompt: handleSubmitPrompt as ActionHandler<never>,
	Steer: handleSteer as ActionHandler<never>,
	FollowUp: handleFollowUp as ActionHandler<never>,
	AbortTurn: handleAbortTurn as ActionHandler<never>,
	SetQueueMode: handleSetQueueMode as ActionHandler<never>,
	CancelTool: handleCancelTool as ActionHandler<never>,
	RespondToInteraction: handleRespondToInteraction as ActionHandler<never>,
};
