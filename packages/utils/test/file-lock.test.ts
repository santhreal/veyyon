import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __internalsForTesting, tryWithFileLock, withFileLock, withFileLockSync } from "../src/file-lock";
import { getProcessStartIdentity } from "../src/process-liveness";
import { removeWithRetries } from "../src/temp";

const {
	tryAcquireLock,
	releaseLock,
	readLockInfo,
	isLockStale,
	getLockPath,
	tryAcquireLockSync,
	releaseLockSync,
	readLockInfoSync,
	isLockStaleSync,
} = __internalsForTesting;

const ROOTS: string[] = [];

async function mkRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filelock-test-"));
	ROOTS.push(root);
	return root;
}

function ownerInfo(
	overrides: Partial<{
		pid: number;
		timestamp: number;
		token: string;
		processIdentity: string | null;
	}> = {},
) {
	return {
		version: 1 as const,
		pid: process.pid,
		timestamp: Date.now(),
		token: randomUUID(),
		processIdentity: getProcessStartIdentity(process.pid),
		...overrides,
	};
}

afterAll(async () => {
	for (const root of ROOTS) {
		await removeWithRetries(root).catch(() => {});
	}
});

describe("file-lock token ownership (F1)", () => {
	test("releaseLock with the wrong token leaves the lock intact", async () => {
		const root = await mkRoot();
		const target = path.join(root, "data.json");
		const lockPath = getLockPath(target);

		const lease = await tryAcquireLock(lockPath);
		expect(lease).not.toBeNull();
		if (lease === null) throw new Error("lock acquisition unexpectedly failed");

		// A contender that lost a race calling release with a guessed token must
		// not remove the rightful owner's pinned directory and owner record.
		await releaseLock(lockPath, randomUUID());
		expect((await readLockInfo(lockPath))?.token).toBe(lease.token);

		await releaseLock(lockPath, lease);
		expect(await readLockInfo(lockPath)).toBeNull();
	});

	test("isLockStale does NOT declare a freshly-created empty dir stale", async () => {
		const root = await mkRoot();
		const target = path.join(root, "race.json");
		const lockPath = getLockPath(target);

		// Simulate the precise window: mkdir succeeded for the winner but the
		// info file has not been written yet.
		await fs.mkdir(lockPath);

		const stale = await isLockStale(lockPath, 10_000);
		expect(stale).toBe(false);

		await removeWithRetries(lockPath);
	});

	test("recovers an ownerless lock even when timestamp expiry is disabled", async () => {
		const root = await mkRoot();
		const target = path.join(root, "orphaned.json");
		const lockPath = getLockPath(target);
		await fs.mkdir(lockPath);
		await fs.utimes(lockPath, 0, 0);

		const result = await withFileLock(target, async () => "recovered", {
			staleMs: Number.POSITIVE_INFINITY,
			retries: 3,
			retryDelayMs: 1,
		});

		expect(result).toBe("recovered");
		expect(await readLockInfo(lockPath)).toBeNull();
	});

	test("writes a readable validated owner record", async () => {
		const root = await mkRoot();
		const target = path.join(root, "published.json");
		const lockPath = getLockPath(target);
		const lease = await tryAcquireLock(lockPath);
		if (lease === null) throw new Error("lock acquisition unexpectedly failed");

		expect(readLockInfo(lockPath)).resolves.toMatchObject({ pid: process.pid, token: lease.token, version: 1 });
		await releaseLock(lockPath, lease);
	});

	test("withFileLock serializes N concurrent writers without lost updates", async () => {
		const root = await mkRoot();
		const target = path.join(root, "counter.json");
		await fs.writeFile(target, JSON.stringify({ counter: 0 }));

		const N = 30;
		await Promise.all(
			Array.from({ length: N }, () =>
				withFileLock(
					target,
					async () => {
						const text = await fs.readFile(target, "utf-8");
						const data = JSON.parse(text) as { counter: number };
						data.counter += 1;
						// Widen the critical-section window so any concurrency leak
						// surfaces as a lost update.
						await Bun.sleep(2);
						await fs.writeFile(target, JSON.stringify(data));
					},
					{ retries: 500, retryDelayMs: 5 },
				),
			),
		);

		const text = await fs.readFile(target, "utf-8");
		const final = JSON.parse(text) as { counter: number };
		expect(final.counter).toBe(N);
	}, 30_000);
});

describe("file-lock sync twin", () => {
	test("tryAcquireLockSync writes a readable owner token then releaseLockSync clears it", async () => {
		const root = await mkRoot();
		const target = path.join(root, "sync-owner.json");
		const lockPath = getLockPath(target);

		const lease = tryAcquireLockSync(lockPath);
		expect(lease).not.toBeNull();
		if (lease === null) throw new Error("sync lock acquisition unexpectedly failed");

		expect(tryAcquireLockSync(lockPath)).toBeNull();
		expect(readLockInfoSync(lockPath)?.token).toBe(lease.token);
		expect(readLockInfoSync(lockPath)?.pid).toBe(process.pid);

		releaseLockSync(lockPath, randomUUID());
		expect(readLockInfoSync(lockPath)?.token).toBe(lease.token);
		releaseLockSync(lockPath, lease);
		expect(readLockInfoSync(lockPath)).toBeNull();
	});

	test("isLockStaleSync does NOT declare a freshly-created empty dir stale", async () => {
		const root = await mkRoot();
		const target = path.join(root, "sync-race.json");
		const lockPath = getLockPath(target);

		await fs.mkdir(lockPath);
		expect(isLockStaleSync(lockPath, 10_000)).toBe(false);
		await removeWithRetries(lockPath);
	});

	test("sync acquisition recovers an ownerless lock with infinite staleMs", async () => {
		const root = await mkRoot();
		const target = path.join(root, "sync-orphaned.json");
		const lockPath = getLockPath(target);
		await fs.mkdir(lockPath);
		fsSync.utimesSync(lockPath, 0, 0);

		expect(
			withFileLockSync(target, () => "recovered", {
				staleMs: Number.POSITIVE_INFINITY,
				retries: 3,
				retryDelayMs: 1,
			}),
		).toBe("recovered");
		expect(readLockInfoSync(lockPath)).toBeNull();
	});

	test("withFileLockSync returns the function result and releases the lock", async () => {
		const root = await mkRoot();
		const target = path.join(root, "sync-result.json");
		const lockPath = getLockPath(target);

		const result = withFileLockSync(target, () => 42);
		expect(result).toBe(42);
		// The lock directory is gone after the critical section.
		expect(readLockInfoSync(lockPath)).toBeNull();
	});

	test("withFileLockSync releases the lock even when fn throws", async () => {
		const root = await mkRoot();
		const target = path.join(root, "sync-throw.json");
		const lockPath = getLockPath(target);

		expect(() =>
			withFileLockSync(target, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(readLockInfoSync(lockPath)).toBeNull();
	});
});

// The sync and async locks share one on-disk layout, so they mutually exclude
// on `${path}.lock`. Live blocking contention (one waits while the other holds)
// only works ACROSS processes: a sync waiter's sleepSync freezes its own event
// loop, so within a single thread it cannot wait for an async holder to
// release. The tryAcquire probes below assert the disk-level exclusion without
// triggering that same-thread deadlock.
describe("file-lock sync/async mutual exclusion", () => {
	test("a held async lock blocks a sync acquire on the same path", async () => {
		const root = await mkRoot();
		const target = path.join(root, "cross.json");
		const lockPath = getLockPath(target);

		// Hold the async lock, then prove a sync acquire cannot take it.
		const asyncToken = await tryAcquireLock(lockPath);
		expect(asyncToken).not.toBeNull();

		expect(tryAcquireLockSync(lockPath)).toBeNull();

		await releaseLock(lockPath, asyncToken!);

		// Once released, the sync path can take it.
		const syncToken = tryAcquireLockSync(lockPath);
		expect(syncToken).not.toBeNull();
		releaseLockSync(lockPath, syncToken!);
	});

	test("a held sync lock blocks an async acquire on the same path", async () => {
		const root = await mkRoot();
		const target = path.join(root, "cross2.json");
		const lockPath = getLockPath(target);

		const syncToken = tryAcquireLockSync(lockPath);
		expect(syncToken).not.toBeNull();

		expect(await tryAcquireLock(lockPath)).toBeNull();

		releaseLockSync(lockPath, syncToken!);
	});

	test("N concurrent sync writers do not lose updates", () => {
		// Same-thread sync writers never overlap (each blocks to completion), but
		// this proves the sync lock's read-modify-write is a correct critical
		// section: every writer sees the prior writer's committed value.
		const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "filelock-sync-"));
		ROOTS.push(root);
		const target = path.join(root, "sync-counter.json");
		fsSync.writeFileSync(target, JSON.stringify({ counter: 0 }));

		const N = 25;
		for (let i = 0; i < N; i++) {
			withFileLockSync(target, () => {
				const data = JSON.parse(fsSync.readFileSync(target, "utf-8")) as { counter: number };
				data.counter += 1;
				fsSync.writeFileSync(target, JSON.stringify(data));
			});
		}

		const final = JSON.parse(fsSync.readFileSync(target, "utf-8")) as { counter: number };
		expect(final.counter).toBe(N);
	});
});

describe("tryWithFileLock", () => {
	test("runs fn and returns its value when the lock is free", async () => {
		const root = await mkRoot();
		const target = path.join(root, "free.json");

		const result = await tryWithFileLock(target, async () => 42);

		expect(result).toEqual({ acquired: true, value: 42 });
	});

	test("does not run fn while another holder has the lock", async () => {
		// The property that makes this usable for background work: a second
		// process gets out of the way instead of duplicating the work. Launching
		// the same program in three terminals must not run one-time startup work
		// three times.
		const root = await mkRoot();
		const target = path.join(root, "held.json");
		let ran = 0;

		const result = await withFileLock(target, async () =>
			tryWithFileLock(target, async () => {
				ran += 1;
				return "inner";
			}),
		);

		expect(result).toEqual({ acquired: false });
		expect(ran).toBe(0);
	});

	test("exactly one of many concurrent callers runs fn", async () => {
		const root = await mkRoot();
		const target = path.join(root, "concurrent.json");
		let ran = 0;

		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				tryWithFileLock(target, async () => {
					ran += 1;
					// Hold the lock long enough that the other callers must contend.
					await Bun.sleep(20);
					return ran;
				}),
			),
		);

		expect(ran).toBe(1);
		expect(results.filter(r => r.acquired)).toHaveLength(1);
	});

	test("releases the lock so a later caller can acquire it", async () => {
		const root = await mkRoot();
		const target = path.join(root, "sequential.json");

		expect((await tryWithFileLock(target, async () => "first")).acquired).toBe(true);
		expect(await tryWithFileLock(target, async () => "second")).toEqual({ acquired: true, value: "second" });
	});

	test("releases the lock when fn throws", async () => {
		// A crash inside the critical section must not wedge the lock for the
		// staleMs window, which for long-running work is deliberately minutes.
		const root = await mkRoot();
		const target = path.join(root, "throws.json");

		await expect(
			tryWithFileLock(target, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect((await tryWithFileLock(target, async () => "after")).acquired).toBe(true);
	});

	test("reaps a lock held by a dead process and then takes it", async () => {
		const root = await mkRoot();
		const target = path.join(root, "dead-owner.json");
		const lockPath = getLockPath(target);
		await fs.mkdir(lockPath);
		// pid 1 is alive, so use a pid that cannot be: liveness is what decides.
		await Bun.write(`${lockPath}/info`, JSON.stringify(ownerInfo({ pid: 0x7fffffff, processIdentity: null })));

		const result = await tryWithFileLock(target, async () => "reaped");

		expect(result).toEqual({ acquired: true, value: "reaped" });
	});

	test("a delayed stale reaper cannot delete the lock that replaced its observation", async () => {
		const root = await mkRoot();
		const target = path.join(root, "delayed-reaper.json");
		const lockPath = getLockPath(target);
		await fs.mkdir(lockPath);
		const deadOwner = ownerInfo({ pid: 0x7fffffff, processIdentity: null });
		await fs.writeFile(path.join(lockPath, "info"), JSON.stringify(deadOwner));

		// Both contenders observe the same dead owner. A reaps it and acquires;
		// B then resumes from its stale observation. Reaping with no/guessed
		// ownership token would erase A's live lock here.
		expect(await isLockStale(lockPath, Number.POSITIVE_INFINITY)).toBe(true);
		expect(await isLockStale(lockPath, Number.POSITIVE_INFINITY)).toBe(true);
		const staleObservation = await __internalsForTesting.inspectLockDirectory(lockPath);
		if (staleObservation === null) throw new Error("stale lock observation unexpectedly absent");
		await __internalsForTesting.retireObservedLock(lockPath, staleObservation, {
			kind: "stale",
			staleMs: Number.POSITIVE_INFINITY,
		});
		const freshLease = await tryAcquireLock(lockPath);
		if (freshLease === null) throw new Error("fresh lock acquisition unexpectedly failed");

		// Resume the second reaper with the exact old inode observation. It must
		// refuse the replacement owner rather than applying pathname-only rm.
		await __internalsForTesting.retireObservedLock(lockPath, staleObservation, {
			kind: "stale",
			staleMs: Number.POSITIVE_INFINITY,
		});
		expect((await readLockInfo(lockPath))?.token).toBe(freshLease.token);
		await releaseLock(lockPath, freshLease);
	});

	/** Regression: wall age must never let an async contender steal from the same live process incarnation. */
	test("does not reap a live async holder even when its timestamp exceeds staleMs", async () => {
		const root = await mkRoot();
		const target = path.join(root, "aged-live-async.json");
		const lockPath = getLockPath(target);
		let contenderRan = false;

		await withFileLock(target, async () => {
			const infoPath = path.join(lockPath, "info");
			const info = JSON.parse(await fs.readFile(infoPath, "utf8")) as Record<string, unknown>;
			await fs.writeFile(infoPath, JSON.stringify({ ...info, timestamp: 0 }));
			expect(
				await tryWithFileLock(
					target,
					async () => {
						contenderRan = true;
					},
					{ staleMs: 0 },
				),
			).toEqual({ acquired: false });
		});
		expect(contenderRan).toBe(false);
	});

	/** The synchronous twin must preserve a long-running live holder even at the zero timeout boundary. */
	test("does not reap a live sync holder even when its timestamp exceeds staleMs", async () => {
		const root = await mkRoot();
		const target = path.join(root, "aged-live-sync.json");
		const lockPath = getLockPath(target);
		let contenderRan = false;

		expect(
			withFileLockSync(target, () => {
				const infoPath = path.join(lockPath, "info");
				const info = JSON.parse(fsSync.readFileSync(infoPath, "utf8")) as Record<string, unknown>;
				fsSync.writeFileSync(infoPath, JSON.stringify({ ...info, timestamp: 0 }));
				expect(() =>
					withFileLockSync(
						target,
						() => {
							contenderRan = true;
						},
						{ staleMs: 0, retries: 1, retryDelayMs: 0 },
					),
				).toThrow("Failed to acquire lock");
				return "holder-finished";
			}),
		).toBe("holder-finished");
		expect(contenderRan).toBe(false);
	});

	/** Proven dead and reused owners remain positively recoverable by the synchronous lifecycle. */
	test("sync acquisition reaps dead and PID-reused infinite-lease owners", async () => {
		for (const [name, info] of [
			["dead", ownerInfo({ pid: 0x7fffffff, processIdentity: null })],
			["reused", ownerInfo({ processIdentity: "linux:00000000-0000-0000-0000-000000000000:1" })],
		] as const) {
			const root = await mkRoot();
			const target = path.join(root, `${name}-sync.json`);
			const lockPath = getLockPath(target);
			fsSync.mkdirSync(lockPath);
			fsSync.writeFileSync(path.join(lockPath, "info"), JSON.stringify(info));
			expect(
				withFileLockSync(target, () => `${name}-recovered`, {
					staleMs: Number.POSITIVE_INFINITY,
					retries: 2,
					retryDelayMs: 0,
				}),
			).toBe(`${name}-recovered`);
		}
	});
});
