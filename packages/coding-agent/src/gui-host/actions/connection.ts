import { buildCapabilitiesSnapshot } from "../session-bridge";
import { disposeClientState } from "../turns";
import { activeManager, emitActiveSessionAndTranscript, emitSessionList } from "./active-session";
import { agentCommsSection, agentsSection, clientSessionScope, subscribeClientAgents } from "./agents";
import { subscribeClientForeground } from "./foreground";
import { agentPauseSection } from "./pause";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

interface AttachPayload {
	endpoint?: string | null;
}

/**
 * Attach and RetryConnection deliver the state the shell reads on arrival:
 * what the host can do, the sessions in the store, the one that is open (if
 * any) with its transcript, the agents the registry holds, and whether the
 * process is frozen -- a window that attaches into a freeze engaged before
 * it started draws the strip on its first frame rather than on the next
 * pause.
 */
async function emitInitialState(ctx: ActionContext): Promise<void> {
	ctx.reply.snapshot({ Capabilities: buildCapabilitiesSnapshot(ctx.clientState.agentSession?.settings) });
	await emitSessionList(ctx);
	const sm = activeManager(ctx);
	if (sm) emitActiveSessionAndTranscript(ctx, sm);
	const scope = clientSessionScope(ctx.clientState);
	ctx.reply.snapshot({ Agents: agentsSection(scope) });
	ctx.reply.snapshot({ AgentComms: agentCommsSection(scope) });
	ctx.reply.snapshot({ AgentPause: agentPauseSection() });
}

const handleAttach: ActionHandler<AttachPayload | undefined> = async (ctx, _payload) => {
	subscribeClientAgents(ctx.socket, ctx.clientState);
	subscribeClientForeground(ctx.socket, ctx.clientState);
	await emitInitialState(ctx);
	ctx.reply.success();
};

const handleDetach: ActionHandler = async ctx => {
	await disposeClientState(ctx.clientState);
	ctx.clientState.sessionManager = undefined;
	ctx.reply.success();
};

const handleRetryConnection: ActionHandler = async ctx => {
	subscribeClientAgents(ctx.socket, ctx.clientState);
	subscribeClientForeground(ctx.socket, ctx.clientState);
	await emitInitialState(ctx);
	ctx.reply.success();
};

/** The server closes after this reply; see `GuiHostServer.#dispatchAction`. */
const handleShutdown: ActionHandler = ctx => {
	ctx.reply.success();
};

export const connectionActionHandlers: ActionHandlersMap = {
	Attach: handleAttach as ActionHandler<never>,
	Detach: handleDetach as ActionHandler<never>,
	RetryConnection: handleRetryConnection as ActionHandler<never>,
	Shutdown: handleShutdown as ActionHandler<never>,
};
