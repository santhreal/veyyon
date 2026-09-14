import { errorMessage, logger } from "@veyyon/utils";
import type { AgentSession } from "../session/agent-session";
import { generateSessionTitle } from "../utils/title-generator";
import { emitActiveSession, emitSessionList } from "./actions/active-session";
import type { ActionContext } from "./actions/types";

/**
 * Name a session from the first prompt sent to it, and state the new name to
 * the client that sent that prompt.
 *
 * The rail lists a session by its title, so a session that is never named is
 * listed as "new session" for as long as it exists, and a window holding
 * several of them lists them all under that one name. The terminal names its
 * sessions from the first prompt through the same generator; this is the same
 * step on the prompt path the desktop uses.
 *
 * `generateSessionTitle` decides on its own whether to invoke a model at all:
 * it returns `null` for an empty or low-signal prompt and when auto-titling is
 * off, so a greeting leaves the session unnamed and the next prompt tries
 * again.
 */
export async function nameSessionFromFirstPrompt(
	ctx: ActionContext,
	session: AgentSession,
	prompt: string,
): Promise<void> {
	const manager = session.sessionManager;
	if (manager.getSessionName()) return;
	const sessionId = manager.getSessionId();
	try {
		const title = await generateSessionTitle(
			prompt,
			session.modelRegistry,
			session.settings,
			sessionId,
			session.model,
			provider => session.agent.metadataForProvider(provider),
			session.titleSystemPrompt,
			text => session.obfuscateProviderText(text),
			session.sideComplete,
		);
		if (!title) return;
		// The session may have been renamed, replaced or switched away from while
		// the title was being generated. A name written past any of those lands on
		// another session or overwrites what the operator chose.
		if (manager.getSessionId() !== sessionId || manager.getSessionName()) return;
		if (!(await session.setSessionName(title, "auto"))) return;
		if (ctx.socket.destroyed) return;
		if (ctx.clientState.agentSession === session) emitActiveSession(ctx, manager);
		await emitSessionList(ctx);
	} catch (error) {
		logger.warn("gui-host: naming a session from its first prompt failed", {
			sessionId,
			error: errorMessage(error),
		});
	}
}
