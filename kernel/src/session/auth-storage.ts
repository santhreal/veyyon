/**
 * Re-exports from `@veyyon/ai/auth-storage`, the module that defines them.
 *
 * NOT from the `@veyyon/ai` barrel, which is 345 modules against that module's 213. 149 test files
 * import this shim, so naming the barrel here bought the streaming engine, every provider transport and
 * the model registry for a credential type. The names are identical either way; only the graph changes.
 */

export type { SnapshotResponse } from "@veyyon/ai/auth-broker/types";
export type {
	ApiKeyCredential,
	AuthCredential,
	AuthCredentialEntry,
	AuthCredentialStore,
	AuthStorageData,
	AuthStorageOptions,
	CredentialOrigin,
	CredentialOriginKind,
	OAuthAccountIdentity,
	OAuthCredential,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	SerializedAuthStorage,
	StoredAuthCredential,
} from "@veyyon/ai/auth-storage";
export { AuthStorage, REMOTE_REFRESH_SENTINEL } from "@veyyon/ai/auth-storage";
// The sqlite store from its own module. This shim still costs `auth-storage`'s graph because
// `AuthStorage` lives there and is genuinely the OAuth-side class, but a consumer that wants only
// the store should name `@veyyon/ai/auth-storage-sqlite` (83 modules) rather than this file.
export { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
