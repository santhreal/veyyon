import { requestsPrompts } from "../../prompts/requests/rows";
import { UnsupportedModelInputError } from "../../session/agent-session";
import { ImageInputTooLargeError } from "../../utils/image-loading";
import { VideoInputTooLargeError } from "../../utils/video-loading";
import { backgroundSession } from "../background-sessions";
import { writeFrame } from "../frames";
import { reportQueuedPrompts } from "../queued-prompts";
import { nameSessionFromFirstPrompt } from "../session-title";
import {
	AttachmentValidationError,
	abortTurn,
	executePromptTurn,
	getOrCreateAgentSession,
	type LiveTurn,
} from "../turns";
import type { AttachmentSubmission } from "../wire";
import { activateSession, activeManager, isActive, replyError, startingWork } from "./active-session";
import { recordSubmittedPrompt } from "./history";
import { handleSetSessionMode } from "./session-mode";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

/** The instruction `/rephrase` submits, shared with the terminal host. */
const REPHRASE_REQUEST = requestsPrompts["requests/rephrase"].text.trim();

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
 *
 * `names` is false for a turn whose text the operator did not write: a fixed
 * instruction titles the session after the instruction rather than after the
 * work, and a session that stayed unnamed through its first turn is still
 * waiting for a prompt worth naming it from.
 */
async function deliver(
	ctx: ActionContext,
	payload: PromptPayload | undefined,
	action: string,
	behavior: "Steer" | "Queue" | undefined,
	names = true,
): Promise<void> {
	const text = payload?.text?.trim();
	const target = payload?.session;
	if (!target || !text) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: `${action} requires session and text`,
			retryable: false,
		});
		return;
	}
	const submitted = payload?.attachments;
	const attachments = Array.isArray(submitted) ? submitted : [];
	const streaming = behavior === "Steer" ? "steer" : behavior === "Queue" ? "followUp" : undefined;
	// The prompt is work on its way to starting until its turn has started, so
	// a leave sent right behind it leaves the turn running rather than the
	// thread it has yet to start on.
	await startingWork(ctx, target, async begun => {
		try {
			if (!(await activateSession(ctx, target))) return;
			const session = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
			if (session.isStreaming && !streaming) {
				ctx.reply.failure({
					scope: "Session",
					code: "TURN_IN_PROGRESS",
					message: "A turn is running; set a queue mode or use Steer / FollowUp",
					retryable: true,
				});
				return;
			}
			// On an idle session a steer or follow-up is the next turn; the
			// session only queues when one is running. The turn is under way
			// once the session holds its promise, which it does on the call.
			const accepted = executePromptTurn(session, ctx.clientState, text, attachments, streaming);
			begun();
			await accepted;
			reportQueuedPrompts(ctx.socket, ctx.clientState);
			ctx.reply.success();
			// Both after the reply: the prompt is accepted either way, the title
			// takes a model call of its own, and the history row is a disk write.
			// The name reaches the client as a snapshot of its own, the way a
			// rename does. Both are held to `names`, which states the text was
			// typed: a fixed instruction is neither worth a title nor worth
			// recalling.
			if (names) {
				void nameSessionFromFirstPrompt(ctx, session, text);
				recordSubmittedPrompt(text, target);
			}
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
	});
}

const handleSubmitPrompt: ActionHandler<PromptPayload | undefined> = (ctx, payload) =>
	deliver(ctx, payload, "SubmitPrompt", ctx.clientState.queueMode);

const handleSteer: ActionHandler<PromptPayload | undefined> = (ctx, payload) => deliver(ctx, payload, "Steer", "Steer");

const handleFollowUp: ActionHandler<PromptPayload | undefined> = (ctx, payload) =>
	deliver(ctx, payload, "FollowUp", "Queue");

interface SessionRef {
	session?: string;
}

/**
 * Where the turn `session` names runs: a session working in the background,
 * stopped or answered by its own id from its row or its announcement without
 * being opened, or the open session. `undefined` for a session that is
 * neither: it has no turn and no decision, and the open session must not
 * stand in for it, or a stop or an answer meant for a thread that just went
 * idle would land on the one on screen.
 */
function turnNamed(ctx: ActionContext, session: string | undefined): LiveTurn | undefined {
	const background = session ? backgroundSession(ctx.clientState, session) : undefined;
	if (background) return background;
	if (!session || isActive(activeManager(ctx), session)) return ctx.clientState;
	return undefined;
}

const handleAbortTurn: ActionHandler<SessionRef | undefined> = async (ctx, payload) => {
	const live = turnNamed(ctx, payload?.session);
	if (!live?.agentSession?.isStreaming) {
		ctx.reply.failure({
			scope: "Session",
			code: "NOT_RUNNING",
			message: "No turn is in flight to abort",
			retryable: false,
		});
		return;
	}
	try {
		await abortTurn(live);
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "ABORT_FAILED", error);
	}
};

/**
 * Re-run the last turn after it ended in an error or an abort. The session
 * drops the failed assistant message and continues with a fresh retry budget,
 * so the transcript carries one attempt, not two. A session in which no turn
 * has run has nothing to re-run and is refused for the same reason.
 */
async function retryTurn(ctx: ActionContext, payload: SessionRef | undefined): Promise<void> {
	if (payload?.session && !(await activateSession(ctx, payload.session))) return;
	const session = ctx.clientState.agentSession;
	if (!session) {
		ctx.reply.failure({
			scope: "Session",
			code: "NOTHING_TO_RETRY",
			message: "No turn has run in this session, so there is nothing to retry",
			retryable: false,
		});
		return;
	}
	try {
		if (!(await session.retry())) {
			ctx.reply.failure({
				scope: "Session",
				code: "NOTHING_TO_RETRY",
				message: "The last turn did not fail, so there is nothing to retry",
				retryable: false,
			});
			return;
		}
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "PROMPT_REJECTED", error);
	}
}

/** The retry is under way once the session has scheduled it, which is when it answers. */
const handleRetryTurn: ActionHandler<SessionRef | undefined> = (ctx, payload) =>
	startingWork(ctx, payload?.session, () => retryTurn(ctx, payload));

/**
 * Ask for the reply on screen again, in plainer prose. It is an ordinary user
 * turn carrying a fixed instruction, so the transcript shows what the model was
 * asked and the answer lands in the conversation rather than beside it. It
 * refuses unless a finished reply is there to work from: mid-turn, or after a
 * turn that produced no text, there is nothing to say again.
 */
async function rephraseReply(ctx: ActionContext, payload: SessionRef | undefined): Promise<void> {
	if (payload?.session && !(await activateSession(ctx, payload.session))) return;
	const session = ctx.clientState.agentSession;
	if (!session?.hasTerminalTextAnswerWithoutQueuedWork()) {
		ctx.reply.failure({
			scope: "Session",
			code: "NOTHING_TO_REPHRASE",
			message: "Rephrase needs a finished reply to work from",
			retryable: false,
		});
		return;
	}
	await deliver(ctx, { session: payload?.session, text: REPHRASE_REQUEST }, "RephraseReply", undefined, false);
}

const handleRephraseReply: ActionHandler<SessionRef | undefined> = (ctx, payload) =>
	startingWork(ctx, payload?.session, () => rephraseReply(ctx, payload));

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
		await abortTurn(ctx.clientState);
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
	// Each session numbers its own decisions, so an id alone can name one on
	// another thread: the answer goes to the session that raised it.
	const live = turnNamed(ctx, payload.session);
	const rejection = live?.interactions
		? live.interactions.answer(payload.interaction_id, payload.response)
		: {
				code: "INTERACTION_NOT_FOUND",
				message: live
					? "No session is attached, so nothing is waiting on an answer"
					: `Session '${payload.session}' is waiting on no answer`,
			};
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
	RetryTurn: handleRetryTurn as ActionHandler<never>,
	RephraseReply: handleRephraseReply as ActionHandler<never>,
	SetQueueMode: handleSetQueueMode as ActionHandler<never>,
	SetSessionMode: handleSetSessionMode as ActionHandler<never>,
	DequeueQueuedPrompt: handleDequeueQueuedPrompt as ActionHandler<never>,
	CancelTool: handleCancelTool as ActionHandler<never>,
	SetToolViewExpanded: handleSetToolViewExpanded as ActionHandler<never>,
	RespondToInteraction: handleRespondToInteraction as ActionHandler<never>,
};
