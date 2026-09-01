import type { AuthCredentialSnapshotEntry, StoredCredentialBlock } from "../auth-storage";
import type { Provider } from "../types";
import type { UsageReport } from "../usage";
import type { AuthBrokerClient } from "./client";
import type { CredentialBlockSnapshot, SnapshotEntry, SnapshotResponse } from "./types";

export const USAGE_CACHE_TTL_MS = 15_000;
export const CREDENTIAL_BLOCK_RECONCILE_DELAY_MS = 5 * 60_000;
export const WAIT_THRESHOLD_MS = 1_000;
export const MAX_WAIT_MS = 5_000;
export const BACKGROUND_WAIT_MS = 30_000;
export const BACKGROUND_BACKOFF_INITIAL_MS = 500;
export const BACKGROUND_BACKOFF_MAX_MS = 30_000;

export function compareCredentialBlockSnapshots(a: CredentialBlockSnapshot, b: CredentialBlockSnapshot): number {
	const provider = a.providerKey.localeCompare(b.providerKey);
	if (provider !== 0) return provider;
	const scope = a.blockScope.localeCompare(b.blockScope);
	if (scope !== 0) return scope;
	const blockedUntil = a.blockedUntilMs - b.blockedUntilMs;
	if (blockedUntil !== 0) return blockedUntil;
	return (a.updatedAtMs ?? 0) - (b.updatedAtMs ?? 0);
}

export function toCredentialBlockSnapshot(block: StoredCredentialBlock): CredentialBlockSnapshot {
	return {
		providerKey: block.providerKey,
		blockScope: block.blockScope,
		blockedUntilMs: block.blockedUntilMs,
		...(block.updatedAtMs !== undefined ? { updatedAtMs: block.updatedAtMs } : {}),
	};
}

export function credentialBlockSnapshotsEqual(
	left: readonly CredentialBlockSnapshot[] | undefined,
	right: readonly CredentialBlockSnapshot[] | undefined,
): boolean {
	const leftBlocks = left ?? [];
	const rightBlocks = right ?? [];
	if (leftBlocks.length !== rightBlocks.length) return false;
	for (let index = 0; index < leftBlocks.length; index += 1) {
		const leftBlock = leftBlocks[index]!;
		const rightBlock = rightBlocks[index]!;
		if (
			leftBlock.providerKey !== rightBlock.providerKey ||
			leftBlock.blockScope !== rightBlock.blockScope ||
			leftBlock.blockedUntilMs !== rightBlock.blockedUntilMs ||
			leftBlock.updatedAtMs !== rightBlock.updatedAtMs
		) {
			return false;
		}
	}
	return true;
}

export function snapshotBlocksChanged(previous: readonly SnapshotEntry[], next: readonly SnapshotEntry[]): boolean {
	const previousBlocksById = new Map<number, readonly CredentialBlockSnapshot[] | undefined>();
	for (const entry of previous) previousBlocksById.set(entry.id, entry.blocks);
	for (const entry of next) {
		const previousBlocks = previousBlocksById.get(entry.id);
		if (!credentialBlockSnapshotsEqual(previousBlocks, entry.blocks)) return true;
		previousBlocksById.delete(entry.id);
	}
	for (const previousBlocks of previousBlocksById.values()) {
		if (previousBlocks && previousBlocks.length > 0) return true;
	}
	return false;
}

export function credentialEntryWithBlocks(
	entry: AuthCredentialSnapshotEntry,
	blocks: readonly CredentialBlockSnapshot[] | undefined,
): SnapshotEntry {
	const incoming: SnapshotEntry = { ...entry, rotatesInMs: null };
	if (blocks && blocks.length > 0) incoming.blocks = blocks.slice().sort(compareCredentialBlockSnapshots);
	return incoming;
}

export function emptySnapshot(): SnapshotResponse {
	return {
		generation: 0,
		generatedAt: 0,
		serverNowMs: 0,
		refresher: {
			enabled: false,
			intervalMs: 0,
			skewMs: 0,
			nextSweepInMs: Number.MAX_SAFE_INTEGER,
		},
		credentials: [],
	};
}

export interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

export interface UsageCacheEntry {
	reports: UsageReport[] | null;
	fetchedAt: number;
}

export function usageOverlayKey(
	provider: Provider,
	ids: { accountId?: string; email?: string; projectId?: string; orgId?: string },
): string | undefined {
	let base: string | undefined;
	const accountId = ids.accountId?.trim().toLowerCase();
	const email = ids.email?.trim().toLowerCase();
	const projectId = ids.projectId?.trim().toLowerCase();
	if (accountId) base = `account:${accountId}`;
	else if (email) base = `email:${email}`;
	else if (projectId) base = `project:${projectId}`;
	const orgId = ids.orgId?.trim().toLowerCase();
	if (orgId) return base ? `${provider}\0org:${orgId}|${base}` : `${provider}\0org:${orgId}`;
	if (base) return `${provider}\0${base}`;
	return undefined;
}

export function mergeUsageReports(base: UsageReport, overlay: UsageReport): UsageReport {
	const overlayLimitsById = new Map(overlay.limits.map(limit => [limit.id, limit]));
	const limits = [];
	for (const limit of base.limits) {
		const replacement = overlayLimitsById.get(limit.id);
		if (replacement) {
			limits.push(replacement);
			overlayLimitsById.delete(limit.id);
		} else {
			limits.push(limit);
		}
	}
	for (const limit of overlayLimitsById.values()) limits.push(limit);
	const overlayMetadata = (overlay.metadata ?? {}) as Record<string, unknown>;
	return {
		...base,
		fetchedAt: Math.max(base.fetchedAt, overlay.fetchedAt),
		limits,
		metadata: {
			...overlayMetadata,
			...(base.metadata ?? {}),
			...(overlayMetadata.headersUpdatedAt !== undefined
				? { headersUpdatedAt: overlayMetadata.headersUpdatedAt }
				: {}),
		},
	};
}

export interface RemoteAuthCredentialStoreOptions {
	client: AuthBrokerClient;
	initialSnapshot?: SnapshotResponse;
	streamSnapshots?: boolean;
	onSnapshot?: (snapshot: SnapshotResponse, generation: number) => void;
}
