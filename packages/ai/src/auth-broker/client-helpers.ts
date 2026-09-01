import type { SnapshotResponse } from "./types";

export interface AuthBrokerClientOptions {
	url: string;
	token: string;
	timeoutMs?: number;
	maxRetries?: number;
	fetchImpl?: typeof fetch;
}

export interface FetchSnapshotOptions {
	ifGenerationGt?: number;
	waitMs?: number;
	signal?: AbortSignal;
}

export type FetchSnapshotResult =
	| { status: 200; snapshot: SnapshotResponse; generation: number }
	| { status: 304; generation: number };

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RETRIES = 1;
