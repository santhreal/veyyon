import { errorMessage, logger } from "@veyyon/utils";

/** The part of a session this module needs. Structural rather than the concrete `AgentSession`, because the callers that abort without awaiting hold different things: the interactive input */
export interface DetachedAbortTarget {
	abort(options?: { reason?: string }): Promise<unknown> | undefined;
}

/** Abort a session without awaiting the result, and handle the rejection. `void session.abort(...)` is NOT this. `void` discards the value and silences the */
export function abortDetached(session: DetachedAbortTarget, where: string, reason?: string): void {
	const warn = (error: unknown): void => {
		logger.warn("Detached session abort failed", { where, error: errorMessage(error) });
	};
	try {
		void session.abort(reason === undefined ? undefined : { reason })?.catch(warn);
	} catch (error) {
		warn(error);
	}
}
