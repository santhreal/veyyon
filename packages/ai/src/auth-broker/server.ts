/**
 * Auth broker HTTP server.
 *
 * Wraps an {@link AuthStorage} (backed by a SQLite store on the broker host)
 * and exposes a minimal REST API for snapshot pulls and explicit refresh /
 * disable operations. Background refresh of expiring credentials lives in
 * {@link AuthBrokerRefresher}.
 *
 * Transport security is delegated to the operator (Tailscale / Wireguard);
 * the server only checks a bearer token against an allow-list per request.
 */
import * as logger from "@veyyon/utils/logger";
import { clampLow } from "@veyyon/utils/math";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { Type } from "arktype";
import type { AuthStorage, StoredCredentialBlock } from "../auth-storage";
import { BearerAllowList, json, resolvePeer } from "../utils/http-server";
import { parseBind } from "../utils/parse-bind";
import { type } from "../utils/schema/arktype";
import { formatGenerationTag, parseGenerationTag } from "./generation-tag";
import { AuthBrokerRefresher, type AuthBrokerRefresherSchedule } from "./refresher";
import type {
	CredentialBlockResponse,
	CredentialBlockSnapshot,
	CredentialBlocksDeleteResponse,
	CredentialDisableResponse,
	CredentialRefreshResponse,
	CredentialUploadResponse,
	HealthzResponse,
	RefresherSchedule,
	SnapshotEntry,
	SnapshotResponse,
	SnapshotStreamEntryEvent,
	SnapshotStreamRemovedEvent,
	SnapshotStreamSnapshotEvent,
} from "./types";
import {
	DEFAULT_AUTH_BROKER_BIND,
	DEFAULT_REFRESH_INTERVAL_MS,
	DEFAULT_REFRESH_SKEW_MS,
	DEFAULT_SERVER_IDLE_TIMEOUT_S,
	DEFAULT_STREAM_KEEPALIVE_MS,
} from "./types";
import { wireSchemas } from "./wire-schemas";

export interface AuthBrokerServerOptions {
	/** Underlying credential storage (wraps the local SQLite store on the broker). */
	storage: AuthStorage;
	/** Listen address; accepts `host:port` or just `port`. */
	bind?: string;
	/** Accept any of these bearer tokens. Empty disables auth (loopback only). */
	bearerTokens: string[];
	/** Broker version string surfaced on `/v1/healthz`. */
	version?: string;
	/** Refresh credentials expiring within this window. Default 5 min. */
	refreshSkewMs?: number;
	/** Background refresh cadence. Default 60s. */
	refreshIntervalMs?: number;
	/** Disable the background refresher (e.g. for tests). */
	disableRefresher?: boolean;
	/**
	 * Override SSE keepalive cadence in milliseconds for `/v1/snapshot/stream`.
	 * Internal-only — tests use a short interval so they can assert heartbeats
	 * without long sleeps. Default {@link DEFAULT_STREAM_KEEPALIVE_MS}.
	 */
	streamKeepaliveMs?: number;
}

export interface AuthBrokerServerHandle {
	/** Bound URL (`http://host:port`). */
	url: string;
	port: number;
	hostname: string;
	close(): Promise<void>;
}

function empty(status: number, headers?: Record<string, string>): Response {
	return new Response(null, { status, headers });
}

/**
 * Parse + validate a JSON request body against an ArkType schema. Returns a
 * `Response` (400) on parse/validation failure so handlers can early-return.
 * When `allowEmpty` is set, an empty request body is validated against `{}`.
 */
async function parseBody<t>(
	req: Request,
	schema: Type<t>,
	options: { allowEmpty?: boolean } = {},
): Promise<{ ok: true; data: typeof schema.infer } | { ok: false; response: Response }> {
	let raw: string;
	try {
		raw = await req.text();
	} catch (error) {
		return { ok: false, response: json(400, { error: `Invalid request body: ${String(error)}` }) };
	}
	if (raw.length === 0 && !options.allowEmpty) {
		return { ok: false, response: json(400, { error: "Request body required" }) };
	}
	let parsed: unknown;
	try {
		parsed = raw.length === 0 ? {} : JSON.parse(raw);
	} catch (error) {
		return { ok: false, response: json(400, { error: `Invalid JSON body: ${String(error)}` }) };
	}
	const result = schema(parsed);
	if (result instanceof type.errors) {
		return { ok: false, response: json(400, { error: result.summary }) };
	}
	return { ok: true, data: result };
}

/** `/v1/credential/:id/<action>`: the row id and the action name. */
const CREDENTIAL_ROUTE = /^\/v1\/credential\/(\d+)\/([a-z]+)$/;

const MAX_SNAPSHOT_WAIT_MS = 30_000;
const DISABLED_NEXT_SWEEP_IN_MS = Number.MAX_SAFE_INTEGER;

function snapshotHeaders(generation: number): Record<string, string> {
	return {
		ETag: formatGenerationTag(generation),
		"Cache-Control": "no-store",
	};
}

function parseWaitMs(url: URL): number {
	const raw = url.searchParams.get("wait");
	if (raw === null) return 0;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return 0;
	return clampLow(Math.trunc(parsed), 0, MAX_SNAPSHOT_WAIT_MS);
}

function delayResult(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
	const done = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => done.resolve("timeout"), ms);
	timer.unref?.();
	return {
		promise: done.promise,
		cancel: () => clearTimeout(timer),
	};
}

class GenerationGate {
	readonly #storage: AuthStorage;
	readonly #unsubscribe: () => void;
	#waiters: Map<number, Set<() => void>> = new Map();

	constructor(storage: AuthStorage) {
		this.#storage = storage;
		this.#unsubscribe = storage.onGenerationChanged(generation => this.#wake(generation));
	}

	waitForChange(afterGeneration: number, signal: AbortSignal): Promise<"changed" | "aborted"> {
		if (this.#storage.getGeneration() !== afterGeneration) return Promise.resolve("changed");
		if (signal.aborted) return Promise.resolve("aborted");

		const done = Promise.withResolvers<"changed" | "aborted">();
		let settled = false;
		const waiters = this.#waiters.get(afterGeneration) ?? new Set<() => void>();
		this.#waiters.set(afterGeneration, waiters);

		const cleanup = (): void => {
			signal.removeEventListener("abort", onAbort);
			waiters.delete(resolveChanged);
			if (waiters.size === 0) this.#waiters.delete(afterGeneration);
		};
		const settle = (result: "changed" | "aborted"): void => {
			if (settled) return;
			settled = true;
			cleanup();
			done.resolve(result);
		};
		const resolveChanged = (): void => settle("changed");
		const onAbort = (): void => settle("aborted");

		waiters.add(resolveChanged);
		signal.addEventListener("abort", onAbort, { once: true });
		return done.promise;
	}

	close(): void {
		this.#unsubscribe();
		for (const waiters of this.#waiters.values()) {
			for (const resolve of waiters) resolve();
		}
		this.#waiters.clear();
	}

	#wake(generation: number): void {
		for (const [waitingFor, waiters] of Array.from(this.#waiters)) {
			if (generation <= waitingFor) continue;
			for (const resolve of Array.from(waiters)) resolve();
		}
	}
}

function resolveRefresherSchedule(
	refresher: AuthBrokerRefresher | undefined,
	serverNowMs: number,
): { wire: RefresherSchedule; nextSweepAt: number } {
	if (!refresher) {
		return {
			wire: {
				enabled: false,
				intervalMs: 0,
				skewMs: 0,
				nextSweepInMs: DISABLED_NEXT_SWEEP_IN_MS,
			},
			nextSweepAt: DISABLED_NEXT_SWEEP_IN_MS,
		};
	}
	const schedule: AuthBrokerRefresherSchedule = refresher.getSchedule();
	return {
		wire: {
			enabled: schedule.enabled,
			intervalMs: schedule.intervalMs,
			skewMs: schedule.skewMs,
			nextSweepInMs: Math.max(0, schedule.nextSweepAt - serverNowMs),
		},
		nextSweepAt: schedule.nextSweepAt,
	};
}

function computeRotatesInMs(
	entry: { credential: { type: string; expires?: number } },
	schedule: RefresherSchedule,
	nextSweepAt: number,
	serverNowMs: number,
): number | null {
	if (!schedule.enabled || entry.credential.type !== "oauth") return null;
	const expires = entry.credential.expires;
	if (typeof expires !== "number" || !Number.isFinite(expires)) return null;
	if (!Number.isFinite(nextSweepAt) || !Number.isFinite(schedule.intervalMs) || schedule.intervalMs <= 0) return null;

	const dueAt = expires - schedule.skewMs;
	const eligibleAt = Math.max(serverNowMs, dueAt);
	if (dueAt <= serverNowMs && nextSweepAt <= serverNowMs) return 0;
	if (nextSweepAt >= eligibleAt) return Math.max(0, nextSweepAt - serverNowMs);
	const steps = Math.ceil((eligibleAt - nextSweepAt) / schedule.intervalMs);
	const rotatesAt = nextSweepAt + steps * schedule.intervalMs;
	return Math.max(0, rotatesAt - serverNowMs);
}

function compareCredentialBlockSnapshots(a: CredentialBlockSnapshot, b: CredentialBlockSnapshot): number {
	const provider = a.providerKey.localeCompare(b.providerKey);
	if (provider !== 0) return provider;
	const scope = a.blockScope.localeCompare(b.blockScope);
	if (scope !== 0) return scope;
	return a.blockedUntilMs - b.blockedUntilMs;
}

function buildCredentialBlockGroups(
	blocks: readonly StoredCredentialBlock[],
	serverNowMs: number,
): Map<number, CredentialBlockSnapshot[]> {
	const byCredentialId = new Map<number, CredentialBlockSnapshot[]>();
	for (const block of blocks) {
		if (block.blockedUntilMs <= serverNowMs) continue;
		const snapshotBlock: CredentialBlockSnapshot = {
			providerKey: block.providerKey,
			blockScope: block.blockScope,
			blockedUntilMs: block.blockedUntilMs,
			updatedAtMs: block.updatedAtMs,
		};
		const existing = byCredentialId.get(block.credentialId);
		if (existing) {
			existing.push(snapshotBlock);
		} else {
			byCredentialId.set(block.credentialId, [snapshotBlock]);
		}
	}
	for (const credentialBlocks of byCredentialId.values()) credentialBlocks.sort(compareCredentialBlockSnapshots);
	return byCredentialId;
}

function buildSnapshot(storage: AuthStorage, refresher: AuthBrokerRefresher | undefined): SnapshotResponse {
	const serverNowMs = Date.now();
	const base = storage.exportSnapshot();
	const { wire, nextSweepAt } = resolveRefresherSchedule(refresher, serverNowMs);
	const credentialIds = base.credentials.map(entry => entry.id);
	const blocksByCredentialId = buildCredentialBlockGroups(storage.listCredentialBlocks(credentialIds), serverNowMs);
	const credentials: SnapshotEntry[] = base.credentials.map(entry => {
		const blocks = blocksByCredentialId.get(entry.id);
		const rotatesInMs = computeRotatesInMs(entry, wire, nextSweepAt, serverNowMs);
		return blocks && blocks.length > 0 ? { ...entry, rotatesInMs, blocks } : { ...entry, rotatesInMs };
	});
	return {
		generation: base.generation,
		generatedAt: base.generatedAt,
		serverNowMs,
		refresher: wire,
		credentials,
	};
}

async function serveSnapshot(
	req: Request,
	url: URL,
	storage: AuthStorage,
	gate: GenerationGate,
	refresher: AuthBrokerRefresher | undefined,
	peer: string,
): Promise<Response> {
	await storage.reload();
	let currentGeneration = storage.getGeneration();
	const clientGeneration = parseGenerationTag(req.headers.get("if-none-match"));
	const waitMs = parseWaitMs(url);

	if (clientGeneration === undefined || currentGeneration !== clientGeneration || waitMs <= 0) {
		const body = buildSnapshot(storage, refresher);
		logger.info("auth-broker snapshot served", {
			peer,
			credentials: body.credentials.length,
			generation: body.generation,
		});
		return json(200, body, snapshotHeaders(body.generation));
	}

	const delay = delayResult(waitMs);
	const waitController = new AbortController();
	const waitSignal = AbortSignal.any([req.signal, waitController.signal]);
	const result = await Promise.race([gate.waitForChange(clientGeneration, waitSignal), delay.promise]);
	delay.cancel();
	waitController.abort();
	if (result === "aborted" || req.signal.aborted) return empty(499, snapshotHeaders(currentGeneration));

	await storage.reload();
	currentGeneration = storage.getGeneration();
	if (currentGeneration !== clientGeneration) {
		const body = buildSnapshot(storage, refresher);
		logger.info("auth-broker snapshot long-poll changed", {
			peer,
			credentials: body.credentials.length,
			generation: body.generation,
		});
		return json(200, body, snapshotHeaders(body.generation));
	}

	logger.info("auth-broker snapshot long-poll unchanged", { peer, generation: currentGeneration });
	return empty(304, snapshotHeaders(currentGeneration));
}

/**
 * Stable per-credential fingerprint for SSE delta detection. Field order is
 * fixed by this serializer (NOT by entry insertion order) so a credential
 * built by two different paths still produces the same fingerprint.
 *
 * `rotatesInMs` is intentionally part of the fingerprint: when it shifts we
 * want the client to recompute its `prepareForRequest` deadline rather than
 * keep the stale projection.
 */
function fingerprintEntry(entry: SnapshotEntry): string {
	return JSON.stringify([
		entry.id,
		entry.provider,
		entry.identityKey,
		entry.rotatesInMs,
		entry.credential,
		entry.blocks ?? [],
	]);
}

function sseEvent(event: string, body: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
}

function serveSnapshotStream(
	req: Request,
	storage: AuthStorage,
	refresher: AuthBrokerRefresher | undefined,
	peer: string,
	keepaliveMs: number,
): Response {
	const encoder = new TextEncoder();
	const openedAt = Date.now();
	const lastByCredId = new Map<number, string>();
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let unsubscribe: (() => void) | null = null;
	let keepaliveTimer: NodeJS.Timeout | undefined;
	let abortHandler: (() => void) | null = null;
	let processing = false;
	let pendingBumps = 0;
	let closed = false;
	let lastGeneration = -1;

	const cleanup = (): void => {
		if (closed) return;
		closed = true;
		if (keepaliveTimer !== undefined) {
			clearInterval(keepaliveTimer);
			keepaliveTimer = undefined;
		}
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		if (abortHandler) {
			req.signal.removeEventListener("abort", abortHandler);
			abortHandler = null;
		}
		try {
			controller?.close();
		} catch {
			// Already closed by Bun on client disconnect; harmless.
		}
		logger.info("auth-broker stream closed", { peer, durationMs: Date.now() - openedAt });
	};

	const write = (chunk: string): boolean => {
		if (closed || !controller) return false;
		try {
			controller.enqueue(encoder.encode(chunk));
			return true;
		} catch (err) {
			logger.debug("auth-broker stream enqueue failed", { peer, error: String(err) });
			cleanup();
			return false;
		}
	};

	const processGenerationBump = async (): Promise<void> => {
		if (closed) return;
		if (processing) {
			pendingBumps += 1;
			return;
		}
		processing = true;
		try {
			do {
				pendingBumps = 0;
				await storage.reload();
				if (closed) return;
				const snapshot = buildSnapshot(storage, refresher);
				// Generation must move forward; a duplicate listener firing without a
				// real bump is a no-op below (fingerprints unchanged).
				if (snapshot.generation < lastGeneration) {
					logger.warn("auth-broker stream generation went backwards", {
						peer,
						previous: lastGeneration,
						current: snapshot.generation,
					});
				}
				lastGeneration = snapshot.generation;
				const seenIds = new Set<number>();
				for (const entry of snapshot.credentials) {
					seenIds.add(entry.id);
					const fp = fingerprintEntry(entry);
					if (lastByCredId.get(entry.id) === fp) continue;
					lastByCredId.set(entry.id, fp);
					const payload: SnapshotStreamEntryEvent = {
						kind: "entry",
						generation: snapshot.generation,
						serverNowMs: snapshot.serverNowMs,
						refresher: snapshot.refresher,
						entry,
					};
					if (!write(sseEvent("entry", payload))) return;
					logger.debug("auth-broker stream entry", {
						peer,
						id: entry.id,
						provider: entry.provider,
						generation: snapshot.generation,
					});
				}
				for (const id of Array.from(lastByCredId.keys())) {
					if (seenIds.has(id)) continue;
					lastByCredId.delete(id);
					const payload: SnapshotStreamRemovedEvent = {
						kind: "removed",
						generation: snapshot.generation,
						serverNowMs: snapshot.serverNowMs,
						refresher: snapshot.refresher,
						id,
					};
					if (!write(sseEvent("removed", payload))) return;
					logger.debug("auth-broker stream removed", { peer, id, generation: snapshot.generation });
				}
			} while (pendingBumps > 0 && !closed);
		} finally {
			processing = false;
		}
	};

	const stream = new ReadableStream<Uint8Array>({
		async start(c) {
			controller = c;
			await storage.reload();
			const initial = buildSnapshot(storage, refresher);
			lastGeneration = initial.generation;
			for (const entry of initial.credentials) lastByCredId.set(entry.id, fingerprintEntry(entry));
			const initialEvent: SnapshotStreamSnapshotEvent = { kind: "snapshot", ...initial };
			if (!write(sseEvent("snapshot", initialEvent))) return;
			keepaliveTimer = setInterval(() => {
				write(": keepalive\n\n");
			}, keepaliveMs);
			keepaliveTimer.unref?.();
			unsubscribe = storage.onGenerationChanged(() => {
				void processGenerationBump();
			});
			abortHandler = (): void => cleanup();
			req.signal.addEventListener("abort", abortHandler);
			logger.info("auth-broker stream opened", { peer, generation: initial.generation });
		},
		cancel() {
			cleanup();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

/** What every route handler reads, built once per server. */
interface BrokerContext {
	storage: AuthStorage;
	refresher: AuthBrokerRefresher | undefined;
	gate: GenerationGate;
	bearer: BearerAllowList;
	version: string | undefined;
	streamKeepaliveMs: number;
}

/** One broker request: the request, its parsed URL, and the client address for logs. */
interface BrokerRequest {
	req: Request;
	url: URL;
	peer: string;
}

type BrokerHandler = (ctx: BrokerContext, request: BrokerRequest) => Promise<Response> | Response;
type CredentialHandler = (ctx: BrokerContext, request: BrokerRequest, id: number) => Promise<Response> | Response;

/**
 * A credential write that threw: 404 when the row is gone, else 500, with the
 * failure logged under `event`.
 */
function credentialWriteFailed(event: string, id: number, peer: string, error: unknown): Response {
	const message = errorMessage(error);
	logger.warn(event, { id, peer, error: message });
	return json(message.includes("No credential with id") ? 404 : 500, { error: message });
}

/** A logged 404 when no loaded row carries `id`; undefined when one does. */
function unknownCredential(storage: AuthStorage, id: number, peer: string, event: string): Response | undefined {
	if (storage.hasCredentialId(id)) return undefined;
	logger.info(event, { id, peer });
	return json(404, { error: `No credential with id=${id}` });
}

async function serveUsage({ storage }: BrokerContext, { req, peer }: BrokerRequest): Promise<Response> {
	try {
		// AuthStorage caches usage reports internally with a 5-minute per-credential
		// TTL (USAGE_REPORT_TTL_MS) so back-to-back widget polls re-use the
		// last fetch instead of hitting provider endpoints repeatedly.
		// `req.signal` propagates HTTP-client disconnects all the way to the
		// per-caller cancel without touching the shared upstream fetch.
		const reports = (await storage.fetchUsageReports?.({ signal: req.signal })) ?? [];
		// Drop the `raw` field — it's the provider-specific upstream body,
		// large and unstable. Everything UI-relevant lives in `limits` and
		// `metadata`.
		const trimmed = reports.map(({ raw: _raw, ...rest }) => rest);
		logger.info("auth-broker usage served", { peer, reports: trimmed.length });
		return json(200, { generatedAt: Date.now(), reports: trimmed });
	} catch (error) {
		const message = errorMessage(error);
		logger.warn("auth-broker usage fetch failed", { peer, error: message });
		return json(502, { error: message });
	}
}

function markUsageStale({ storage }: BrokerContext, { peer }: BrokerRequest): Response {
	try {
		storage.invalidateUsageCache?.();
		logger.info("auth-broker usage cache invalidated", { peer });
		return json(200, { ok: true });
	} catch (error) {
		const message = errorMessage(error);
		logger.warn("auth-broker usage cache invalidation failed", { peer, error: message });
		return json(500, { error: message });
	}
}

async function uploadCredential({ storage }: BrokerContext, { req, peer }: BrokerRequest): Promise<Response> {
	const parsed = await parseBody(req, wireSchemas().credentialUploadRequestSchema);
	if (!parsed.ok) return parsed.response;
	const { provider, credential } = parsed.data;
	try {
		const entries = storage.upsertCredential(provider, credential);
		const identity =
			credential.type === "oauth"
				? (credential.email ?? credential.accountId ?? credential.projectId ?? "(no identity)")
				: "(api key)";
		logger.info("auth-broker credential upserted", {
			provider,
			type: credential.type,
			identity,
			peer,
			providerTotal: entries.length,
		});
		const response: CredentialUploadResponse = { entries };
		return json(200, response);
	} catch (error) {
		const message = errorMessage(error);
		logger.warn("auth-broker upload failed", { provider, peer, error: message });
		return json(500, { error: message });
	}
}

async function refreshCredential(
	{ storage }: BrokerContext,
	{ req, peer }: BrokerRequest,
	id: number,
): Promise<Response> {
	try {
		const entry = await storage.refreshCredentialById(id, req.signal);
		const body: CredentialRefreshResponse = { entry };
		logger.info("auth-broker credential refreshed", {
			id,
			provider: entry.provider,
			peer,
			expires: entry.credential.type === "oauth" ? entry.credential.expires : undefined,
		});
		return json(200, body);
	} catch (error) {
		return credentialWriteFailed("auth-broker refresh failed", id, peer, error);
	}
}

async function disableCredential(
	{ storage }: BrokerContext,
	{ req, peer }: BrokerRequest,
	id: number,
): Promise<Response> {
	const parsed = await parseBody(req, wireSchemas().credentialDisableRequestSchema, { allowEmpty: true });
	if (!parsed.ok) return parsed.response;
	const cause = parsed.data.cause && parsed.data.cause.length > 0 ? parsed.data.cause : "disabled via auth-broker";
	if (!storage.disableCredentialById(id, cause)) {
		logger.info("auth-broker disable miss", { id, peer, cause });
		return json(404, { error: `No credential with id=${id}` });
	}
	logger.info("auth-broker credential disabled", { id, peer, cause });
	const response: CredentialDisableResponse = { ok: true };
	return json(200, response);
}

async function blockCredential(
	{ storage }: BrokerContext,
	{ req, peer }: BrokerRequest,
	id: number,
): Promise<Response> {
	const parsed = await parseBody(req, wireSchemas().credentialBlockRequestSchema);
	if (!parsed.ok) return parsed.response;
	const unknown = unknownCredential(storage, id, peer, "auth-broker credential block miss");
	if (unknown) return unknown;
	const block: StoredCredentialBlock = {
		credentialId: id,
		providerKey: parsed.data.providerKey,
		blockScope: parsed.data.blockScope,
		blockedUntilMs: parsed.data.blockedUntilMs,
	};
	try {
		storage.upsertCredentialBlock(block);
		logger.info("auth-broker credential block upserted", {
			id,
			peer,
			providerKey: block.providerKey,
			blockScope: block.blockScope,
			blockedUntilMs: block.blockedUntilMs,
		});
		const response: CredentialBlockResponse = { ok: true };
		return json(200, response);
	} catch (error) {
		return credentialWriteFailed("auth-broker credential block upsert failed", id, peer, error);
	}
}

function deleteCredentialBlocks({ storage }: BrokerContext, { peer }: BrokerRequest, id: number): Response {
	const unknown = unknownCredential(storage, id, peer, "auth-broker credential blocks delete miss");
	if (unknown) return unknown;
	try {
		storage.deleteCredentialBlocks(id);
		logger.info("auth-broker credential blocks deleted", { id, peer });
		const response: CredentialBlocksDeleteResponse = { ok: true };
		return json(200, response);
	} catch (error) {
		return credentialWriteFailed("auth-broker credential blocks delete failed", id, peer, error);
	}
}

/** Routes that require a bearer, keyed `METHOD /path`. */
const ROUTES: Record<string, BrokerHandler> = {
	"GET /v1/snapshot/stream": (ctx, { req, peer }) =>
		serveSnapshotStream(req, ctx.storage, ctx.refresher, peer, ctx.streamKeepaliveMs),
	"GET /v1/snapshot": (ctx, { req, url, peer }) => serveSnapshot(req, url, ctx.storage, ctx.gate, ctx.refresher, peer),
	"GET /v1/usage": serveUsage,
	"POST /v1/usage/stale": markUsageStale,
	"POST /v1/credential": uploadCredential,
};

/** Routes under `/v1/credential/:id/<action>` that require a bearer, keyed `METHOD action`. */
const CREDENTIAL_ROUTES: Record<string, CredentialHandler> = {
	"POST refresh": refreshCredential,
	"POST disable": disableCredential,
	"POST block": blockCredential,
	"DELETE blocks": deleteCredentialBlocks,
};

/**
 * Every broker route that requires a bearer, as `METHOD /path`, with `:id`
 * standing for a credential row id. `GET /v1/healthz` is the one route outside it.
 */
export const AUTH_BROKER_AUTHORIZED_ROUTES: readonly string[] = [
	...Object.keys(ROUTES),
	...Object.keys(CREDENTIAL_ROUTES).map(key => {
		const [method, action] = key.split(" ");
		return `${method} /v1/credential/:id/${action}`;
	}),
];

function dispatch(ctx: BrokerContext, request: BrokerRequest): Promise<Response> | Response {
	const { req, peer } = request;
	const pathname = request.url.pathname;
	if (req.method === "GET" && pathname === "/v1/healthz") {
		const body: HealthzResponse = { ok: true, version: ctx.version };
		return json(200, body);
	}
	if (!ctx.bearer.authorizes(req)) {
		logger.info("auth-broker request unauthorized", { method: req.method, path: pathname, peer });
		return json(401, { error: "unauthorized" });
	}
	const route: BrokerHandler | undefined = ROUTES[`${req.method} ${pathname}`];
	if (route) return route(ctx, request);
	const credential = CREDENTIAL_ROUTE.exec(pathname);
	const credentialRoute: CredentialHandler | undefined = credential
		? CREDENTIAL_ROUTES[`${req.method} ${credential[2]}`]
		: undefined;
	if (credential && credentialRoute) return credentialRoute(ctx, request, Number.parseInt(credential[1], 10));
	return json(404, { error: `No route: ${req.method} ${pathname}` });
}

/** Answer one request. A handler that throws answers a logged JSON 500. */
async function handleBrokerRequest(ctx: BrokerContext, req: Request): Promise<Response> {
	const url = new URL(req.url);
	const request: BrokerRequest = { req, url, peer: resolvePeer(req) };
	try {
		return await dispatch(ctx, request);
	} catch (error) {
		logger.error("auth-broker handler crashed", {
			method: req.method,
			path: url.pathname,
			peer: request.peer,
			error: String(error),
		});
		return json(500, { error: "internal error" });
	}
}

/** Boot the broker. Caller owns lifecycle; `handle.close()` to stop. */
export function startAuthBroker(opts: AuthBrokerServerOptions): AuthBrokerServerHandle {
	const bind = parseBind(opts.bind ?? DEFAULT_AUTH_BROKER_BIND);
	const refresher = opts.disableRefresher
		? undefined
		: new AuthBrokerRefresher({
				storage: opts.storage,
				refreshSkewMs: opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS,
				refreshIntervalMs: opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
			});
	refresher?.start();
	const ctx: BrokerContext = {
		storage: opts.storage,
		refresher,
		gate: new GenerationGate(opts.storage),
		bearer: new BearerAllowList(opts.bearerTokens),
		version: opts.version,
		streamKeepaliveMs: opts.streamKeepaliveMs ?? DEFAULT_STREAM_KEEPALIVE_MS,
	};

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		idleTimeout: DEFAULT_SERVER_IDLE_TIMEOUT_S,
		fetch: req => handleBrokerRequest(ctx, req),
	});

	const boundHost = server.hostname ?? bind.hostname;
	const boundPort = server.port ?? bind.port;
	return {
		url: `http://${boundHost}:${boundPort}`,
		port: boundPort,
		hostname: boundHost,
		close: async () => {
			refresher?.stop();
			ctx.gate.close();
			server.stop(true);
		},
	};
}
