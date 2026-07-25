/**
 * GC's write-grace window is configurable, floored, and separate from the lock breaker.
 *
 * WHY THIS SUITE EXISTS. The grace is what stops GC from deleting a blob or archiving a session that a
 * running veyyon is still writing to: nothing younger than the window is touched. It was a hardcoded
 * five minutes while the retention knob right beside it (`gc.coldArchiveAfterDays`) was already both a
 * setting and a flag, so an operator could tune how long sessions are kept but not how much slack GC
 * leaves for live writes.
 *
 * Making it configurable puts a data-loss window under user control, so the floor is asserted as hard as
 * the knob. A grace of zero reads like "sweep everything" and would actually mean deleting a blob a
 * session wrote a second ago; the floor is one minute, the clamp is REPORTED rather than silent, because
 * an operator who set `0` and saw nothing in the log would believe a value that is not in effect.
 *
 * The lock breaker used the SAME constant for a different question -- "is the process holding this lock
 * gone" rather than "might something still be writing this file" -- so shortening the grace would also
 * have made GC steal live locks from concurrent runs. It has its own constant now, and this suite pins
 * that the two are independent.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@veyyon/coding-agent/cli/gc-cli";
import { logger, MINUTE_MS, removeSyncWithRetries, Snowflake } from "@veyyon/utils";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
});

/** An agent dir holding one session that references no blobs, plus `count` unreferenced blobs. */
async function agentDirWithBlobs(count: number, ageMs: number): Promise<{ agentDir: string; blobDir: string }> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), `vey-gc-grace-${Snowflake.next()}-`));
	tempDirs.push(agentDir);
	const sessionsDir = path.join(agentDir, "sessions");
	const blobDir = path.join(agentDir, "blobs");
	await fs.mkdir(sessionsDir, { recursive: true });
	await fs.mkdir(blobDir, { recursive: true });
	// A session that references nothing, so every blob below is a deletion candidate.
	await fs.writeFile(path.join(sessionsDir, "session.jsonl"), `${JSON.stringify({ type: "message", id: "a" })}\n`);

	const when = new Date(Date.now() - ageMs);
	for (let i = 0; i < count; i++) {
		const hash = `${i}`.padStart(64, "0");
		const file = path.join(blobDir, hash);
		await fs.writeFile(file, "blob contents");
		await fs.utimes(file, when, when);
	}
	return { agentDir, blobDir };
}

/** A dry-run blob sweep, which reports what it WOULD delete without touching anything. */
async function sweep(agentDir: string, writeGraceMinutes?: number) {
	return runGcCommand({ flags: { agentDir, blobs: true, json: true, writeGraceMinutes } });
}

describe("the write-grace window", () => {
	/**
	 * The premise: within the default window a blob is left alone no matter how unreferenced it is. This
	 * is the protection the floor exists to preserve.
	 */
	it("leaves a blob written a minute ago alone under the five-minute default", async () => {
		const { agentDir } = await agentDirWithBlobs(3, MINUTE_MS);

		const result = await sweep(agentDir);

		expect(result.blobs?.candidates).toBe(3);
		expect(result.blobs?.wouldDelete).toBe(0);
	});

	it("sweeps a blob older than the default window", async () => {
		const { agentDir } = await agentDirWithBlobs(3, 10 * MINUTE_MS);

		const result = await sweep(agentDir);

		expect(result.blobs?.wouldDelete).toBe(3);
	});

	/**
	 * THE knob. A two-minute grace has to actually shorten the window, or the setting is decoration: the
	 * same three-minute-old blobs are kept at the default and swept at two minutes.
	 */
	it("is what decides, so a shorter window sweeps blobs the default keeps", async () => {
		const { agentDir } = await agentDirWithBlobs(2, 3 * MINUTE_MS);

		expect((await sweep(agentDir)).blobs?.wouldDelete).toBe(0);
		expect((await sweep(agentDir, 2)).blobs?.wouldDelete).toBe(2);
	});

	it("can be lengthened, so a longer window keeps blobs the default would sweep", async () => {
		const { agentDir } = await agentDirWithBlobs(2, 10 * MINUTE_MS);

		expect((await sweep(agentDir)).blobs?.wouldDelete).toBe(2);
		expect((await sweep(agentDir, 60)).blobs?.wouldDelete).toBe(0);
	});
});

describe("the floor under the window", () => {
	/**
	 * Zero is the value that removes the protection entirely, and it is the one an operator reaches for
	 * when they want a sweep to be thorough. It is clamped to one minute, so a blob written seconds ago
	 * survives even when the configuration says not to wait at all.
	 */
	it("keeps a freshly written blob even when the window is set to zero", async () => {
		const { agentDir } = await agentDirWithBlobs(2, 1_000);

		const result = await sweep(agentDir, 0);

		expect(result.blobs?.candidates).toBe(2);
		expect(result.blobs?.wouldDelete).toBe(0);
	});

	it("reports the clamp instead of substituting the floor in silence", async () => {
		const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
		vi.spyOn(logger, "warn").mockImplementation(((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields });
		}) as unknown as typeof logger.warn);
		const { agentDir } = await agentDirWithBlobs(1, 1_000);

		await sweep(agentDir, 0);

		const clamp = warnings.find(entry => entry.message.includes("write-grace window is below the floor"));
		expect(clamp).toBeDefined();
		expect(clamp?.fields).toMatchObject({ requestedMinutes: 0, floorMinutes: 1 });
	});

	it("accepts the floor itself without complaint", async () => {
		const warnings: string[] = [];
		vi.spyOn(logger, "warn").mockImplementation(((message: string) => {
			warnings.push(message);
		}) as unknown as typeof logger.warn);
		const { agentDir } = await agentDirWithBlobs(1, 5 * MINUTE_MS);

		const result = await sweep(agentDir, 1);

		expect(result.blobs?.wouldDelete).toBe(1);
		expect(warnings.filter(message => message.includes("write-grace"))).toEqual([]);
	});

	/** A negative window is a typo, not a request for a shorter one, and lands on the same floor. */
	it("clamps a negative window to the floor as well", async () => {
		const { agentDir } = await agentDirWithBlobs(2, 1_000);

		expect((await sweep(agentDir, -30)).blobs?.wouldDelete).toBe(0);
	});
});

describe("the lock breaker's own window", () => {
	/**
	 * The two used to be one constant. They answer different questions, so a short grace must not shorten
	 * how long GC waits before breaking another run's lock -- that would turn a thorough sweep into two
	 * GC runs deleting each other's candidates.
	 *
	 * Asserted on the source, because reaching the breaker needs a live lock from another process. The
	 * shape is what matters: the breaker names its own constant and the grace names none.
	 */
	it("is a separate constant from the write grace", async () => {
		const source = await Bun.file(path.join(import.meta.dir, "../src/cli/gc-cli.ts")).text();

		expect(source).toContain("const GC_LOCK_STALE_MS");
		expect(source).toContain("ageFromMs > GC_LOCK_STALE_MS");
		// And the grace is read from the resolved options, never from a module constant.
		expect(source).toContain("Date.now() - options.writeGraceMs");
		expect(source).not.toContain("Date.now() - GC_WRITE_GRACE_MS");
	});
});
