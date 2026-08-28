import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isOfficialAnthropicApiUrl } from "@veyyon/catalog/compat/anthropic";
import { isOfficialOpenAIEndpoint } from "@veyyon/catalog/compat/openai";
import { isVertexExpressOpenAIUrl, isVertexRawPredictUrl } from "@veyyon/catalog/hosts";
import { CODEX_BASE_URL } from "@veyyon/catalog/wire/codex";
import { atomicWriteFile } from "@veyyon/utils/atomic-write";
import { getConfigRootDir } from "@veyyon/utils/dirs";
import { $env } from "@veyyon/utils/env";
import { isEnoent } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";
import { isProcessAlive } from "@veyyon/utils/process-liveness";
import { withExtraCaFetch } from "@veyyon/utils/tls-fetch";
import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { getCustomApi } from "./api-registry";
import { getEnvApiKey } from "./env-api-key";
import * as AIError from "./error";
import { resolveProviderInFlightLimit } from "./provider-inflight-limits";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import type { CursorOptions } from "./providers/cursor";
import type { DevinOptions } from "./providers/devin";
import { isGitLabDuoModel, streamGitLabDuo } from "./providers/gitlab-duo";
import { type GitLabDuoWorkflowOptions, streamGitLabDuoWorkflow } from "./providers/gitlab-duo-workflow";
import { getVertexAccessToken } from "./providers/google-auth";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli";
import type { GoogleVertexOptions } from "./providers/google-vertex";
import type { OllamaChatOptions } from "./providers/ollama";
// Heavy provider stream functions are imported lazily via register-builtins,
// which wraps each provider module in a dynamic import. This keeps the
// AWS SDK, google-auth-library, @google/genai, @bufbuild/protobuf, and
// other provider SDKs out of the CLI startup parse graph. The
// gitlab-duo / kimi / synthetic providers stay eager because their modules
// export routing predicates (isGitLabDuoModel, isKimiModel, isSyntheticModel)
// that must be callable synchronously before streaming begins, and their
// modules are thin wrappers with no heavy SDK dependencies.
import {
	streamAnthropic,
	streamAzureOpenAIResponses,
	streamBedrock,
	streamCursor,
	streamDevin,
	streamGoogle,
	streamGoogleGeminiCli,
	streamGoogleVertex,
	streamOllama,
	streamOpenAICodexResponses,
	streamOpenAICompletions,
	streamOpenAIResponses,
} from "./providers/register-builtins";
import type { Api, Context, FetchImpl, Model, OptionsForApi, SimpleStreamOptions, StreamOptions } from "./types";
import { AssistantMessageEventStream } from "./utils/event-stream";
import { isFoundryEnabled } from "./utils/foundry";
import { wrapLeakedThinkingStream } from "./utils/leaked-thinking-stream";
import { wrapFetchForProxy } from "./utils/proxy";
import { withRequestDebugFetch } from "./utils/request-debug";
import { withGeminiThinkingLoopGuard } from "./utils/thinking-loop";

export {
	complete,
	completeSimple,
	mapAnthropicToolChoice,
	mapGoogleToolChoice,
	mapOptionsForApi,
	OUTPUT_FALLBACK_BUFFER,
	streamSimple,
} from "./stream-helpers";

function isGoogleVertexAuthenticatedModel(model: Model<Api>): boolean {
	return (
		model.provider === "google-vertex" &&
		((model.api === "openai-completions" && isVertexExpressOpenAIUrl(model.baseUrl)) ||
			(model.api === "anthropic-messages" && isVertexRawPredictUrl(model.baseUrl)))
	);
}

/**
 * Whether {@link model} is an official first-party endpoint whose stream needs
 * no leaked-thinking healing — the official Anthropic API and the official
 * OpenAI / OpenAI-Codex endpoints return structured thinking blocks and never
 * leak reasoning idioms into the visible text channel.
 *
 * The gate is provider id **and** official endpoint URL: pointing
 * `provider: "anthropic"` (or `openai`) at a custom proxy via `models.yml`
 * still routes through {@link wrapLeakedThinkingStream}, since a third-party
 * gateway may well leak. URL checks are strict (exact origin / path boundary
 * or parsed hostname) — a substring match would accept lookalikes like
 * `https://api.openai.com.evil/`. Anthropic Foundry (`CLAUDE_CODE_USE_FOUNDRY`)
 * redirects an empty `baseUrl` to `FOUNDRY_BASE_URL`, so the check runs against
 * that effective endpoint — exempt only when it resolves to the official host.
 */
function isLeakedThinkingHealExempt(model: Model<Api>): boolean {
	switch (model.provider) {
		case "anthropic":
			// Mirror resolveAnthropicBaseUrl: Foundry redirects an empty baseUrl to
			// FOUNDRY_BASE_URL, so exempt only when the effective endpoint is official.
			return isOfficialAnthropicApiUrl((isFoundryEnabled() && $env.FOUNDRY_BASE_URL?.trim()) || model.baseUrl);
		case "openai":
			// The catalog's check, not a third copy of it: the same hostname question decides whether this
			// endpoint gets the obfuscation opt-out and server compaction, and a local copy drifted into
			// answering it here.
			return isOfficialOpenAIEndpoint("openai", model.baseUrl ?? "");
		case "openai-codex":
			return isOfficialCodexApiUrl(model.baseUrl);
		default:
			return false;
	}
}

/** Strict official-Codex endpoint check; exact origin or a path boundary after {@link CODEX_BASE_URL}. */
function isOfficialCodexApiUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return true;
	const lower = trimTrailingSlashes(baseUrl.toLowerCase());
	return lower === CODEX_BASE_URL || lower.startsWith(`${CODEX_BASE_URL}/`);
}

/**
 * Apply live leaked-thinking healing unless {@link model} is an official
 * first-party endpoint ({@link isLeakedThinkingHealExempt}), which emits
 * structured thinking and needs no healing.
 */
export function healLeakedThinking(model: Model<Api>, inner: AssistantMessageEventStream): AssistantMessageEventStream {
	return isLeakedThinkingHealExempt(model) ? inner : wrapLeakedThinkingStream(inner);
}

type ProviderInFlightLease = {
	path: string;
	heartbeat: NodeJS.Timeout;
	flushHeartbeat: () => Promise<void>;
	/** Run one heartbeat now and wait for it, so a test does not have to wait for the interval. */
	touchHeartbeat: () => Promise<void>;
};

type ProviderInFlightLeaseInfo = {
	pid: number;
	timestamp: number;
	token: string;
};
type ProviderInFlightStaleLock = { token: string } | { mtimeMs: number };
type ProviderInFlightLockIdentity = { dev: number; ino: number; birthtimeMs: number };

const PROVIDER_INFLIGHT_LOCK_STALE_MS = 10_000;
const PROVIDER_INFLIGHT_LEASE_STALE_MS = 30_000;
const PROVIDER_INFLIGHT_HEARTBEAT_MS = 5_000;
const PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS = 250;
/**
 * Consecutive heartbeat write failures that mean this lease WILL be treated as dead.
 *
 * A single failure is normal and uninteresting: the next beat rewrites the file. What matters is a run of
 * them long enough for the lease's timestamp to age past {@link PROVIDER_INFLIGHT_LEASE_STALE_MS}, because at
 * that point another process reclaims the lease while this request is still in flight and the concurrency
 * guard has failed OPEN. Derived from the two intervals rather than written as a number so it cannot drift
 * out of step with them.
 */
const PROVIDER_INFLIGHT_HEARTBEAT_FAILURES_BEFORE_STALE = Math.ceil(
	PROVIDER_INFLIGHT_LEASE_STALE_MS / PROVIDER_INFLIGHT_HEARTBEAT_MS,
);

let providerInFlightRootOverride: string | undefined;

/**
 * The caps and their resolver live in `./provider-inflight-limits`, which imports nothing.
 *
 * The WRITER of this state is the harness's settings layer, and reaching a setter that lived here meant
 * importing this module's 285: every provider transport, the model registry, the error taxonomy. The
 * re-export keeps `@veyyon/ai/stream` a working import path for it, so nothing that already calls it
 * changes, while a caller that only configures caps can name the owner instead.
 */
export { configureProviderMaxInFlightRequests } from "./provider-inflight-limits";

function providerInFlightRoot(): string {
	if (providerInFlightRootOverride) return providerInFlightRootOverride;
	return path.join(getConfigRootDir(), "run", "provider-inflight");
}

function providerInFlightSegment(provider: string): string {
	return crypto.createHash("sha256").update(provider).digest("base64url");
}

function providerInFlightDir(provider: string): string {
	return path.join(providerInFlightRoot(), providerInFlightSegment(provider));
}

function providerInFlightSignalPath(provider: string): string {
	return path.join(providerInFlightDir(provider), ".wakeup");
}

function providerInFlightLockDir(provider: string): string {
	return `${providerInFlightDir(provider)}.lock`;
}

async function readProviderInFlightInfo(infoPath: string): Promise<ProviderInFlightLeaseInfo | null> {
	try {
		const content = await fs.readFile(infoPath, "utf-8");
		const parsed = JSON.parse(content) as Partial<ProviderInFlightLeaseInfo>;
		if (typeof parsed.pid !== "number" || typeof parsed.timestamp !== "number" || typeof parsed.token !== "string") {
			return null;
		}
		return { pid: parsed.pid, timestamp: parsed.timestamp, token: parsed.token };
	} catch {
		// Null means "no valid lease here", the same answer the shape checks above give and the same answer
		// an absent file gives. The lease protocol then treats the slot as free, which is correct: a lease
		// we cannot read cannot be honoured, and a stale one is exactly what this file is for.
		return null;
	}
}

async function writeProviderInFlightInfo(dir: string, token: string): Promise<void> {
	const info: ProviderInFlightLeaseInfo = { pid: process.pid, timestamp: Date.now(), token };
	await atomicWriteFile(path.join(dir, "info.json"), JSON.stringify(info));
}

async function isProviderInFlightDirStale(dir: string, staleMs: number): Promise<boolean> {
	const info = await readProviderInFlightInfo(path.join(dir, "info.json"));
	if (info) {
		if (!isProcessAlive(info.pid)) return true;
		return Date.now() - info.timestamp > staleMs;
	}

	try {
		const stat = await fs.stat(path.join(dir, "info.json"));
		return Date.now() - stat.mtimeMs > staleMs;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	try {
		const stat = await fs.stat(dir);
		return Date.now() - stat.mtimeMs > staleMs;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function readProviderInFlightStaleLock(lockDir: string): Promise<ProviderInFlightStaleLock | null> {
	const infoPath = path.join(lockDir, "info.json");
	const info = await readProviderInFlightInfo(infoPath);
	if (info) return isProcessAlive(info.pid) ? null : { token: info.token };

	try {
		const stat = await fs.stat(lockDir);
		return Date.now() - stat.mtimeMs > PROVIDER_INFLIGHT_LOCK_STALE_MS ? { mtimeMs: stat.mtimeMs } : null;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function readProviderInFlightLockIdentity(lockDir: string): Promise<ProviderInFlightLockIdentity> {
	const stat = await fs.stat(lockDir);
	return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function isSameProviderInFlightLock(
	current: ProviderInFlightLockIdentity,
	expected: ProviderInFlightLockIdentity,
): boolean {
	if (current.dev !== expected.dev) return false;
	if (current.ino !== 0 || expected.ino !== 0) return current.ino === expected.ino;
	return current.birthtimeMs === expected.birthtimeMs;
}

/**
 * Report a lock directory that could not be released.
 *
 * All three release paths are best effort by design: a failed release must never turn into a thrown
 * error on a request that already succeeded. What it must not be is silent. This directory IS the
 * provider's concurrency gate, so one left behind makes the NEXT request for that provider wait for
 * the stale timeout ({@link PROVIDER_INFLIGHT_LOCK_STALE_MS}) before it can proceed — a latency cliff
 * with no error, no log line, and nothing pointing at a leftover directory (Law 10).
 *
 * A missing directory is not a leak: another process released the same lock first, which is the
 * ordinary outcome of the race these functions are written for.
 */
function reportProviderInFlightLockLeak(lockDir: string, what: string, error: unknown): void {
	if (isEnoent(error)) return;
	logger.warn("Provider in-flight lock could not be released; the next request for this provider will wait", {
		lockDir,
		lock: what,
		staleAfterMs: PROVIDER_INFLIGHT_LOCK_STALE_MS,
		error: errorMessage(error),
	});
}

/**
 * Report a lease directory that could not be removed.
 *
 * The lock releases have carried this contract since they were written: a failed release must never
 * turn into a thrown error on a request, and must never be silent either. The LEASE removal was the
 * half that had neither. `releaseProviderInFlightLease` had no `catch` at all, so an `fs.rm` that
 * failed (a config root whose permissions changed under a restrictive umask, a container running as
 * another uid, a synced home) threw out of the `finally` in `withProviderInFlightLimit` and REPLACED
 * the provider's own error with an `EACCES` about a temp directory. On the success path it was worse
 * than useless: the stream had already ended, so the throw was swallowed whole and the leaked slot
 * left no trace at all.
 *
 * A leaked lease is not merely slow. Until it ages past {@link PROVIDER_INFLIGHT_LEASE_STALE_MS} it
 * counts against the provider's limit, and if the same permissions stop the staleness sweep from
 * removing it, the slot is gone for the life of the directory.
 */
function reportProviderInFlightLeaseLeak(leasePath: string, what: string, error: unknown): void {
	if (isEnoent(error)) return;
	logger.warn("Provider in-flight lease could not be removed; it will hold a slot for this provider", {
		leasePath,
		lease: what,
		staleAfterMs: PROVIDER_INFLIGHT_LEASE_STALE_MS,
		error: errorMessage(error),
	});
}

async function releaseProviderInFlightStaleLock(lockDir: string, stale: ProviderInFlightStaleLock): Promise<void> {
	if ("token" in stale) {
		await releaseProviderInFlightLock(lockDir, stale.token);
		return;
	}

	const infoPath = path.join(lockDir, "info.json");
	if (await readProviderInFlightInfo(infoPath)) return;
	try {
		const stat = await fs.stat(lockDir);
		if (stat.mtimeMs !== stale.mtimeMs || Date.now() - stat.mtimeMs <= PROVIDER_INFLIGHT_LOCK_STALE_MS) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch (error) {
		reportProviderInFlightLockLeak(lockDir, "stale lock", error);
	}
}

// Best-effort token-checked release. A token mismatch means another process has
// already replaced the lock, so the fresh lock must be left intact.
async function releaseProviderInFlightLock(lockDir: string, token: string): Promise<void> {
	try {
		const info = await readProviderInFlightInfo(path.join(lockDir, "info.json"));
		if (!info || info.token !== token) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch (error) {
		reportProviderInFlightLockLeak(lockDir, "own lock", error);
	}
}

async function releaseProviderInFlightLockDirIfSame(
	lockDir: string,
	identity: ProviderInFlightLockIdentity,
): Promise<void> {
	try {
		if (await readProviderInFlightInfo(path.join(lockDir, "info.json"))) return;
		const current = await readProviderInFlightLockIdentity(lockDir);
		if (!isSameProviderInFlightLock(current, identity)) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch (error) {
		reportProviderInFlightLockLeak(lockDir, "unclaimed lock dir", error);
	}
}

async function acquireProviderInFlightLock(provider: string, signal?: AbortSignal): Promise<() => Promise<void>> {
	const lockDir = providerInFlightLockDir(provider);
	await fs.mkdir(path.dirname(lockDir), { recursive: true });

	while (true) {
		if (signal?.aborted)
			throw signal.reason ?? new AIError.RequestAbortError("Provider request aborted before dispatch");
		try {
			await fs.mkdir(lockDir);
			const lockIdentity = await readProviderInFlightLockIdentity(lockDir);
			const token = crypto.randomUUID();
			try {
				await writeProviderInFlightInfo(lockDir, token);
			} catch (error) {
				await releaseProviderInFlightLockDirIfSame(lockDir, lockIdentity);
				throw error;
			}
			return async () => {
				await releaseProviderInFlightLock(lockDir, token);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		const staleLock = await readProviderInFlightStaleLock(lockDir);
		if (staleLock) {
			await releaseProviderInFlightStaleLock(lockDir, staleLock);
			await signalProviderInFlightWaiters(provider);
			continue;
		}

		await waitForProviderInFlightSignal(provider, signal);
	}
}

async function cleanupProviderInFlightLeases(providerDir: string): Promise<number> {
	let active = 0;
	let entries: string[];
	try {
		entries = await fs.readdir(providerDir);
	} catch (error) {
		if (isEnoent(error)) return 0;
		throw error;
	}

	for (const entry of entries) {
		const leaseDir = path.join(providerDir, entry);
		let isDirectory = false;
		try {
			isDirectory = (await fs.stat(leaseDir)).isDirectory();
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		if (!isDirectory) continue;
		if (await isProviderInFlightDirStale(leaseDir, PROVIDER_INFLIGHT_LEASE_STALE_MS)) {
			// The lease is provably dead: its owning pid is gone or its heartbeat stopped long enough ago
			// that another process is already entitled to proceed. Removing the directory is housekeeping,
			// so a removal that fails must not become the request's error. It used to: the throw escaped
			// through `tryAcquireProviderInFlightLease` and `acquireProviderInFlightSlot` into
			// `withProviderInFlightLimit`, which failed the stream with an `EACCES` about a temp directory,
			// and it did so on EVERY later request for that provider because the sweep runs on each one.
			// One unremovable directory turned into a permanently dead provider.
			//
			// It is counted as reclaimed rather than active, deliberately. Counting it would be the other
			// failure: with a limit of one, a directory that cannot be removed and cannot age out would
			// block every request for that provider forever, and a hang is worse than briefly exceeding a
			// soft concurrency cap. The warning names the directory so the cause is findable.
			try {
				await fs.rm(leaseDir, { recursive: true, force: true });
			} catch (error) {
				reportProviderInFlightLeaseLeak(leaseDir, "stale lease sweep", error);
			}
			continue;
		}
		active++;
	}
	return active;
}

async function tryAcquireProviderInFlightLease(
	provider: string,
	limit: number,
	signal?: AbortSignal,
): Promise<ProviderInFlightLease | null> {
	const releaseLock = await acquireProviderInFlightLock(provider, signal);
	try {
		const dir = providerInFlightDir(provider);
		await fs.mkdir(dir, { recursive: true });
		const active = await cleanupProviderInFlightLeases(dir);
		if (active >= limit) return null;

		const leaseDir = path.join(dir, `${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
		const token = crypto.randomUUID();
		try {
			await fs.mkdir(leaseDir);
			await writeProviderInFlightInfo(leaseDir, token);
		} catch (error) {
			// The lease-creation error is what the caller needs and it is rethrown. A cleanup that also fails
			// could only be surfaced by replacing that error with a less useful one; the cost of dropping it is
			// one lease directory that the staleness sweep will reclaim.
			await removeProviderInFlightLeaseDir(leaseDir).catch(() => {});
			throw error;
		}
		let heartbeatFlush = Promise.resolve();
		// A heartbeat that keeps failing lets the lease age past PROVIDER_INFLIGHT_LEASE_STALE_MS, after which
		// another process treats this in-flight request as dead and proceeds: the concurrency guard fails OPEN
		// while the operator still believes duplicate in-flight requests are prevented. The write itself cannot
		// be made to throw here (nothing awaits the interval callback), so the failure is COUNTED, and the run
		// is reported once it is long enough to have that effect. The first failures stay quiet on purpose: a
		// single transient write failure is normal and the next beat repairs it.
		let consecutiveFailures = 0;
		let reportedStaleRisk = false;
		const touchHeartbeat = (): Promise<void> => {
			heartbeatFlush = heartbeatFlush
				.then(
					() => writeProviderInFlightInfo(leaseDir, token),
					() => writeProviderInFlightInfo(leaseDir, token),
				)
				.then(
					() => {
						if (reportedStaleRisk) {
							logger.warn("Provider in-flight lease heartbeat recovered", {
								provider,
								lease: leaseDir,
								missedBeats: consecutiveFailures,
							});
						}
						consecutiveFailures = 0;
						reportedStaleRisk = false;
					},
					(error: unknown) => {
						consecutiveFailures++;
						if (consecutiveFailures < PROVIDER_INFLIGHT_HEARTBEAT_FAILURES_BEFORE_STALE || reportedStaleRisk) {
							return;
						}
						reportedStaleRisk = true;
						logger.warn(
							"Provider in-flight lease heartbeat keeps failing; another process may treat this request as dead and exceed the in-flight limit",
							{
								provider,
								lease: leaseDir,
								missedBeats: consecutiveFailures,
								staleAfterMs: PROVIDER_INFLIGHT_LEASE_STALE_MS,
								error: errorMessage(error),
							},
						);
					},
				);
			return heartbeatFlush;
		};
		const heartbeat = setInterval(touchHeartbeat, PROVIDER_INFLIGHT_HEARTBEAT_MS);
		heartbeat.unref?.();
		return {
			path: leaseDir,
			heartbeat,
			flushHeartbeat: () => heartbeatFlush,
			touchHeartbeat: () => touchHeartbeat(),
		};
	} finally {
		await releaseLock();
	}
}

async function signalProviderInFlightWaitersInDir(dir: string): Promise<void> {
	try {
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, ".wakeup"), String(Date.now()));
	} catch (error) {
		// Waiters have a fallback timer, so a dropped wakeup is not fatal, but it is
		// not free either: every queued request for this provider then waits out
		// PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS. A directory that is unwritable stays
		// unwritable, so the stall repeats forever with no other trace.
		logger.warn("Provider in-flight wakeup could not be written; queued requests will wait for the fallback timer", {
			dir,
			error: errorMessage(error),
		});
	}
}

async function signalProviderInFlightWaiters(provider: string): Promise<void> {
	await signalProviderInFlightWaitersInDir(providerInFlightDir(provider));
}

function waitForProviderInFlightSignal(provider: string, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted)
		return Promise.reject(signal.reason ?? new AIError.RequestAbortError("Provider request aborted before dispatch"));
	const signalPath = providerInFlightSignalPath(provider);
	const waitStarted = Date.now();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	let watcher: fsSync.FSWatcher | undefined;
	const timer = setTimeout(() => finish(resolve), PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS);
	const finish = (settle: () => void) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		watcher?.close();
		signal?.removeEventListener("abort", onAbort);
		settle();
	};
	const onAbort = () => {
		finish(() => reject(signal?.reason ?? new AIError.RequestAbortError("Provider request aborted before dispatch")));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		watcher = fsSync.watch(providerInFlightDir(provider), (_event, filename) => {
			if (filename === ".wakeup" || filename === null) {
				finish(resolve);
			}
		});
		void fs.stat(signalPath).then(
			stat => {
				if (stat.mtimeMs >= waitStarted) finish(resolve);
			},
			error => {
				if (!isEnoent(error)) finish(resolve);
			},
		);
	} catch {
		// Filesystem notifications are best-effort across platforms; the fallback
		// timer keeps stale-lock/lease cleanup progressing if an event is dropped.
	}
	return promise;
}

async function removeProviderInFlightLeaseDir(leasePath: string): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await fs.rm(leasePath, { recursive: true, force: true });
			return;
		} catch (error) {
			if (isEnoent(error)) return;
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt < 2 && (code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM")) {
				await Bun.sleep(25);
				continue;
			}
			throw error;
		}
	}
}

// Signal into the lease's OWN provider directory (derived from `lease.path`)
// rather than recomputing it from the current root. A release that lands after
// the in-flight root has been repointed (only the test seam does that) must not
// write `.wakeup` into an unrelated provider directory.
async function releaseProviderInFlightLease(lease: ProviderInFlightLease): Promise<void> {
	clearInterval(lease.heartbeat);
	await lease.flushHeartbeat();
	try {
		await removeProviderInFlightLeaseDir(lease.path);
	} catch (error) {
		// Never rethrow. This runs from the `finally` in `withProviderInFlightLimit`, where a throw
		// REPLACES whatever the request was already reporting: a provider's real failure became an
		// `EACCES` about a temp directory, and a successful stream had the throw swallowed silently
		// because `outer` was already ended. Both outcomes destroyed the information that mattered.
		reportProviderInFlightLeaseLeak(lease.path, "own lease", error);
	}
	// Signalled even when the removal failed. Waiters are woken by the `.wakeup` write, not by the
	// directory disappearing, and a waiter that is never woken pays the fallback timer on top of a
	// slot it may not get anyway.
	await signalProviderInFlightWaitersInDir(path.dirname(lease.path));
}

async function acquireProviderInFlightSlot(
	provider: string,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	if (limit === undefined) return async () => {};
	let loggedWait = false;
	while (true) {
		if (signal?.aborted)
			throw signal.reason ?? new AIError.RequestAbortError("Provider request aborted before dispatch");
		const lease = await tryAcquireProviderInFlightLease(provider, limit, signal);
		if (lease) return () => releaseProviderInFlightLease(lease);
		if (!loggedWait) {
			loggedWait = true;
			logger.debug("Provider in-flight limit blocked request", { provider, limit });
		}
		await waitForProviderInFlightSignal(provider, signal);
	}
}

export const __providerInFlightForTesting = {
	setRoot(root: string | undefined): void {
		providerInFlightRootOverride = root;
	},
	providerDir(provider: string): string {
		return providerInFlightDir(provider);
	},
	lockDir(provider: string): string {
		return providerInFlightLockDir(provider);
	},
	async captureStaleLockRelease(provider: string): Promise<(() => Promise<void>) | null> {
		const lockDir = providerInFlightLockDir(provider);
		const stale = await readProviderInFlightStaleLock(lockDir);
		if (!stale) return null;
		return () => releaseProviderInFlightStaleLock(lockDir, stale);
	},
	/**
	 * Take a real lease and expose one heartbeat, so a test can make the write fail and drive beats itself
	 * instead of waiting out PROVIDER_INFLIGHT_HEARTBEAT_MS several times.
	 */
	async acquireLease(
		provider: string,
		limit: number,
	): Promise<{ path: string; beat: () => Promise<void>; release: () => Promise<void> } | null> {
		const lease = await tryAcquireProviderInFlightLease(provider, limit);
		if (!lease) return null;
		return {
			path: lease.path,
			beat: () => lease.touchHeartbeat(),
			release: () => releaseProviderInFlightLease(lease),
		};
	},
	async captureLockDirRelease(provider: string): Promise<(() => Promise<void>) | null> {
		const lockDir = providerInFlightLockDir(provider);
		try {
			const identity = await readProviderInFlightLockIdentity(lockDir);
			return () => releaseProviderInFlightLockDirIfSame(lockDir, identity);
		} catch {
			// No identity read means we cannot prove the lock is ours, so no release closure is handed back and
			// nothing is unlocked. Fail closed: releasing a lock that might belong to another process is the
			// failure that matters here, and null is the caller's "nothing to release" answer.
			return null;
		}
	},
};

export function withProviderInFlightLimit<TOptions extends Pick<StreamOptions, "signal" | "maxInFlightRequests">>(
	model: Model<Api>,
	options: TOptions | undefined,
	dispatch: () => AssistantMessageEventStream,
): AssistantMessageEventStream {
	// Leaked-thinking healing folds in here — the one shared provider-dispatch
	// chokepoint — so the loop guard (which wraps this) sees healed events and all
	// provider exits are covered by one wrap. Official first-party providers are
	// exempt (see `healLeakedThinking`); healing is otherwise idempotent.
	const limit = resolveProviderInFlightLimit(model.provider, options?.maxInFlightRequests);
	if (limit === undefined) return healLeakedThinking(model, dispatch());

	const outer = new AssistantMessageEventStream();
	void (async () => {
		let release: (() => Promise<void>) | undefined;
		let released = false;
		const releaseOnce = async () => {
			if (!release || released) return;
			released = true;
			await release();
		};
		try {
			const startedWaitingAt = Date.now();
			release = await acquireProviderInFlightSlot(model.provider, limit, options?.signal);
			if (Date.now() - startedWaitingAt >= PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS) {
				logger.debug("Provider in-flight limit wait completed", { provider: model.provider, limit });
			}
			if (options?.signal?.aborted) {
				throw options.signal.reason ?? new AIError.RequestAbortError("Provider request aborted before dispatch");
			}
			const inner = healLeakedThinking(model, dispatch());
			try {
				for await (const event of inner) {
					outer.push(event);
					if (outer.done) return;
				}
				if (!outer.done) outer.end(await inner.result());
			} finally {
				await releaseOnce();
			}
		} catch (error) {
			await releaseOnce();
			if (!outer.done) outer.fail(error);
		}
	})();
	return outer;
}

function createVertexAuthenticatedFetch(options: StreamOptions | undefined): FetchImpl {
	const baseFetch = options?.fetch ?? fetch;
	const vertexFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const token = await getVertexAccessToken({ signal: options?.signal, fetch: baseFetch });
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${token}`);
		const rewritten = resolveVertexRequest(input);
		const url = rewritten instanceof Request ? rewritten.url : rewritten.toString();
		if (isVertexRawPredictUrl(url)) {
			const bodyText = await readVertexRequestBody(rewritten, init);
			const transformed = transformVertexAnthropicBody(bodyText);
			return baseFetch(url, {
				...init,
				method: init?.method ?? (rewritten instanceof Request ? rewritten.method : "POST"),
				headers,
				body: transformed,
			});
		}
		return baseFetch(rewritten, { ...init, headers });
	};
	return Object.assign(vertexFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
}

async function readVertexRequestBody(input: string | URL | Request, init: RequestInit | undefined): Promise<string> {
	if (input instanceof Request) return input.clone().text();
	const body = init?.body;
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	return "";
}

// Vertex Claude rejects the standard Anthropic body shape: the `model` field
// is encoded in the URL path and `anthropic_version: "vertex-2023-10-16"` is
// required in the JSON body instead of the `anthropic-version` HTTP header.
function transformVertexAnthropicBody(bodyText: string): string {
	if (!bodyText) return bodyText;
	try {
		const payload = JSON.parse(bodyText) as Record<string, unknown>;
		delete payload.model;
		payload.anthropic_version = "vertex-2023-10-16";
		return JSON.stringify(payload);
	} catch {
		return bodyText;
	}
}

function resolveVertexRequest(input: string | URL | Request): string | URL | Request {
	const project = $env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT;
	const location = $env.GOOGLE_VERTEX_LOCATION || $env.GOOGLE_CLOUD_LOCATION || $env.VERTEX_LOCATION;
	if (!project || !location) return input;

	const rewriteUrl = (url: string): string => {
		const hasPlaceholder =
			url.includes("{project}") ||
			url.includes("{location}") ||
			url.includes("%7Bproject%7D") ||
			url.includes("%7Blocation%7D");
		const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
		const rewritten = hasPlaceholder
			? url
					.replace("https://{location}-aiplatform.googleapis.com", `https://${host}`)
					.replace("https://%7Blocation%7D-aiplatform.googleapis.com", `https://${host}`)
					.replaceAll("{project}", encodeURIComponent(project))
					.replaceAll("%7Bproject%7D", encodeURIComponent(project))
					.replaceAll("{location}", encodeURIComponent(location))
					.replaceAll("%7Blocation%7D", encodeURIComponent(location))
			: url;
		return rewritten.replace(":streamRawPredict/v1/messages", ":streamRawPredict");
	};

	if (input instanceof Request) {
		const rewrittenUrl = rewriteUrl(input.url);
		return rewrittenUrl === input.url ? input : new Request(rewrittenUrl, input);
	}
	if (input instanceof URL) {
		const rewrittenUrl = rewriteUrl(input.toString());
		return rewrittenUrl === input.toString() ? input : new URL(rewrittenUrl);
	}
	return rewriteUrl(input);
}

// The env-key table moved to `./env-api-key`, a leaf that imports the catalog and the registry and
// nothing else. It was here only because it was written here, and it made every caller that wanted
// "which variable holds this key" instantiate the whole streaming engine. Re-exported rather than
// dropped so the specifier a caller already uses keeps working.
export { getEnvApiKey, getEnvApiKeyName, listProvidersWithEnvKey } from "./env-api-key";

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	return withGeminiThinkingLoopGuard(model, options, opts =>
		withProviderInFlightLimit(model, opts, () => streamDispatch(model, context, opts)),
	);
}

function streamDispatch<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	const baseOptions = (options || {}) as StreamOptions;
	const debugOptions = withExtraCaFetch(withRequestDebugFetch(baseOptions));
	const requestOptions = {
		...debugOptions,
		fetch: wrapFetchForProxy(debugOptions.fetch ?? (globalThis.fetch as FetchImpl), model.provider),
	} as OptionsForApi<TApi>;

	// Check custom API registry first (extension-provided APIs like "vertex-claude-api")
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return customApiProvider.stream(model, context, requestOptions as StreamOptions);
	}

	if (isGitLabDuoModel(model)) {
		const apiKey = requestOptions.apiKey || getEnvApiKey(model.provider);
		if (!apiKey) {
			throw new AIError.MissingApiKeyError(model.provider);
		}
		return streamGitLabDuo(model, context, {
			...(requestOptions as SimpleStreamOptions),
			apiKey,
		});
	}

	if (model.api === "gitlab-duo-agent") {
		const apiKey = (requestOptions as StreamOptions | undefined)?.apiKey || getEnvApiKey(model.provider);
		if (!apiKey) {
			throw new AIError.MissingApiKeyError(model.provider);
		}
		return streamGitLabDuoWorkflow(model as Model<"gitlab-duo-agent">, context, {
			...(requestOptions as StreamOptions | undefined),
			apiKey,
		} as GitLabDuoWorkflowOptions);
	}

	// Vertex AI uses Application Default Credentials, not API keys
	if (model.api === "google-vertex") {
		return streamGoogleVertex(model as Model<"google-vertex">, context, requestOptions as GoogleVertexOptions);
	} else if (model.api === "bedrock-converse-stream") {
		// Bedrock doesn't have any API keys instead it sources credentials from standard AWS env variables or from given AWS profile.
		return streamBedrock(model as Model<"bedrock-converse-stream">, context, requestOptions as BedrockOptions);
	}

	const apiKey = requestOptions.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(model.provider);
	}
	const providerOptions = isGoogleVertexAuthenticatedModel(model)
		? {
				...requestOptions,
				apiKey: "vertex-adc",
				fetch: createVertexAuthenticatedFetch(requestOptions),
			}
		: { ...requestOptions, apiKey };

	const api: Api = model.api;
	switch (api) {
		case "anthropic-messages": {
			const anthropicOptions = providerOptions as AnthropicOptions;
			return streamAnthropic(model as Model<"anthropic-messages">, context, {
				...anthropicOptions,
				isOAuth: anthropicOptions.isOAuth ?? model.isOAuth,
			});
		}

		case "openrouter": {
			const useResponses = $env.VEYYON_OPENROUTER_RESPONSES !== "0";
			if (useResponses) {
				return streamOpenAIResponses(
					model as Model<"openai-responses">,
					context,
					providerOptions as OptionsForApi<"openai-responses">,
				);
			}
			return streamOpenAICompletions(
				model as Model<"openai-completions">,
				context,
				providerOptions as OptionsForApi<"openai-completions">,
			);
		}

		case "openai-completions":
			return streamOpenAICompletions(
				model as Model<"openai-completions">,
				context,
				providerOptions as OptionsForApi<"openai-completions">,
			);

		case "openai-responses":
			return streamOpenAIResponses(
				model as Model<"openai-responses">,
				context,
				providerOptions as OptionsForApi<"openai-responses">,
			);

		case "azure-openai-responses":
			return streamAzureOpenAIResponses(
				model as Model<"azure-openai-responses">,
				context,
				providerOptions as OptionsForApi<"azure-openai-responses">,
			);

		case "openai-codex-responses":
			return streamOpenAICodexResponses(
				model as Model<"openai-codex-responses">,
				context,
				providerOptions as OptionsForApi<"openai-codex-responses">,
			);

		case "google-generative-ai":
			return streamGoogle(model as Model<"google-generative-ai">, context, providerOptions);

		case "google-gemini-cli":
			return streamGoogleGeminiCli(
				model as Model<"google-gemini-cli">,
				context,
				providerOptions as GoogleGeminiCliOptions,
			);

		case "ollama-chat":
			return streamOllama(model as Model<"ollama-chat">, context, providerOptions as OllamaChatOptions);

		case "cursor-agent":
			return streamCursor(model as Model<"cursor-agent">, context, providerOptions as CursorOptions);

		case "devin-agent":
			return streamDevin(model as Model<"devin-agent">, context, providerOptions as DevinOptions);

		default:
			throw new AIError.ConfigurationError(`Unhandled API: ${api}`);
	}
}

/** Thinking-loop re-samples spent before {@link resolveWithThinkingLoopCook} cooks. */
