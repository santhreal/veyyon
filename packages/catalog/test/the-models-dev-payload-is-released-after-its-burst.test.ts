/**
 * The models.dev payload leaves memory once the burst that read it is over.
 *
 * WHY: the overlay memoized the parsed `api.json` for the life of the process. The memo exists so a
 * startup or refresh burst, which resolves every descriptor-covered provider within seconds, parses
 * the payload once; past the burst nothing reads it until a provider cache goes stale, and
 * `models-dev.json` holds the same bytes for that read. Pinned, it was 6.6 MiB of the idle heap.
 *
 * Class closed: a branch that stores the payload in the memo without arming the release, a release
 * that fires before its window, and a window that does not slide with use. The branch table covers
 * every way a fetch fills the memo: a fresh disk cache, and over a stale one a rejected request, a
 * non-ok status, a 304, a 200 and an unreadable 200 body. Each asserts a re-read after the window
 * and the exact network attempts, so a released memo inside the failure backoff still serves the
 * stale disk payload without a second attempt.
 *
 * Reachability is observed in a fresh process (`fixtures/models-dev-payload-reachability.ts`): in
 * the test runner a promise another file left on the stack keeps the payload reachable after the
 * overlay has let go of it. The fixture checks the payload is reachable while the release is pending,
 * which proves the check can see a holder, and unreachable once the release fires.
 *
 * Not caught: a caller that keeps the payload it was handed. The reachability case observes the
 * payload object, so it catches any holder reachable from this module's state, not one outside it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ModelsDevFallback } from "@veyyon/catalog/model-manager";
import { defaultModelsDevFallback, resetModelsDevOverlayState } from "@veyyon/catalog/modelsdev-overlay";
import type { PayloadReachability } from "./fixtures/models-dev-payload-reachability";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "fixtures", "models-dev-payload-reachability.ts");
const FIXTURE_TIMEOUT_MS = 30_000;

/** The hold window the overlay documents: 30 s past the payload's last use. */
const HOLD_MS = 30_000;
const STALE_MS = 3 * 60 * 60 * 1000;
const SEEDED_AT_OFFSET = 1;
const PAYLOAD = { sentinel: "models-dev-payload" };

let dir: string;

beforeEach(() => {
	resetModelsDevOverlayState();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-modelsdev-release-"));
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetModelsDevOverlayState();
	fs.rmSync(dir, { recursive: true, force: true });
});

function cachePath(): string {
	return path.join(dir, "models-dev.json");
}

/** A disk cache `ageMs` old, and the fallback that reads it. Returns the seeded `fetchedAt`. */
function seed(ageMs: number): { fallback: ModelsDevFallback; seededAt: number } {
	const seededAt = Date.now() - ageMs - SEEDED_AT_OFFSET;
	fs.writeFileSync(cachePath(), JSON.stringify({ fetchedAt: seededAt, etag: '"v1"', payload: PAYLOAD }));
	const fallback = defaultModelsDevFallback("anthropic", path.join(dir, "models.db"));
	if (!fallback) throw new Error("anthropic has a models.dev descriptor");
	return { fallback, seededAt };
}

/**
 * Wait for the overlay's background disk write, which renews `fetchedAt`. The write is not atomic,
 * so a read can land on a truncated file and is retried. Bounded, so it ends.
 */
async function awaitDiskRewrite(seededAt: number): Promise<void> {
	for (let attempt = 0; attempt < 1000; attempt++) {
		const text = await fs.promises.readFile(cachePath(), "utf8");
		let written: { fetchedAt: number };
		try {
			written = JSON.parse(text) as { fetchedAt: number };
		} catch {
			continue;
		}
		if (written.fetchedAt !== seededAt) return;
	}
	throw new Error("the overlay never rewrote models-dev.json");
}

interface Branch {
	name: string;
	diskAgeMs: number;
	/** The network's answer; absent when the branch must not reach the network. */
	respond?: () => Response | Promise<Response>;
	/** Whether the branch rewrites `models-dev.json` in the background. */
	rewritesDisk: boolean;
}

const BRANCHES: Branch[] = [
	{ name: "a fresh disk cache", diskAgeMs: 0, rewritesDisk: false },
	{
		name: "a rejected request over a stale disk cache",
		diskAgeMs: STALE_MS,
		respond: () => Promise.reject(new Error("network down")),
		rewritesDisk: false,
	},
	{
		name: "a non-ok status over a stale disk cache",
		diskAgeMs: STALE_MS,
		respond: () => new Response("unavailable", { status: 503 }),
		rewritesDisk: false,
	},
	{
		name: "a 304 over a stale disk cache",
		diskAgeMs: STALE_MS,
		respond: () => new Response(null, { status: 304 }),
		rewritesDisk: true,
	},
	{
		name: "a 200 over a stale disk cache",
		diskAgeMs: STALE_MS,
		respond: () => Response.json(PAYLOAD, { headers: { etag: '"v2"' } }),
		rewritesDisk: true,
	},
	{
		name: "an unreadable 200 body over a stale disk cache",
		diskAgeMs: STALE_MS,
		respond: () => new Response("{not json", { status: 200 }),
		rewritesDisk: false,
	},
];

describe("every branch that fills the memo releases it after the hold window", () => {
	for (const branch of BRANCHES) {
		it(`reads the payload again after serving it from ${branch.name}`, async () => {
			const requested: string[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
				requested.push(input instanceof Request ? input.url : String(input));
				if (!branch.respond) throw new Error("this branch must not reach the network");
				return branch.respond();
			}) as unknown as typeof fetch);
			const { fallback, seededAt } = seed(branch.diskAgeMs);
			vi.useFakeTimers();

			const first = await fallback.fetch();
			expect(first).toEqual(PAYLOAD);
			if (branch.rewritesDisk) await awaitDiskRewrite(seededAt);

			vi.advanceTimersByTime(HOLD_MS);
			const second = await fallback.fetch();
			expect(second).toEqual(PAYLOAD);
			expect(second).not.toBe(first);
			// A failure branch arms the backoff, so the re-read serves the stale disk copy; a 200 or 304
			// renewed the disk copy. Either way the second fetch makes no network attempt.
			expect(requested).toHaveLength(branch.respond ? 1 : 0);
		});
	}
});

it("serves one parse until the hold window passes since the last use", async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network expected"));
	const { fallback } = seed(0);
	vi.useFakeTimers();

	const first = await fallback.fetch();

	vi.advanceTimersByTime(HOLD_MS - 1);
	expect(await fallback.fetch()).toBe(first);

	// The previous use re-armed the window, so the memo outlives the first use by more than HOLD_MS.
	vi.advanceTimersByTime(HOLD_MS - 1);
	expect(await fallback.fetch()).toBe(first);

	vi.advanceTimersByTime(HOLD_MS);
	expect(await fallback.fetch()).not.toBe(first);
});

describe("the payload's reachability in a fresh process", () => {
	let reachability: PayloadReachability;

	beforeAll(async () => {
		const { stdout, stderr } = await run(process.execPath, [FIXTURE], {
			timeout: FIXTURE_TIMEOUT_MS - 5_000,
			killSignal: "SIGKILL",
		});
		expect(stderr).toBe("");
		reachability = JSON.parse(stdout) as PayloadReachability;
	}, FIXTURE_TIMEOUT_MS);

	it("arms the release for the hold window", () => {
		expect(reachability.releaseDelayMs).toBe(HOLD_MS);
	});

	it("keeps the payload reachable while the release is pending", () => {
		expect(reachability.reachableWhileHeld).toBe(true);
	});

	it("holds no reference to the payload once the release fires", () => {
		expect(reachability.reachableAfterRelease).toBe(false);
	});
});
