import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage, getModelDbPath, HOUR_MS } from "@veyyon/utils";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import type { DiscoveryFailure, DiscoveryHooks } from "./discovery/failure";
import type { ModelsDevFallback } from "./model-manager";
import { MODELS_DEV_PROVIDER_DESCRIPTORS, mapModelsDevToModels } from "./provider-models/openai-compat";
import type { Api, ModelSpec } from "./types";
import { isRecord } from "./utils";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const PAYLOAD_TTL_MS = 2 * HOUR_MS;

interface PayloadCache {
	fetchedAt: number;
	etag?: string;
	payload: unknown;
}

let memoryCache: PayloadCache | null = null;
let inflight: Promise<unknown> | null = null;

function payloadCachePath(dbPath?: string): string {
	return path.join(path.dirname(dbPath ?? getModelDbPath()), "models-dev.json");
}

async function readDiskCache(dbPath?: string): Promise<PayloadCache | null> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(payloadCachePath(dbPath), "utf8"));
		if (!isRecord(parsed) || typeof parsed.fetchedAt !== "number" || parsed.payload === undefined) return null;
		return {
			fetchedAt: parsed.fetchedAt,
			etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
			payload: parsed.payload,
		};
	} catch {
		return null;
	}
}

async function writeDiskCache(cache: PayloadCache, dbPath?: string): Promise<void> {
	try {
		await fs.writeFile(payloadCachePath(dbPath), JSON.stringify(cache));
	} catch {
		// The disk cache is an optimization across restarts; the in-process
		// memo still prevents refetch storms within this process.
	}
}

function report(hooks: DiscoveryHooks | undefined, stage: DiscoveryFailure["stage"], detail: string): void {
	hooks?.onFailure?.({ stage, url: MODELS_DEV_API_URL, detail });
}

let failureBackoffUntil = 0;
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;

export function resetModelsDevOverlayState(): void {
	memoryCache = null;
	inflight = null;
	failureBackoffUntil = 0;
}

async function fetchPayload(hooks?: DiscoveryHooks, dbPath?: string): Promise<unknown> {
	const now = Date.now();
	if (memoryCache && now - memoryCache.fetchedAt < PAYLOAD_TTL_MS) return memoryCache.payload;
	if (now < failureBackoffUntil) return memoryCache?.payload ?? null;
	if (inflight) return inflight;
	inflight = fetchPayloadUncached(hooks, dbPath).finally(() => {
		inflight = null;
	});
	return inflight;
}

async function fetchPayloadUncached(hooks?: DiscoveryHooks, dbPath?: string): Promise<unknown> {
	const now = Date.now();
	if (memoryCache && now - memoryCache.fetchedAt < PAYLOAD_TTL_MS) return memoryCache.payload;
	const disk = memoryCache ?? (await readDiskCache(dbPath));
	if (disk && now - disk.fetchedAt < PAYLOAD_TTL_MS) {
		memoryCache = disk;
		return disk.payload;
	}

	const timeout = scopedTimeoutSignal(15_000);
	try {
		let response: Response;
		try {
			response = await fetch(MODELS_DEV_API_URL, {
				method: "GET",
				headers: {
					Accept: "application/json",
					...(disk?.etag ? { "If-None-Match": disk.etag } : {}),
				},
				signal: timeout.signal,
			});
		} catch (error) {
			report(hooks, "request", errorMessage(error));
			if (disk) memoryCache = disk;
			failureBackoffUntil = Date.now() + FAILURE_BACKOFF_MS;
			return disk?.payload ?? null;
		}
		if (response.status === 304 && disk) {
			const renewed = { ...disk, fetchedAt: now };
			memoryCache = renewed;
			void writeDiskCache(renewed, dbPath);
			return disk.payload;
		}
		if (!response.ok) {
			report(hooks, "status", `HTTP ${response.status} ${response.statusText}`.trim());
			if (disk) memoryCache = disk;
			failureBackoffUntil = Date.now() + FAILURE_BACKOFF_MS;
			return disk?.payload ?? null;
		}
		try {
			const payload: unknown = await response.json();
			const etag = response.headers.get("etag") ?? undefined;
			const fresh: PayloadCache = { fetchedAt: now, etag, payload };
			memoryCache = fresh;
			void writeDiskCache(fresh, dbPath);
			return payload;
		} catch (error) {
			report(hooks, "body", errorMessage(error));
			if (disk) memoryCache = disk;
			failureBackoffUntil = Date.now() + FAILURE_BACKOFF_MS;
			return disk?.payload ?? null;
		}
	} finally {
		timeout.cancel();
	}
}

export function defaultModelsDevFallback<TApi extends Api = Api>(
	providerId: string,
	dbPath?: string,
): ModelsDevFallback<TApi> | undefined {
	const descriptors = MODELS_DEV_PROVIDER_DESCRIPTORS.filter(descriptor => descriptor.providerId === providerId);
	if (descriptors.length === 0) return undefined;
	return {
		enrichOnly: descriptors.some(descriptor => descriptor.enrichOnly === true),
		fetch: () => fetchPayload(undefined, dbPath),
		map: payload => {
			if (!isRecord(payload)) return [];
			return mapModelsDevToModels(payload as Record<string, unknown>, descriptors) as ModelSpec<TApi>[];
		},
	};
}
