/**
 * Where the secrets subsystem tells the operator something it could not tell them by returning.
 *
 * Most of this subsystem reports by throwing or by returning a value the caller renders. A few
 * events fit neither: they happen deep inside a key or vault operation, they are about the state of
 * the operator's machine rather than the call being made, and they must not fail the call. A key
 * directory that was left group-writable and has been tightened is one. A vault still sealed under
 * a superseded binding is another.
 *
 * A REGISTRATION RATHER THAN A PARAMETER because these fire from `pinKeyRoot` and the vault read
 * path, which are reached through `openVault`, `readVaultKey`, `loadOrCreateVaultKey` and every
 * `SecretVault` method. Threading a callback to all of them would put the parameter in a dozen
 * signatures that have no other use for it. Registrations are process-global because the helpers
 * are, but each registration has its own detach token: overlapping SDK sessions must not replace
 * one another or let the first session's disposal detach the second.
 *
 * NEVER PASS A SECRET THROUGH IT. Everything raised here is about paths, modes and formats. A value
 * would end up in whatever surface the host wired the sink to.
 */

export type SecretsNoticeSink = (message: string) => void;

/** Removes exactly one attached sink. Safe to call more than once. */
export type DetachSecretsNoticeSink = () => void;

const attached = new Map<symbol, SecretsNoticeSink>();

/**
 * Attach one host notice surface and return its registration-token-bound detach handle.
 *
 * Callers own the token for exactly as long as their surface is live. Every call gets a distinct
 * token even when the same function object is registered twice, so concurrent sessions all hear
 * process-global conditions and disposing one leaves every other registration intact.
 */
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
