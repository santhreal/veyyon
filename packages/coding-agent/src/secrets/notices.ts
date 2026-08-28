/** Where the secrets subsystem tells the operator something it could not tell them by returning. Most of this subsystem reports by throwing or by returning a value the caller renders. A few */

/** Notice `source` a secret-spend line carries. A spend is not a machine condition like the two above, so it does not go through */
export const SECRET_SPEND_NOTICE_SOURCE = "secret-spend";

export type SecretsNoticeSink = (message: string) => void;

/** Removes exactly one attached sink. Safe to call more than once. */
export type DetachSecretsNoticeSink = () => void;

const attached = new Map<symbol, SecretsNoticeSink>();

/** Attach one host notice surface and return its registration-token-bound detach handle. Callers own the token for exactly as long as their surface is live. Every call gets a distinct */
export function attachSecretsNoticeSink(sink: SecretsNoticeSink): DetachSecretsNoticeSink {
	const token = Symbol("secrets notice sink");
	attached.set(token, sink);
	let detached = false;
	return () => {
		if (detached) return;
		detached = true;
		attached.delete(token);
	};
}

/** Raise an operator notice, if a surface exists. A broken surface cannot fail the vault operation. */
export function noteSecretsCondition(message: string): void {
	for (const sink of attached.values()) {
		try {
			sink(message);
		} catch {
			// A notice is diagnostic; another session's broken renderer must not block delivery or I/O.
		}
	}
}
