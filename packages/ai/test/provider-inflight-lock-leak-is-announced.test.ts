/**
 * A provider in-flight lock that cannot be released is reported, because the next request pays for it.
 *
 * WHY THIS SUITE EXISTS. `stream.ts` gates per-provider concurrency with a lock DIRECTORY under the
 * config root. Three functions release it — the token-checked release of a lock this process owns, the
 * stale-lock release keyed on mtime, and the identity-checked release of a lock directory with no
 * lease info — and all three ended in a bare `catch {}`.
 *
 * Best effort is the right shape: a failed release must never turn into a thrown error on a request
 * that already succeeded, and losing the release race to another process is the ordinary outcome these
 * functions are written for. What it must not be is invisible. The directory IS the gate, so one left
 * behind makes the NEXT request for that provider wait out the full stale timeout before it can
 * proceed. That is a latency cliff with no error, no log line, and nothing pointing at a leftover
 * directory on disk — the operator sees a provider that has become mysteriously slow (Law 10).
 *
 * The failure is produced here by making the lock's PARENT directory read-only, which is how it
 * actually happens: the lock lives under the config root, and a root whose permissions changed (a
 * restrictive umask, a container running as a different uid, a synced home) makes `rm` fail with
 * EACCES while every read still works. ENOENT is pinned as silent in the same suite, since that is the
 * race, not a leak.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __providerInFlightForTesting } from "@veyyon/ai/stream";
import { logger } from "@veyyon/utils";

const LEAK_MESSAGE = "Provider in-flight lock could not be released; the next request for this provider will wait";

/** Older than PROVIDER_INFLIGHT_LOCK_STALE_MS (10s), so the stale path engages. */
const WELL_PAST_STALE_MS = 60_000;

/** A pid that cannot be alive, so a lease reads as abandoned rather than held. */
const DEAD_PID = 0x7ffffffe;

let limiterRoot: string;
/** Directories this test made read-only, restored in `afterEach` so cleanup can remove them. */
const restoreModeOn: string[] = [];
let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

function leaks(): Array<Record<string, unknown>> {
	return warnings.filter(entry => entry.message === LEAK_MESSAGE).map(entry => entry.fields);
}

/** Mode bits do not restrict root, and Windows does not honour them at all. */
function canRestrictAccess(): boolean {
	return process.platform !== "win32" && process.getuid?.() !== 0;
}

/** Make a directory unwritable, remembering it so `afterEach` can put it back. */
async function denyWrites(dir: string): Promise<void> {
	await fs.chmod(dir, 0o500);
	restoreModeOn.push(dir);
}

async function makeLockDir(provider: string, options: { lease?: string; ageMs?: number } = {}): Promise<string> {
	const lockDir = __providerInFlightForTesting.lockDir(provider);
	await fs.mkdir(lockDir, { recursive: true });
	if (options.lease !== undefined) {
		await fs.writeFile(
			path.join(lockDir, "info.json"),
			JSON.stringify({ pid: DEAD_PID, timestamp: Date.now() - WELL_PAST_STALE_MS, token: options.lease }),
		);
	}
	if (options.ageMs !== undefined) {
		const when = new Date(Date.now() - options.ageMs);
		await fs.utimes(lockDir, when, when);
	}
	return lockDir;
}

beforeEach(async () => {
	limiterRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-inflight-leak-"));
	__providerInFlightForTesting.setRoot(limiterRoot);
	warnings = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	// Restore write permission BEFORE clearing the root override, and only on directories this
	// test created. Resolving a provider dir after `setRoot(undefined)` resolves it under the
	// developer's real config root, which the real-data tripwire correctly refuses to chmod.
	for (const dir of restoreModeOn.splice(0)) await fs.chmod(dir, 0o700).catch(() => {});
	__providerInFlightForTesting.setRoot(undefined);
	await fs.rm(limiterRoot, { recursive: true, force: true });
});

describe("releasing a stale lock keyed on mtime", () => {
	it("reports the leftover directory, the lock kind, and the wait the next request will pay", async () => {
		if (!canRestrictAccess()) return;
		const lockDir = await makeLockDir("anthropic", { ageMs: WELL_PAST_STALE_MS });
		const release = await __providerInFlightForTesting.captureStaleLockRelease("anthropic");
		expect(release).not.toBeNull();
		await denyWrites(path.dirname(lockDir));

		await release?.();

		const reported = leaks();
		expect(reported.length).toBe(1);
		expect(reported[0]?.lockDir).toBe(lockDir);
		expect(reported[0]?.lock).toBe("stale lock");
		// The timeout is in the warning because it is the size of the damage: without it the
		// reader knows something leaked but not what it costs.
		expect(reported[0]?.staleAfterMs).toBe(10_000);
		expect(String(reported[0]?.error)).toContain("EACCES");

		// And the leak is real, not just reported: the directory that gates the provider is
		// still there after the release returned normally.
		expect(await fs.stat(lockDir).then(stat => stat.isDirectory())).toBe(true);
	});

	it("says nothing when another process released the same lock first", async () => {
		// The load-bearing silence. Two processes racing to clear one stale lock is the case
		// these helpers exist for, and the loser's ENOENT is a success, not a leak.
		const lockDir = await makeLockDir("openai", { ageMs: WELL_PAST_STALE_MS });
		const release = await __providerInFlightForTesting.captureStaleLockRelease("openai");
		expect(release).not.toBeNull();
		await fs.rm(lockDir, { recursive: true, force: true });

		await release?.();

		expect(leaks()).toEqual([]);
	});

	it("says nothing on the ordinary release, where the directory does come away", async () => {
		const lockDir = await makeLockDir("google", { ageMs: WELL_PAST_STALE_MS });
		const release = await __providerInFlightForTesting.captureStaleLockRelease("google");

		await release?.();

		expect(await fs.exists(lockDir)).toBe(false);
		expect(leaks()).toEqual([]);
	});
});

describe("releasing a lease this process holds", () => {
	it("reports the leak and names it as the process's own lock", async () => {
		// Distinguished from the stale path in the warning because the two mean different
		// things: this one is a lock we took and failed to give back, which will happen again
		// on every request until the permission is fixed.
		if (!canRestrictAccess()) return;
		const lockDir = await makeLockDir("anthropic", { lease: "token-under-test" });
		const release = await __providerInFlightForTesting.captureStaleLockRelease("anthropic");
		expect(release).not.toBeNull();
		await denyWrites(path.dirname(lockDir));

		await release?.();

		const reported = leaks();
		expect(reported.length).toBe(1);
		expect(reported[0]?.lock).toBe("own lock");
		expect(reported[0]?.lockDir).toBe(lockDir);
		expect(String(reported[0]?.error)).toContain("EACCES");
	});

	it("says nothing when the lease belongs to a newer holder", async () => {
		// A token mismatch means another process already replaced the lock, so leaving it alone
		// is correct and there is nothing to report. Reporting it would fire on every healthy
		// hand-off and make the real leak unfindable.
		const lockDir = await makeLockDir("openai", { lease: "old-token" });
		const release = await __providerInFlightForTesting.captureStaleLockRelease("openai");
		await fs.writeFile(
			path.join(lockDir, "info.json"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "brand-new-token" }),
		);

		await release?.();

		expect(leaks()).toEqual([]);
		expect(await fs.exists(lockDir)).toBe(true);
	});
});

describe("releasing an unclaimed lock directory", () => {
	it("reports the leak and names it as an unclaimed directory", async () => {
		// The third path: a lock directory with no lease info at all, matched by dev/ino so a
		// replacement directory is not deleted out from under its new owner.
		if (!canRestrictAccess()) return;
		const lockDir = await makeLockDir("anthropic");
		const release = await __providerInFlightForTesting.captureLockDirRelease("anthropic");
		expect(release).not.toBeNull();
		await denyWrites(path.dirname(lockDir));

		await release?.();

		const reported = leaks();
		expect(reported.length).toBe(1);
		expect(reported[0]?.lock).toBe("unclaimed lock dir");
		expect(reported[0]?.lockDir).toBe(lockDir);
	});

	it("says nothing when the directory was replaced by a different one", async () => {
		// The identity check fires, not the error path, so this is a deliberate no-op rather
		// than a failure.
		const lockDir = await makeLockDir("google");
		const release = await __providerInFlightForTesting.captureLockDirRelease("google");
		await fs.rm(lockDir, { recursive: true, force: true });
		await fs.mkdir(lockDir, { recursive: true });

		await release?.();

		expect(leaks()).toEqual([]);
	});
});
