import { afterAll, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __internalsForTesting, withFileLock, withFileLockSync } from "../src/file-lock";
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

		const token = await tryAcquireLock(lockPath);
		expect(token).not.toBeNull();
		expect(typeof token).toBe("string");

		// A contender that lost a race calling release with a guessed/empty token
		// must NOT remove the rightful owner's lock.
		await releaseLock(lockPath, "not-the-real-token");

		const info = await readLockInfo(lockPath);
		expect(info).not.toBeNull();
		expect(info?.token).toBe(token!);

		// The rightful owner can still release.
		await releaseLock(lockPath, token!);
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

		const token = tryAcquireLockSync(lockPath);
		expect(token).not.toBeNull();
		expect(typeof token).toBe("string");

		// A second sync acquire on a held lock returns null (EEXIST), never a token.
		expect(tryAcquireLockSync(lockPath)).toBeNull();

		const info = readLockInfoSync(lockPath);
		expect(info?.token).toBe(token!);
		expect(info?.pid).toBe(process.pid);

		// Wrong-token release is a no-op; right-token release clears the lock.
		releaseLockSync(lockPath, "not-the-real-token");
		expect(readLockInfoSync(lockPath)?.token).toBe(token!);
		releaseLockSync(lockPath, token!);
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
