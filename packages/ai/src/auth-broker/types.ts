import type {
	AuthCredential,
	AuthCredentialSnapshot,
	AuthCredentialSnapshotEntry,
	StoredCredentialBlock,
} from "../auth-storage";
import type { UsageReport } from "../usage";

export interface HealthzResponse {
	ok: boolean;
	version?: string;
}

export interface RefresherSchedule {
	enabled: boolean;
	intervalMs: number;
	skewMs: number;
	nextSweepInMs: number;
}

export type CredentialBlockSnapshot = Omit<StoredCredentialBlock, "credentialId">;

export type SnapshotEntry = AuthCredentialSnapshotEntry & {
	rotatesInMs: number | null;
	blocks?: CredentialBlockSnapshot[];
};

export interface SnapshotResponse extends Omit<AuthCredentialSnapshot, "credentials"> {
	serverNowMs: number;
	refresher: RefresherSchedule;
	credentials: SnapshotEntry[];
}

export interface UsageResponse {
	generatedAt: number;
	reports: UsageReport[];
}

export interface CredentialRefreshResponse {
	entry: AuthCredentialSnapshotEntry;
}

export interface CredentialDisableRequest {
	cause: string;
}

export interface CredentialDisableResponse {
	ok: boolean;
}

export type CredentialBlockRequest = CredentialBlockSnapshot;

export interface CredentialBlockResponse {
	ok: boolean;
}

export interface CredentialBlocksDeleteResponse {
	ok: boolean;
}

export interface UsageStaleResponse {
	ok: boolean;
}

export interface CredentialUploadRequest {
	provider: string;
	credential: AuthCredential;
}

export interface CredentialUploadResponse {
	entries: AuthCredentialSnapshotEntry[];
}

export type SnapshotStreamEventKind = "snapshot" | "entry" | "removed";

export interface SnapshotStreamSnapshotEvent extends SnapshotResponse {
	kind: "snapshot";
}

export interface SnapshotStreamEntryEvent {
	kind: "entry";
	generation: number;
	serverNowMs: number;
	refresher: RefresherSchedule;
	entry: SnapshotEntry;
}

export interface SnapshotStreamRemovedEvent {
	kind: "removed";
	generation: number;
	serverNowMs: number;
	refresher: RefresherSchedule;
	id: number;
}

export type SnapshotStreamEvent = SnapshotStreamSnapshotEvent | SnapshotStreamEntryEvent | SnapshotStreamRemovedEvent;

export const DEFAULT_AUTH_BROKER_BIND = "127.0.0.1:8765";

export const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;

export const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

export const DEFAULT_SNAPSHOT_CACHE_TTL_MS = 60 * 60_000;

export const DEFAULT_STREAM_KEEPALIVE_MS = 20_000;

export const DEFAULT_SERVER_IDLE_TIMEOUT_S = 255;
