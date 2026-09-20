/**
 * The commands the host answers itself, run for the window that asked.
 *
 * A command reaches here only when `desktop-commands.ts` lists it, so the
 * catalogue a window draws and the set this dispatch answers are the same
 * declarations. A handler either answers the request or fails it; throwing is
 * how it reports a failure the caller should state as one.
 */
import type { AgentSession } from "../../session/agent-session";
import type { DesktopHostCommandName } from "../desktop-commands";
import { answerSideQuestion } from "../side-question";
import type { ActionContext } from "./types";

type HostCommand = (ctx: ActionContext, session: AgentSession, args: string) => Promise<void>;

/**
 * `/btw`: a question answered from the session's context, beside the work.
 *
 * The answer is awaited, so the request completes when the answer is whole.
 * A window that drew a spinner for the request stops it on the reply rather
 * than guessing when the streamed entry stopped growing.
 */
const btw: HostCommand = async (ctx, session, args) => {
	const question = args.trim();
	if (!question) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "Usage: /btw <question>",
			retryable: false,
		});
		return;
	}
	await answerSideQuestion(ctx.socket, ctx.clientState, session, question);
	ctx.reply.success();
};

const HANDLERS: Record<DesktopHostCommandName, HostCommand> = { btw };

/** Runs `name` against `session`, replying to the request it arrived on. */
export async function runDesktopHostCommand(
	ctx: ActionContext,
	session: AgentSession,
	name: DesktopHostCommandName,
	args: string,
): Promise<void> {
	await HANDLERS[name](ctx, session, args);
}
