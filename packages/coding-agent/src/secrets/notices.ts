/**
 * Where the secrets subsystem tells the operator something it could not tell them by returning.
 *
 * Most of this subsystem reports by throwing or by returning a value the caller renders. A few
 * events fit neither: they happen deep inside a key or vault operation, they are about the state of
 * the operator's machine rather than the call being made, and they must not fail the call. A key
 * directory that was left group-writable and has been tightened is one. A vault still sealed under
 * a superseded binding is another.
 *
 * A SINK RATHER THAN A PARAMETER because these fire from `pinKeyRoot` and the vault read path, which
 * are reached through `openVault`, `readVaultKey`, `loadOrCreateVaultKey` and every `SecretVault`
 * method. Threading a callback to all of them would put the parameter in a dozen signatures that
 * have no other use for it, to describe an event that happens at most once per process. There is one
 * config root per process, the host sets this once at startup, and `OperatorNotices` already buffers
 * until a surface exists and collapses repeats, so nothing here needs to.
 *
 * NEVER PASS A SECRET THROUGH IT. Everything raised here is about paths, modes and formats. A value
 * would end up in whatever surface the host wired the sink to.
 */

let sink: ((message: string) => void) | undefined;

/** Install the host's notice surface. Called once at startup; pass `undefined` to detach. */
export function setSecretsNoticeSink(notify: ((message: string) => void) | undefined): void {
	sink = notify;
}

/** Raise an operator notice, if a surface exists. Never throws into the caller's operation. */
export function noteSecretsCondition(message: string): void {
	sink?.(message);
}
