/**
 * A provider in-flight lease whose heartbeat keeps failing must say so, because the concurrency guard is
 * about to fail OPEN.
 *
 * WHY THIS SUITE EXISTS. `stream.ts` limits concurrent requests per provider with a lease DIRECTORY holding
 * an `info.json` that a 5s heartbeat rewrites. Another process reclaims a lease whose timestamp is older than
 * `PROVIDER_INFLIGHT_LEASE_STALE_MS` (30s), on the reasonable assumption that its owner died. The heartbeat
 * chain ended in `.catch(() => {})`, so a heartbeat that could not write -- a full disk, a read-only state
 * directory, the lease directory removed underneath it -- wrote nothing and reported nothing. Thirty seconds
 * later the lease looked abandoned, another process treated this STILL-RUNNING request as dead and proceeded,
 * and the in-flight limit was silently exceeded while the operator believed it was being enforced. A guard
 * that fails open with no record is worse than no guard, because it is trusted.
 *
 * What this suite pins is the shape of the report, not just its existence. A single failed beat must stay
 * SILENT: transient write failures are normal and the next beat repairs them, so warning on the first one
 * would train operators to ignore the message. The warning arrives only once the run of failures is long
 * enough to have the effect that matters -- `ceil(30s / 5s)` = 6 consecutive misses -- and it arrives ONCE,
 * not on every subsequent beat. Recovery is reported too, so a log that showed the warning does not leave the
 * reader wondering whether it ever came back.
 *
 * The failure is produced the way it actually happens: the lease directory is made unwritable, which is what
 * a config root with changed permissions (restrictive umask, container running as another uid, a synced home)
 * looks like from here. Beats are driven directly through the test seam rather than by waiting out six 5s
 * intervals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __providerInFlightForTesting } from "@veyyon/ai/stream";
import { logger } from "@veyyon/utils";

const STALE_RISK_MESSAGE =
	"Provider in-flight lease heartbeat keeps failing; another process may treat this request as dead and exceed the in-flight limit";
const RECOVERED_MESSAGE = "Provider in-flight lease heartbeat recovered";

/** `ceil(PROVIDER_INFLIGHT_LEASE_STALE_MS / PROVIDER_INFLIGHT_HEARTBEAT_MS)` in stream.ts: 30s / 5s. */
const BEATS_BEFORE_STALE = 6;

let limiterRoot: string;
/** Directories this test made read-only, restored in `afterEach` so cleanup can remove them. */
const restoreModeOn: string[] = [];
let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

/** Mode bits do not restrict root, and Windows does not honour them at all. */
function canRestrictAccess(): boolean {
	return process.platform !== "win32" && process.getuid?.() !== 0;
}

async function denyWrites(dir: string): Promise<void> {
	await fs.chmod(dir, 0o500);
	restoreModeOn.push(dir);
}

async function allowWrites(dir: string): Promise<void> {
	await fs.chmod(dir, 0o700);
}

function warningsNamed(message: string): Array<Record<string, unknown>> {
	return warnings.filter(entry => entry.message === message).map(entry => entry.fields);
}

beforeEach(async () => {
	limiterRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-inflight-heartbeat-"));
	__providerInFlightForTesting.setRoot(limiterRoot);
	warnings = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	// Restore write permission BEFORE clearing the root override: resolving a provider dir after
	// `setRoot(undefined)` resolves it under the developer's real config root.
	for (const dir of restoreModeOn.splice(0)) await fs.chmod(dir, 0o700).catch(() => {});
	__providerInFlightForTesting.setRoot(undefined);
	await fs.rm(limiterRoot, { recursive: true, force: true });
});

describe("a heartbeat that fails a few times", () => {
	/**
	 * The deliberate silence. One or two failed writes do not put the lease at risk, and warning on them would
	 * make the message meaningless by the time it matters.
	 */
	it("says nothing before the run is long enough to make the lease stale", async () => {
		if (!canRestrictAccess()) return;
		const lease = await __providerInFlightForTesting.acquireLease("anthropic", 4);
		expect(lease).not.toBeNull();
		await denyWrites(lease?.path as string);

		for (let beat = 0; beat < BEATS_BEFORE_STALE - 1; beat++) await lease?.beat();

		expect(warningsNamed(STALE_RISK_MESSAGE)).toEqual([]);
		await allowWrites(lease?.path as string);
		await lease?.release();
	});
});

describe("a heartbeat that keeps failing", () => {
	/**
	 * The regression. Six consecutive misses is exactly the run that lets the lease age past the stale
	 * threshold, so this is the beat on which the guard becomes unreliable and the operator must hear about it.
	 */
	it("warns once the run reaches the stale threshold", async () => {
		if (!canRestrictAccess()) return;
		const lease = await __providerInFlightForTesting.acquireLease("anthropic", 4);
		await denyWrites(lease?.path as string);

		for (let beat = 0; beat < BEATS_BEFORE_STALE; beat++) await lease?.beat();

		expect(warningsNamed(STALE_RISK_MESSAGE)).toHaveLength(1);
		await allowWrites(lease?.path as string);
		await lease?.release();
	});

	/**
	 * The report has to be actionable: which provider, which lease directory on disk, how many beats were
	 * missed, when the lease goes stale, and the underlying write error. "Heartbeat failed" alone would leave
	 * the operator with no way to tell a permissions problem from a full disk.
	 */
	it("names the provider, the lease, the missed beats and the write error", async () => {
		if (!canRestrictAccess()) return;
		const lease = await __providerInFlightForTesting.acquireLease("openai", 4);
		await denyWrites(lease?.path as string);

		for (let beat = 0; beat < BEATS_BEFORE_STALE; beat++) await lease?.beat();

		const fields = warningsNamed(STALE_RISK_MESSAGE)[0] as Record<string, unknown>;
		expect(fields.provider).toBe("openai");
		expect(fields.lease).toBe(lease?.path);
		expect(fields.missedBeats).toBe(BEATS_BEFORE_STALE);
		expect(fields.staleAfterMs).toBe(30_000);
		expect(String(fields.error)).toContain("EACCES");
		await allowWrites(lease?.path as string);
		await lease?.release();
	});

	/**
	 * And it does not repeat. A 5s interval that warned on every beat would emit twelve lines a minute for one
	 * fact, which is how a real warning gets filtered out of a log.
	 */
	it("warns once and not on every later beat", async () => {
		if (!canRestrictAccess()) return;
		const lease = await __providerInFlightForTesting.acquireLease("anthropic", 4);
		await denyWrites(lease?.path as string);

		for (let beat = 0; beat < BEATS_BEFORE_STALE * 3; beat++) await lease?.beat();

		expect(warningsNamed(STALE_RISK_MESSAGE)).toHaveLength(1);
		await allowWrites(lease?.path as string);
		await lease?.release();
	});
});

describe("a heartbeat that recovers", () => {
	/**
	 * Reported because the reader of the warning needs to know it ended: a log with the warning and no
	 * recovery line means the guard was still open when the process exited.
	 */
	it("reports the recovery and the beats it had missed", async () => {
		if (!canRestrictAccess()) return;
		const lease = await __providerInFlightForTesting.acquireLease("anthropic", 4);
		await denyWrites(lease?.path as string);
		for (let beat = 0; beat < BEATS_BEFORE_STALE; beat++) await lease?.beat();

		await allowWrites(lease?.path as string);
		await lease?.beat();

		const recovered = warningsNamed(RECOVERED_MESSAGE);
		expect(recovered).toHaveLength(1);
		expect(recovered[0]?.missedBeats).toBe(BEATS_BEFORE_STALE);
		expect(recovered[0]?.lease).toBe(lease?.path);
		await lease?.release();
	});

	/**
	 * And the counter resets, so a later run of failures warns again rather than being suppressed forever by
	 * the first one. A latch that never reopens hides the second outage.
	 */
	it("warns again after a later run of failures", async () => {
		if (!canRestrictAccess()) return;
		const lease = await __providerInFlightForTesting.acquireLease("anthropic", 4);
		await denyWrites(lease?.path as string);
		for (let beat = 0; beat < BEATS_BEFORE_STALE; beat++) await lease?.beat();
		await allowWrites(lease?.path as string);
		await lease?.beat();

		await denyWrites(lease?.path as string);
		for (let beat = 0; beat < BEATS_BEFORE_STALE; beat++) await lease?.beat();

		expect(warningsNamed(STALE_RISK_MESSAGE)).toHaveLength(2);
		await allowWrites(lease?.path as string);
		await lease?.release();
	});
});

describe("a heartbeat that works", () => {
	/** The ordinary case: nothing is reported, and `info.json` keeps being rewritten. */
	it("stays silent and keeps the lease fresh", async () => {
		const lease = await __providerInFlightForTesting.acquireLease("anthropic", 4);
		const infoPath = path.join(lease?.path as string, "info.json");
		const before = JSON.parse(await fs.readFile(infoPath, "utf-8")) as { timestamp: number };

		await Bun.sleep(2);
		await lease?.beat();

		const after = JSON.parse(await fs.readFile(infoPath, "utf-8")) as { timestamp: number };
		expect(after.timestamp).toBeGreaterThanOrEqual(before.timestamp);
		expect(warningsNamed(STALE_RISK_MESSAGE)).toEqual([]);
		expect(warningsNamed(RECOVERED_MESSAGE)).toEqual([]);
		await lease?.release();
	});
});
