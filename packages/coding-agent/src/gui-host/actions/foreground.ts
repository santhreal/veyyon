/**
 * The command a window's session is waiting on, and the request that moves it
 * to a background job.
 *
 * The behaviour is the bash tool's own: a foreground wait registers a resolver
 * in `tools/shell/bash-foreground-registry`, and resolving it converts the
 * running command to a background job with `reason: "manual"`. The terminal
 * reaches that resolver with a keystroke; a window reaches it with
 * `BackgroundCommand`. Neither host re-implements it, and the registry keys
 * each wait by the session its command runs in, so one window's request cannot
 * move another window's command.
 *
 * The section is what makes the control appear: it is published when a wait
 * for this window's session opens and when it settles, so the control is drawn
 * only while it would do something.
 */
import type * as net from "node:net";
import { logger } from "@veyyon/utils";
import { onForegroundBashWaitChange, requestManualBackground } from "../../tools/shell/bash-foreground-registry";
import { foregroundSection } from "../foreground-view";
import { writeFrame } from "../frames";
import type { ClientSessionState } from "../turns";
import type { SnapshotSection } from "../wire";
import { activeManager } from "./active-session";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

/** The session this client is on, or `undefined` before it opens one. */
function clientSession(state: ClientSessionState): string | undefined {
	return (state.sessionManager ?? state.agentSession?.sessionManager)?.getSessionId() ?? undefined;
}

/**
 * Publish this client's foreground command whenever a wait in its session
 * opens or settles. Installed once per connection; the returned teardown runs
 * when the window closes.
 */
export function subscribeClientForeground(socket: net.Socket, state: ClientSessionState): void {
	if (state.closed || socket.destroyed) return;
	if (state.unsubscribeForeground) return;

	const unsubscribe = onForegroundBashWaitChange(changed => {
		if (state.closed || socket.destroyed) return;
		const session = clientSession(state);
		if (session === undefined || changed !== session) return;
		const section: SnapshotSection = {
			ForegroundCommand: { session, command: foregroundSection(session) },
		};
		writeFrame(socket, { Snapshot: section });
	});

	state.unsubscribeForeground = unsubscribe;
}

interface SessionRef {
	session?: string;
}

/**
 * Move the command this session is waiting on to a background job.
 *
 * A session waiting on nothing is refused rather than answered silently: the
 * control is drawn from the section, so a request arriving with no wait behind
 * it means the window acted on a state that has already settled, and the
 * refusal states the condition it acted on.
 */
const handleBackgroundCommand: ActionHandler<SessionRef | undefined> = (ctx: ActionContext, _payload) => {
	const manager = activeManager(ctx);
	const session = manager?.getSessionId();
	if (!session) {
		ctx.reply.failure({
			scope: "Session",
			code: "NO_SESSION",
			message: "This window holds no session. Open one, then run a command to background it.",
			retryable: false,
		});
		return;
	}
	if (!requestManualBackground(session)) {
		ctx.reply.failure({
			scope: "Session",
			code: "NOT_RUNNING",
			message: "No command is running in the foreground. Run one, then background it while it waits.",
			retryable: false,
		});
		return;
	}
	logger.debug("Foreground command moved to a background job", { session });
	ctx.reply.success();
};

export const foregroundActionHandlers: ActionHandlersMap = {
	BackgroundCommand: handleBackgroundCommand as ActionHandler<never>,
};
