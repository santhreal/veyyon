/**
 * The top-level sessions of this process that have not begun disposal, and the order a session's
 * disposal runs in.
 *
 * Several run at once: a conversation `/new` left running in the background, the one on screen,
 * and every session an ACP client opened. The process-wide agent lifecycle and the shared worker
 * subprocesses (tiny title model, memory embeddings) serve all of them, so only the disposal of
 * the last one releases them. An earlier disposal ends its own conversation and leaves them to
 * the sessions still running.
 */

import { shutdownMnemopiEmbedClient } from "../memory/mnemopi/embed-client";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { shutdownTinyTitleClient } from "../tiny/title-client";
import { type AgentSession, RESCOPE_TERMINATE_REASON } from "./agent-session";

const live = new Set<object>();

export function enterTopLevelSession(session: object): void {
	live.add(session);
}

/**
 * Remove `session`. Returns true when it was live and no other top-level session is, so the
 * caller releases the process-wide resources. Synchronous, so two disposals that overlap still
 * agree on which one is last.
 */
export function leaveTopLevelSession(session: object): boolean {
	return live.delete(session) && live.size === 0;
}

/** How many top-level sessions have not begun disposal. */
export function liveTopLevelSessionCount(): number {
	return live.size;
}

/**
 * Replace `session.dispose` with one that runs once, however many callers await it, in this order:
 * reject new session work, end the agents the session spawned (the whole global lifecycle when it is
 * the last top-level session), dispose the session, shut down the process-wide worker subprocesses
 * when it was the last, then `finalize`, which runs whether or not an earlier step threw.
 *
 * A spawned agent (`topLevel` false) never enters the live set and never touches the global
 * lifecycle or the worker subprocesses.
 */
export function orderSessionDisposal(
	session: AgentSession,
	disposal: { readonly topLevel: boolean; readonly finalize: () => Promise<void> },
): void {
	const originalDispose = session.dispose.bind(session);
	let disposeCall: Promise<void> | undefined;
	if (disposal.topLevel) enterTopLevelSession(session);
	session.dispose = options => {
		if (disposeCall) return disposeCall;
		// Decided before the first await, so overlapping disposals of two top-level sessions agree on
		// which one is last.
		const lastTopLevel = disposal.topLevel && leaveTopLevelSession(session);
		disposeCall = (async () => {
			try {
				// Reject new session work (eval starts) the moment disposal begins: the lifecycle await
				// below opens an async gap before AgentSession.dispose() would otherwise set its guards.
				session.beginDispose();
				if (lastTopLevel) {
					// The last top-level teardown ends the global agent lifecycle: park timers, adopted
					// spawned agent sessions, revivers. It runs while shared resources (kernels, MCP, LSP)
					// are still live.
					await AgentLifecycleManager.global().dispose();
				} else if (disposal.topLevel) {
					// Another top-level conversation still runs on the global lifecycle, so end only the
					// agents this one spawned.
					await session.terminateSpawnedAgents(RESCOPE_TERMINATE_REASON);
				}
				await originalDispose(options);
				if (lastTopLevel) {
					// Process-wide worker subprocesses, shut down after the session's own memory
					// consolidation, which may still embed (issue #3031).
					await shutdownTinyTitleClient();
					await shutdownMnemopiEmbedClient();
				}
			} finally {
				await disposal.finalize();
			}
		})();
		return disposeCall;
	};
}
