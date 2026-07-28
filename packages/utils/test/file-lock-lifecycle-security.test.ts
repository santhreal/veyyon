import { afterAll, afterEach, describe, expect, test, vi } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __internalsForTesting, tryWithFileLock, withFileLock, withFileLockSync } from "../src/file-lock";
import * as logger from "../src/logger";
import {
	getProcessStartIdentity,
	isProcessInstanceAlive,
	type ProcessIdentityDependencies,
} from "../src/process-liveness";
import { removeWithRetries } from "../src/temp";

const {
	getLockPath,
	getTransitionPath,
	inspectLockDirectory,
	inspectLockDirectorySync,
	prepareCandidate,
	readLockInfo,
	readLockInfoSync,
	releaseLock,
	releaseLockSync,
	removeObservedDirectory,
	retireObservedLock,
	retireObservedLockSync,
	tryAcquireLock,
	tryAcquireLockSync,
} = __internalsForTesting;

const ROOTS: string[] = [];

async function mkTarget(name: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filelock-lifecycle-"));
	ROOTS.push(root);
	return path.join(root, name);
}

interface TestOwnerInfo {
	version: 1;
	pid: number;
	timestamp: number;
	token: string;
	processIdentity: string | null;
}

function ownerInfo(overrides: Partial<Omit<TestOwnerInfo, "version">> = {}): TestOwnerInfo {
	return {
		version: 1 as const,
		pid: process.pid,
		timestamp: Date.now(),
		token: randomUUID(),
		processIdentity: getProcessStartIdentity(process.pid),
		...overrides,
	};
}

async function writeOwnerDirectory(lockPath: string, info: TestOwnerInfo): Promise<void> {
	await fs.mkdir(lockPath);
	await fs.writeFile(path.join(lockPath, "info"), JSON.stringify(info), { mode: 0o600 });
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	for (const root of ROOTS) await removeWithRetries(root).catch(() => {});
});

describe("atomic file-lock lifecycle claims", () => {
	/** Regression: cleanup from a delayed publisher must target only its private, pinned candidate. */
	test("a stalled candidate cleanup cannot delete the owner published after ownerless recovery", async () => {
		const target = await mkTarget("publication.json");
		const lockPath = getLockPath(target);
		const candidateA = await prepareCandidate(lockPath);

		// A has a complete private candidate but has not published it. An old
		// ownerless artifact is recovered and B becomes the pathname owner.
		await fs.mkdir(lockPath);
		await fs.utimes(lockPath, 0, 0);
		const orphan = await inspectLockDirectory(lockPath);
		if (orphan === null) throw new Error("ownerless observation missing");
		expect(await retireObservedLock(lockPath, orphan, { kind: "stale", staleMs: Number.POSITIVE_INFINITY })).toBe(
			"removed",
		);
		const leaseB = await tryAcquireLock(lockPath);
		if (leaseB === null) throw new Error("replacement owner failed to publish");

		// A resumes only its pinned, unguessable candidate cleanup. B's live inode
		// and token remain untouched.
		await removeObservedDirectory(candidateA.path, candidateA.observation);
		expect((await readLockInfo(lockPath))?.token).toBe(leaseB.token);
		await releaseLock(lockPath, leaseB);
	});

	/** Regression: two reapers authorized by A's snapshot must not let the loser remove successor B. */
	test("two delayed stale reapers cannot delete the replacement observed after the first wins", async () => {
		const target = await mkTarget("dual-reaper.json");
		const lockPath = getLockPath(target);
		await writeOwnerDirectory(lockPath, ownerInfo({ pid: 0x7fffffff, processIdentity: null }));
		const barrierObservationA = await inspectLockDirectory(lockPath);
		const barrierObservationB = await inspectLockDirectory(lockPath);
		if (barrierObservationA === null || barrierObservationB === null) throw new Error("stale barrier missing");

		expect(
			await retireObservedLock(lockPath, barrierObservationA, {
				kind: "stale",
				staleMs: Number.POSITIVE_INFINITY,
			}),
		).toBe("removed");
		const replacement = await tryAcquireLock(lockPath);
		if (replacement === null) throw new Error("replacement acquisition failed");

		// The second reaper resumes beyond the deterministic barrier with the old
		// inode observation. It cannot authorize any mutation of the replacement.
		expect(
			await retireObservedLock(lockPath, barrierObservationB, {
				kind: "stale",
				staleMs: Number.POSITIVE_INFINITY,
			}),
		).toBe("changed");
		expect((await readLockInfo(lockPath))?.token).toBe(replacement.token);
		await releaseLock(lockPath, replacement);
	});

	/** Regression: A's release closure retains inode authority and cannot release B by pathname. */
	test("a displaced owner's delayed release cannot delete its async replacement", async () => {
		const target = await mkTarget("late-owner-release.json");
		const lockPath = getLockPath(target);
		const ownerA = await tryAcquireLock(lockPath);
		if (ownerA === null) throw new Error("owner A acquisition failed");
		const observedA = await inspectLockDirectory(lockPath);
		if (observedA === null) throw new Error("owner A observation missing");
		expect(
			await retireObservedLock(lockPath, observedA, {
				kind: "stale",
				staleMs: Number.POSITIVE_INFINITY,
				isOwnerAlive: () => false,
			}),
		).toBe("removed");

		const ownerB = await tryAcquireLock(lockPath);
		if (ownerB === null) throw new Error("owner B acquisition failed");
		await releaseLock(lockPath, ownerA);
		expect((await readLockInfo(lockPath))?.token).toBe(ownerB.token);
		await releaseLock(lockPath, ownerB);
	});

	/** The synchronous lifecycle must preserve the same stale-reaper and delayed-release invariant. */
	test("sync proven-dead reaper and owner-release twins preserve a replacement inode", async () => {
		const target = await mkTarget("sync-late-owner.json");
		const lockPath = getLockPath(target);
		const ownerA = tryAcquireLockSync(lockPath);
		if (ownerA === null) throw new Error("sync owner A acquisition failed");
		const observedA = inspectLockDirectorySync(lockPath);
		if (observedA === null) throw new Error("sync owner A observation missing");
		expect(
			retireObservedLockSync(lockPath, observedA, {
				kind: "stale",
				staleMs: Number.POSITIVE_INFINITY,
				isOwnerAlive: () => false,
			}),
		).toBe("removed");

		const ownerB = tryAcquireLockSync(lockPath);
		if (ownerB === null) throw new Error("sync owner B acquisition failed");
		releaseLockSync(lockPath, ownerA);
		expect(readLockInfoSync(lockPath)?.token).toBe(ownerB.token);
		releaseLockSync(lockPath, ownerB);
	});

	/** A copied secret token is insufficient authority when an attacker swapped the directory inode. */
	test("a same-token inode swap is refused by async and sync releases", async () => {
		const asyncTarget = await mkTarget("inode-swap-async.json");
		const asyncLock = getLockPath(asyncTarget);
		const asyncLease = await tryAcquireLock(asyncLock);
		if (asyncLease === null) throw new Error("async acquisition failed");
		await fs.rename(asyncLock, `${asyncLock}.displaced`);
		await writeOwnerDirectory(asyncLock, ownerInfo({ token: asyncLease.token }));
		const replacementAsync = await fs.lstat(asyncLock);
		await releaseLock(asyncLock, asyncLease);
		expect((await fs.lstat(asyncLock)).ino).toBe(replacementAsync.ino);

		const syncTarget = await mkTarget("inode-swap-sync.json");
		const syncLock = getLockPath(syncTarget);
		const syncLease = tryAcquireLockSync(syncLock);
		if (syncLease === null) throw new Error("sync acquisition failed");
		fsSync.renameSync(syncLock, `${syncLock}.displaced`);
		fsSync.mkdirSync(syncLock);
		fsSync.writeFileSync(path.join(syncLock, "info"), JSON.stringify(ownerInfo({ token: syncLease.token })));
		const replacementSync = fsSync.lstatSync(syncLock);
		releaseLockSync(syncLock, syncLease);
		expect(fsSync.lstatSync(syncLock).ino).toBe(replacementSync.ino);
	});

	/** The fixed transition claim must keep a racing publisher out of the live critical section. */
	test("a lifecycle transition blocks a third contender from entering", async () => {
		const target = await mkTarget("transition-gate.json");
		const lockPath = getLockPath(target);
		const owner = await tryAcquireLock(lockPath);
		if (owner === null) throw new Error("owner acquisition failed");
		await fs.rename(lockPath, getTransitionPath(lockPath));

		let entered = false;
		expect(
			await tryWithFileLock(target, async () => {
				entered = true;
			}),
		).toEqual({ acquired: false });
		expect(entered).toBe(false);

		await fs.rename(getTransitionPath(lockPath), lockPath);
		await releaseLock(lockPath, owner);
		expect((await tryWithFileLock(target, async () => "after")).acquired).toBe(true);
	});

	/** Baseline exclusion: a live async holder blocks entry, then hands off after its barrier opens. */
	test("an ordinary async barrier admits no contender until the holder exits", async () => {
		const target = await mkTarget("live-critical-section.json");
		let openGate: (() => void) | undefined;
		let signalEntered: (() => void) | undefined;
		const entered = new Promise<void>(resolve => {
			signalEntered = resolve;
		});
		const gate = new Promise<void>(resolve => {
			openGate = resolve;
		});
		const holder = withFileLock(target, async () => {
			signalEntered?.();
			await gate;
		});
		await entered;

		let contenderEntered = false;
		expect(
			await tryWithFileLock(target, async () => {
				contenderEntered = true;
			}),
		).toEqual({ acquired: false });
		expect(contenderEntered).toBe(false);
		openGate?.();
		await holder;
		expect(
			await tryWithFileLock(target, async () => {
				contenderEntered = true;
			}),
		).toEqual({ acquired: true, value: undefined });
		expect(contenderEntered).toBe(true);
	});

	/** Crash recovery must finish a stale transition without mistaking an active transition for dead. */
	test("a crashed stale transition is recovered after its bounded operation grace", async () => {
		const target = await mkTarget("crashed-transition.json");
		const lockPath = getLockPath(target);
		await writeOwnerDirectory(lockPath, ownerInfo({ pid: 0x7fffffff, processIdentity: null }));
		const transitionPath = getTransitionPath(lockPath);
		await fs.rename(lockPath, transitionPath);
		const transitionStat = await fs.lstat(transitionPath);

		// Drive the lifecycle clock beyond the operation grace without a timer:
		// the transition is a crash artifact, not an active release.
		vi.spyOn(Date, "now").mockReturnValue(Math.ceil(transitionStat.ctimeMs) + 1_001);
		expect(
			await tryWithFileLock(target, async () => "recovered", {
				staleMs: Number.POSITIVE_INFINITY,
			}),
		).toEqual({ acquired: true, value: "recovered" });
	});
});

describe("bounded and fail-closed owner metadata", () => {
	/** Corrupt metadata remains recoverable, while sparse oversized input proves allocation is bounded. */
	test("corrupt and oversized regular owner info recover without unbounded reads", async () => {
		for (const [name, prepare] of [
			["corrupt", async (infoPath: string) => fs.writeFile(infoPath, "{not-json")],
			["oversized", async (infoPath: string) => fs.truncate(infoPath, 128 * 1024 * 1024)],
		] as const) {
			const target = await mkTarget(`${name}.json`);
			const lockPath = getLockPath(target);
			await fs.mkdir(lockPath);
			const infoPath = path.join(lockPath, "info");
			await fs.writeFile(infoPath, "x");
			await prepare(infoPath);
			await fs.utimes(lockPath, 0, 0);
			expect((await inspectLockDirectory(lockPath))?.kind).toBe("invalid");
			expect(await tryWithFileLock(target, async () => name)).toEqual({ acquired: true, value: name });
		}
	});

	/** Adversarial links must fail closed so owner inspection or reaping cannot escape the lock directory. */
	test("symlinked and hardlinked owner info are never followed or reaped", async () => {
		for (const kind of ["symlink", "hardlink"] as const) {
			const target = await mkTarget(`${kind}.json`);
			const lockPath = getLockPath(target);
			const outside = `${target}.outside`;
			const outsideBytes = JSON.stringify(ownerInfo({ pid: 0x7fffffff, processIdentity: null }));
			await fs.writeFile(outside, outsideBytes);
			await fs.mkdir(lockPath);
			if (kind === "symlink") await fs.symlink(outside, path.join(lockPath, "info"));
			else await fs.link(outside, path.join(lockPath, "info"));
			await fs.utimes(lockPath, 0, 0);

			expect((await inspectLockDirectory(lockPath))?.kind).toBe("unsafe");
			expect(await tryWithFileLock(target, async () => "must-not-run")).toEqual({ acquired: false });
			expect(await fs.readFile(outside, "utf8")).toBe(outsideBytes);
		}
	});

	/** Exact schema validation rejects smuggled fields without sacrificing legacy ownerless recovery. */
	test("strict schema rejects extra fields while ownerless crash recovery remains available", async () => {
		const corruptTarget = await mkTarget("schema.json");
		const corruptLock = getLockPath(corruptTarget);
		await writeOwnerDirectory(corruptLock, { ...ownerInfo(), extra: true } as TestOwnerInfo);
		await fs.utimes(corruptLock, 0, 0);
		expect((await inspectLockDirectory(corruptLock))?.kind).toBe("invalid");
		expect((await tryWithFileLock(corruptTarget, async () => "strict")).acquired).toBe(true);

		const ownerlessTarget = await mkTarget("ownerless.json");
		const ownerlessLock = getLockPath(ownerlessTarget);
		await fs.mkdir(ownerlessLock);
		await fs.utimes(ownerlessLock, 0, 0);
		expect(
			await withFileLock(ownerlessTarget, async () => "recovered", {
				staleMs: Number.POSITIVE_INFINITY,
				retries: 3,
				retryDelayMs: 1,
			}),
		).toBe("recovered");
	});

	/** Infinite leases distinguish PID incarnations, while EPERM remains evidence of a live process. */
	test("an infinite lease detects PID reuse but treats EPERM as live", async () => {
		const reusedTarget = await mkTarget("pid-reuse.json");
		const reusedLock = getLockPath(reusedTarget);
		await writeOwnerDirectory(
			reusedLock,
			ownerInfo({ processIdentity: "linux:00000000-0000-0000-0000-000000000000:1" }),
		);
		expect(await tryWithFileLock(reusedTarget, async () => "reused", { staleMs: Number.POSITIVE_INFINITY })).toEqual({
			acquired: true,
			value: "reused",
		});

		const epermTarget = await mkTarget("eperm.json");
		const epermLock = getLockPath(epermTarget);
		await writeOwnerDirectory(epermLock, ownerInfo({ pid: 4242, processIdentity: null }));
		const kill = process.kill;
		try {
			process.kill = () => {
				const error = new Error("permission denied") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			};
			expect(
				await tryWithFileLock(epermTarget, async () => "must-not-run", {
					staleMs: Number.POSITIVE_INFINITY,
				}),
			).toEqual({ acquired: false });
		} finally {
			process.kill = kill;
		}
	});

	/** macOS and Windows abstractions must reap a reused-PID orphan without stealing a matching live owner. */
	test("platform process identities authorize infinite-lease recovery only after PID reuse", async () => {
		let darwinStart = "1672628645.123456";
		let windowsStart = "133485518451234560";
		const cases: Array<{
			name: string;
			dependencies: ProcessIdentityDependencies;
			reuse(): void;
		}> = [
			{
				name: "darwin",
				dependencies: {
					platform: "darwin",
					readBoundedTextFile: () => null,
					querySystem: executable =>
						executable === "/usr/sbin/sysctl" ? "{ sec = 1670000000, usec = 123456 }" : null,
					queryDarwinProcessStart: () => darwinStart,
					queryWindowsProcessStart: () => null,
				},
				reuse: () => {
					darwinStart = "1672715045.123456";
				},
			},
			{
				name: "win32",
				dependencies: {
					platform: "win32",
					readBoundedTextFile: () => null,
					querySystem: () => null,
					queryDarwinProcessStart: () => null,
					queryWindowsProcessStart: () => windowsStart,
				},
				reuse: () => {
					windowsStart = "133485518461234560";
				},
			},
		];
		const kill = process.kill;
		try {
			process.kill = () => true;
			for (const scenario of cases) {
				const target = await mkTarget(`${scenario.name}-infinite-reuse.json`);
				const lockPath = getLockPath(target);
				const ownerIdentity = getProcessStartIdentity(process.pid, scenario.dependencies);
				if (ownerIdentity === null) throw new Error(`${scenario.name} identity fixture was invalid`);
				await writeOwnerDirectory(lockPath, ownerInfo({ processIdentity: ownerIdentity }));
				const observation = await inspectLockDirectory(lockPath);
				if (observation === null) throw new Error(`${scenario.name} lock observation missing`);
				const originalInode = (await fs.lstat(lockPath)).ino;
				const isOwnerAlive = (pid: number, identity: string | null) =>
					isProcessInstanceAlive(pid, identity, scenario.dependencies);

				expect(
					await retireObservedLock(lockPath, observation, {
						kind: "stale",
						staleMs: Number.POSITIVE_INFINITY,
						isOwnerAlive,
					}),
				).toBe("not-authorized");
				expect((await fs.lstat(lockPath)).ino).toBe(originalInode);

				scenario.reuse();
				expect(
					await retireObservedLock(lockPath, observation, {
						kind: "stale",
						staleMs: Number.POSITIVE_INFINITY,
						isOwnerAlive,
					}),
				).toBe("removed");
				expect(
					await tryWithFileLock(target, async () => "recovered", {
						staleMs: Number.POSITIVE_INFINITY,
					}),
				).toEqual({ acquired: true, value: "recovered" });
			}
		} finally {
			process.kill = kill;
		}
	});
});

describe("release diagnostics and option boundaries", () => {
	/** Release failures are actionable only if reported, and untrusted diagnostic fields must be inert. */
	test("release failure is reported with terminal-safe path and error fields", async () => {
		const target = await mkTarget("unsafe\u001b\u202Ename.json");
		const warnings: Array<Record<string, unknown>> = [];
		vi.spyOn(logger, "warn").mockImplementation((_message, fields) => warnings.push(fields ?? {}));

		await withFileLock(target, async () => {
			await fs.writeFile(path.join(getLockPath(target), "unexpected"), "blocks-rmdir");
		});
		expect(warnings).toHaveLength(1);
		const lockPathField = String(warnings[0]?.lockPath);
		const errorField = String(warnings[0]?.error);
		expect(lockPathField).toContain("\\u001B");
		expect(lockPathField).toContain("\\u202E");
		expect(lockPathField).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/u);
		expect(errorField).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/u);
	});

	/** Acquisition failures must not inject control sequences through a hostile pathname. */
	test("escaped acquisition errors contain no raw terminal controls", async () => {
		const target = await mkTarget("blocked\n\u001b\u202E.json");
		await fs.symlink(`${target}.elsewhere`, getLockPath(target));
		let message = "";
		try {
			await withFileLock(target, async () => undefined, { retries: 1, retryDelayMs: 0 });
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("\\u000A");
		expect(message).toContain("\\u001B");
		expect(message).toContain("\\u202E");
		expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/u);
	});

	/** Invalid retry/lease boundaries must fail deterministically before guarded work can execute. */
	test("invalid retry and timeout boundaries fail before the callback", async () => {
		let ran = false;
		const target = await mkTarget("boundaries.json");
		for (const options of [
			{ retries: 0 },
			{ retries: 1.5 },
			{ retryDelayMs: Number.POSITIVE_INFINITY },
			{ retryDelayMs: -1 },
			{ staleMs: -1 },
			{ staleMs: Number.NaN },
		]) {
			await expect(
				withFileLock(
					target,
					async () => {
						ran = true;
					},
					options,
				),
			).rejects.toThrow();
		}
		expect(ran).toBe(false);
	});

	/** Baseline sync behavior guards against security hardening breaking ordinary result/release semantics. */
	test("ordinary sync exclusion, result, and release remain intact", async () => {
		const target = await mkTarget("ordinary-sync.json");
		let entries = 0;
		const values = Array.from({ length: 20 }, (_, index) =>
			withFileLockSync(target, () => {
				entries += 1;
				return index;
			}),
		);
		expect(entries).toBe(20);
		expect(values).toEqual(Array.from({ length: 20 }, (_, index) => index));
		expect(readLockInfoSync(getLockPath(target))).toBeNull();
	});
});
