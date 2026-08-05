/**
 * Locks out the bare `catch {}` in `signalProviderInFlightWaitersInDir`
 * (`stream.ts`).
 *
 * Releasing a provider in-flight lease writes a `.wakeup` file that every queued
 * request for that provider is watching. Waiters do have a fallback timer, so a
 * dropped wakeup is not a deadlock, and the release must not fail because of it.
 * But the usual cause (a provider directory that cannot be written) does not
 * heal on its own: every queued request then waits out the full fallback
 * interval instead of starting when the slot frees, for the whole run, and the
 * discarded error meant there was nothing anywhere connecting the stall to a
 * permission problem.
 *
 * If this regresses, an unwritable in-flight directory presents as "requests
 * against this provider are mysteriously slow" with no diagnostic at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __providerInFlightForTesting } from "@veyyon/ai/stream";
import { logger } from "@veyyon/utils";

const WAKEUP_MESSAGE =
	"Provider in-flight wakeup could not be written; queued requests will wait for the fallback timer";

let limiterRoot: string;
const restoreModeOn: string[] = [];
let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

/** Mode bits do not restrict root, and Windows does not honour them at all. */
const canRestrictAccess = process.platform !== "win32" && process.getuid?.() !== 0;

beforeEach(async () => {
	limiterRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-inflight-wakeup-"));
	__providerInFlightForTesting.setRoot(limiterRoot);
	warnings = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of restoreModeOn.splice(0)) await fs.chmod(dir, 0o700).catch(() => {});
	__providerInFlightForTesting.setRoot(undefined);
	await fs.rm(limiterRoot, { recursive: true, force: true });
});

/**
 * Take a real lease, then leave its provider directory read-only with the lease
 * entry already gone, which is the state a release hits when the directory has
 * become unwritable: the removal is a no-op and only the `.wakeup` write fails.
 */
async function leaseWithUnwritableProviderDir(provider: string) {
	const lease = await __providerInFlightForTesting.acquireLease(provider, 4);
	expect(lease).not.toBeNull();
	const providerDir = __providerInFlightForTesting.providerDir(provider);
	await fs.rm(lease?.path as string, { recursive: true, force: true });
	await fs.chmod(providerDir, 0o500);
	restoreModeOn.push(providerDir);
	return { lease, providerDir };
}

describe("a provider in-flight wakeup that cannot be written", () => {
	it("warns with the directory and the reason", async () => {
		if (!canRestrictAccess) return;
		const { lease, providerDir } = await leaseWithUnwritableProviderDir("anthropic");

		await lease?.release();

		const reported = warnings.filter(entry => entry.message === WAKEUP_MESSAGE);
		expect(reported).toHaveLength(1);
		expect(reported[0]?.fields.dir).toBe(providerDir);
		expect(String(reported[0]?.fields.error)).not.toBe("");
	});

	/** The release itself must still complete: visibility, not fragility. */
	it("does not fail the release", async () => {
		if (!canRestrictAccess) return;
		const { lease } = await leaseWithUnwritableProviderDir("anthropic");

		await expect(lease?.release()).resolves.toBeUndefined();
	});
});

describe("a provider in-flight wakeup that works", () => {
	/** Without this the suite would pass against code that warned on every release. */
	it("says nothing", async () => {
		const lease = await __providerInFlightForTesting.acquireLease("anthropic", 4);
		expect(lease).not.toBeNull();

		await lease?.release();

		expect(warnings.filter(entry => entry.message === WAKEUP_MESSAGE)).toEqual([]);
	});
});
