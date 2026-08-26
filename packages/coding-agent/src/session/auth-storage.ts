/**
 * Re-exports from `@veyyon/ai/auth-storage`, not the barrel (345 vs 213 modules; 149 test files import this shim).
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
// The sqlite store from its own module (83 modules vs `auth-storage`'s graph, which `AuthStorage` lives in).
export { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
