import { UnsupportedModelInputError } from "../../session/agent-session";
import { ImageInputTooLargeError } from "../../utils/image-loading";
import { VideoInputTooLargeError } from "../../utils/video-loading";
import { writeFrame } from "../frames";
import { reportQueuedPrompts } from "../queued-prompts";
import { nameSessionFromFirstPrompt } from "../session-title";
import { AttachmentValidationError, abortTurn, executePromptTurn, getOrCreateAgentSession } from "../turns";
import type { AttachmentSubmission } from "../wire";
import { activateSession, activeManager, isActive, replyError } from "./active-session";
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
		reportQueuedPrompts(ctx.socket, ctx.clientState);
		ctx.reply.success();
		// After the reply: the prompt is accepted either way, and the title takes
		// a model call of its own. The name reaches the client as a snapshot of
		// its own, the way a rename does.
		void nameSessionFromFirstPrompt(ctx, session, text);
	} catch (error) {
		if (
			error instanceof UnsupportedModelInputError ||
			error instanceof VideoInputTooLargeError ||
			error instanceof ImageInputTooLargeError ||
			error instanceof AttachmentValidationError ||
			(error instanceof Error &&
				(error.name === "UnsupportedModelInputError" ||
					error.name === "AttachmentValidationError" ||
					error.name === "VideoInputTooLargeError" ||
					error.name === "ImageInputTooLargeError"))
		) {
			replyError(ctx, "INVALID_ARGUMENTS", error);
		} else {
			replyError(ctx, "PROMPT_REJECTED", error);
		}
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

interface SetToolViewExpandedPayload {
	session?: string;
	call_id?: string;
	expanded?: boolean;
}

const handleSetToolViewExpanded: ActionHandler<SetToolViewExpandedPayload | undefined> = async (ctx, payload) => {
	if (
		!payload ||
		typeof payload.session !== "string" ||
		typeof payload.call_id !== "string" ||
		typeof payload.expanded !== "boolean"
	) {
		ctx.reply.failure({
			scope: "Tool",
			code: "INVALID_ARGUMENTS",
			message: "SetToolViewExpanded requires session, call_id and expanded boolean",
			retryable: false,
		});
		return;
	}

	const sm = activeManager(ctx);
	if (!isActive(sm, payload.session)) {
		ctx.reply.failure({
			scope: "Tool",
			code: "SESSION_NOT_FOUND",
			message: `Session '${payload.session}' is not active`,
			retryable: false,
		});
		return;
	}

	const ledger = ctx.clientState.presentationLedger;
	if (!ledger?.hasCall(payload.call_id)) {
		ctx.reply.failure({
			scope: "Tool",
			code: "CALL_NOT_FOUND",
			message: `Tool call '${payload.call_id}' not found in session '${payload.session}'`,
			retryable: false,
		});
		return;
	}

	ledger.setDisclosure(payload.call_id, payload.expanded);
	const session = ctx.clientState.agentSession;
	const tracked = ledger.getCall(payload.call_id);

	if (ctx.clientState.streamingAccumulating) {
		const updated = ledger.regenerateCallEntryPresentation(
			ctx.clientState.streamingAccumulating,
			name => session?.getToolByName(name),
			{ partial: true },
		);
		if (updated) {
			ctx.clientState.streamingAccumulating = updated;
			writeFrame(ctx.socket, {
				StreamingChanged: {
					entry: ctx.clientState.streamingEntry ?? "",
					tool: ctx.clientState.streamingTool ?? null,
					accumulating: updated,
					revision: ctx.clientState.revision,
				},
			});
		}
	}

	if (tracked?.assistantEntry) {
		const updatedCallEntry = ledger.regenerateCallEntryPresentation(tracked.assistantEntry, name =>
			session?.getToolByName(name),
		);
		if (updatedCallEntry) {
			tracked.assistantEntry = updatedCallEntry;
			writeFrame(ctx.socket, {
				TranscriptUpdated: {
					revision: ctx.clientState.revision,
					entry: updatedCallEntry,
				},
			});
		}
	}

	if (tracked?.resultEntry) {
		const updatedResultEntry = ledger.regenerateResultEntryPresentation(tracked.resultEntry, name =>
			session?.getToolByName(name),
		);
		if (updatedResultEntry) {
			tracked.resultEntry = updatedResultEntry;
			writeFrame(ctx.socket, {
				TranscriptUpdated: {
					revision: ctx.clientState.revision,
					entry: updatedResultEntry,
				},
			});
		}
	}

	ctx.reply.success();
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

interface DequeueQueuedPromptPayload {
	session?: string;
}

const handleDequeueQueuedPrompt: ActionHandler<DequeueQueuedPromptPayload | undefined> = async (ctx, payload) => {
	if (payload?.session && !(await activateSession(ctx, payload.session))) return;
	const restored = ctx.clientState.agentSession?.popLastQueuedMessage();
	if (!restored) {
		ctx.reply.failure({
			scope: "Session",
			code: "NO_QUEUED_PROMPT",
			message: "There is no queued prompt to take back",
			retryable: false,
		});
		return;
	}
	reportQueuedPrompts(ctx.socket, ctx.clientState, { restored: restored.text });
	ctx.reply.success();
};

export const turnActionHandlers: ActionHandlersMap = {
	SubmitPrompt: handleSubmitPrompt as ActionHandler<never>,
	Steer: handleSteer as ActionHandler<never>,
	FollowUp: handleFollowUp as ActionHandler<never>,
	AbortTurn: handleAbortTurn as ActionHandler<never>,
	SetQueueMode: handleSetQueueMode as ActionHandler<never>,
	DequeueQueuedPrompt: handleDequeueQueuedPrompt as ActionHandler<never>,
	CancelTool: handleCancelTool as ActionHandler<never>,
	SetToolViewExpanded: handleSetToolViewExpanded as ActionHandler<never>,
	RespondToInteraction: handleRespondToInteraction as ActionHandler<never>,
};
