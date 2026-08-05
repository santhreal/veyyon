/**
 * A provider in-flight LEASE that cannot be removed is announced, and never becomes the request's error.
 *
 * WHY THIS SUITE EXISTS. `provider-inflight-lock-leak-is-announced.test.ts` states the contract for
 * the three LOCK release paths: "a failed release must never turn into a thrown error on a request
 * that already succeeded", and it must not be silent either. All three lock releases implement it.
 * The LEASE half implemented neither. `releaseProviderInFlightLease` had no `catch` at all and the
 * stale-lease sweep called `fs.rm` bare, so an `fs.rm` failure produced three distinct defects:
 *
 *  1. On a FAILING request, the release runs in the `finally` of `withProviderInFlightLimit`, so the
 *     throw replaced the provider's own error. The operator was told `EACCES ... rm /tmp/...` instead
 *     of what the model actually said.
 *  2. On a SUCCEEDING request, `outer` was already ended, so the throw was swallowed whole. The slot
 *     leaked with no error, no log line, and nothing pointing at the leftover directory.
 *  3. Worst: the staleness sweep runs on EVERY acquisition for that provider, and its bare `fs.rm`
 *     threw out through `acquireProviderInFlightSlot`. One directory that could not be removed turned
 *     into a provider where every subsequent request failed with `EACCES`.
 *
 * The failure is produced the way it actually happens: the lease's PARENT (the provider directory
 * under the config root) becomes unwritable, which is what a changed umask, a container running as
 * another uid, or a synced home does. Every read still works; only `rm` fails.
 *
 * The reclaim decision in (3) is pinned too. A dead lease that cannot be removed is counted as
 * RECLAIMED rather than active, because counting it would mean a limit of one blocks every request
 * for that provider forever, and a hang is worse than briefly exceeding a soft concurrency cap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@veyyon/ai/api-registry";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import { __providerInFlightForTesting, configureProviderMaxInFlightRequests, streamSimple } from "@veyyon/ai/stream";
import type { Context } from "@veyyon/ai/types";
import { logger } from "@veyyon/utils";

const LEAK_MESSAGE = "Provider in-flight lease could not be removed; it will hold a slot for this provider";
/** Older than PROVIDER_INFLIGHT_LEASE_STALE_MS (30s), so the sweep treats the lease as dead. */
const WELL_PAST_STALE_MS = 120_000;
/** A pid that cannot be alive, so the lease reads as abandoned rather than held. */
const DEAD_PID = 0x7ffffffe;

let limiterRoot: string | undefined;
/** Directories made read-only here, restored in `afterEach` so cleanup can remove them. */
const restoreModeOn: string[] = [];
let warnings: Array<{ message: string; fields: Record<string, unknown> }>;
/**
 * Resolves on the first leak warning. The slot release runs in the `finally` of
 * `withProviderInFlightLimit`, which is AFTER `outer.end`, so awaiting the stream result does not
 * await the release. Awaiting the log call itself is the real signal; a sleep would be a guess.
 */
let firstLeakReported: PromiseWithResolvers<void>;

function context(): Context {
	return { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
}

function leaks(): Array<Record<string, unknown>> {
	return warnings.filter(entry => entry.message === LEAK_MESSAGE).map(entry => entry.fields);
}

/** Mode bits do not restrict root, and Windows does not honour them at all. */
function canRestrictAccess(): boolean {
	return process.platform !== "win32" && process.getuid?.() !== 0;
}

async function denyWrites(dir: string): Promise<void> {
	await fs.chmod(dir, 0o500);
	restoreModeOn.push(dir);
}

beforeEach(async () => {
	limiterRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-inflight-lease-leak-"));
	__providerInFlightForTesting.setRoot(limiterRoot);
	warnings = [];
	firstLeakReported = Promise.withResolvers<void>();
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
		if (message === LEAK_MESSAGE) firstLeakReported.resolve();
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	clearCustomApis();
	configureProviderMaxInFlightRequests(undefined);
	__providerInFlightForTesting.setRoot(undefined);
	for (const dir of restoreModeOn.splice(0)) {
		await fs.chmod(dir, 0o700).catch(() => {});
	}
	if (limiterRoot !== undefined) {
		await fs.rm(limiterRoot, { recursive: true, force: true });
		limiterRoot = undefined;
	}
});

describe("provider in-flight lease removal failures", () => {
	it("reports the leak instead of replacing the provider's own error", async () => {
		if (!canRestrictAccess()) return;
		registerMockApi();
		const providerDir = __providerInFlightForTesting.providerDir("tests");
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				// The lease exists by now; making its parent read-only is what stops `rm`.
				await denyWrites(providerDir);
				throw new Error("provider exploded");
			},
		});

		const stream = streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } });

		// The provider's message, not an EACCES about a temp directory.
		await expect(stream.result()).rejects.toThrow("provider exploded");

		const reported = leaks();
		expect(reported).toHaveLength(1);
		expect(reported[0].lease).toBe("own lease");
		expect(String(reported[0].leasePath).startsWith(`${providerDir}/`)).toBe(true);
		expect(String(reported[0].error)).toContain("EACCES");
		expect(reported[0].staleAfterMs).toBe(30_000);
	});

	it("reports the leak on a request that succeeded, where it was completely silent", async () => {
		if (!canRestrictAccess()) return;
		registerMockApi();
		const providerDir = __providerInFlightForTesting.providerDir("tests");
		const mock = createMockModel({
			provider: "tests",
			handler: async () => {
				await denyWrites(providerDir);
				return { content: ["reply"] };
			},
		});

		const message = await streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } }).result();
		await firstLeakReported.promise;

		expect(message.content).toEqual([{ type: "text", text: "reply" }]);
		expect(leaks()).toHaveLength(1);
	});

	/**
	 * The sweep runs on every acquisition, so before the fix a single unremovable directory did not
	 * degrade the provider, it killed it: the second request and every one after failed with EACCES.
	 */
	it("keeps the provider usable when a dead lease cannot be swept", async () => {
		if (!canRestrictAccess()) return;
		registerMockApi();
		const providerDir = __providerInFlightForTesting.providerDir("tests");
		// A lease from a process that is gone, old enough that the sweep must reclaim it. Only the
		// LEASE directory is made unwritable, not the provider directory: an unwritable provider
		// directory stops a new lease being created at all, which is a different (and unavoidable)
		// failure. This is the case where a fresh request can proceed and only the housekeeping fails.
		const deadLease = path.join(providerDir, "9999-dead-lease");
		await fs.mkdir(deadLease, { recursive: true });
		await fs.writeFile(
			path.join(deadLease, "info.json"),
			JSON.stringify({ pid: DEAD_PID, timestamp: Date.now() - WELL_PAST_STALE_MS, token: "dead" }),
		);
		// `rm -r` must unlink info.json first, and that needs write on the directory holding it.
		await denyWrites(deadLease);

		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });
		const message = await streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } }).result();

		// The request went through: the dead lease was counted as reclaimed, not as the sole slot.
		expect(message.content).toEqual([{ type: "text", text: "reply" }]);
		expect(mock.calls).toHaveLength(1);
		// And the directory that could not be removed is named rather than left to be guessed at.
		const sweepLeaks = leaks().filter(fields => fields.lease === "stale lease sweep");
		expect(sweepLeaks.length).toBeGreaterThanOrEqual(1);
		expect(sweepLeaks[0].leasePath).toBe(deadLease);
	});

	it("says nothing when the lease directory is simply already gone", async () => {
		registerMockApi();
		const mock = createMockModel({ provider: "tests", responses: [{ content: ["reply"] }] });

		await streamSimple(mock.model, context(), { maxInFlightRequests: { tests: 1 } }).result();

		// ENOENT is the ordinary race these paths are written for, not a leak.
		expect(leaks()).toEqual([]);
	});
});
