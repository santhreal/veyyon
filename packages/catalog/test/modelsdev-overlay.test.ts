/**
 * The models.dev overlay's offline behavior with a stale disk cache.
 *
 * Found in review: the 5-minute failure backoff was armed only when NO disk
 * cache existed. An offline host with a stale `models-dev.json` took the
 * `return disk.payload` branch in every failure path, which neither armed the
 * backoff nor memoized the stale payload — so every provider's refresh window
 * re-read the disk file and re-attempted the fetch, stalling up to the 15s
 * timeout each time. With 100+ descriptor-covered providers that is minutes
 * of stall per offline session start, for data the disk already held.
 *
 * The contract pinned here: a stale disk payload is served during the backoff
 * window, and the window contains exactly ONE network attempt.
 */
import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultModelsDevFallback } from "@veyyon/catalog/modelsdev-overlay";

afterEach(() => {
	vi.restoreAllMocks();
});

it("serves the stale disk payload through the backoff window with a single network attempt", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-modelsdev-overlay-"));
	try {
		// A stale payload on disk, as a previous online session left it.
		const stalePayload = { sentinel: "stale-models-dev-data" };
		fs.writeFileSync(
			path.join(dir, "models-dev.json"),
			JSON.stringify({ fetchedAt: Date.now() - 3 * 60 * 60 * 1000, payload: stalePayload }),
		);
		const dbPath = path.join(dir, "models.db");

		// Offline: every attempt rejects immediately.
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

		const fallback = defaultModelsDevFallback("anthropic", dbPath);
		expect(fallback).toBeDefined();

		// First call: one network attempt, fails, stale payload served.
		const first = await fallback!.fetch();
		expect(first).toEqual(stalePayload);
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// Second call (the next provider's refresh window): the backoff must
		// serve the memoized stale payload WITHOUT a second network attempt.
		const second = await fallback!.fetch();
		expect(second).toEqual(stalePayload);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
