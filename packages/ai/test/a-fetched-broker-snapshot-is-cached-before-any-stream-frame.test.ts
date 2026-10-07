/**
 * The snapshot fetched from the broker at startup is written to the snapshot cache whether or not
 * the snapshot stream ever sends a frame.
 *
 * The defect: the cache write rode only on later snapshot updates. A broker whose stream stays
 * open without sending, or whose long-poll answers 304 because nothing changed, then leaves the
 * cache unwritten, and the next start with the broker unreachable has no snapshot to start from.
 * Here the stream request is held open until the store closes, so the startup fetch is the only
 * snapshot the client receives.
 *
 * Does not cover cache encryption or expiry, or the writes that later stream frames make.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAuthStorage, readAuthBrokerSnapshotCache } from "@veyyon/ai/auth-broker";
import { removeWithRetries } from "@veyyon/utils";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";
import { withEnv } from "./helpers";

const BROKER_URL = "https://broker.invalid.test";
const TOKEN = "cache-test-token";
const TTL_MS = 3_600_000;
const GENERATION = 7;

function snapshotBody(): string {
	return JSON.stringify({
		generation: GENERATION,
		generatedAt: Date.now(),
		serverNowMs: Date.now(),
		refresher: { enabled: false, intervalMs: 60_000, skewMs: 0, nextSweepInMs: 60_000 },
		credentials: [],
	});
}

/** Answers the startup snapshot GET and holds every other request open until its signal aborts. */
async function brokerWithSilentStream(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.pathname === "/v1/snapshot" && !url.searchParams.has("wait")) {
		return new Response(snapshotBody(), { status: 200, headers: { "content-type": "application/json" } });
	}
	const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
	const { promise, reject } = Promise.withResolvers<Response>();
	signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	return promise;
}

describe("a fetched broker snapshot is cached before any stream frame", () => {
	let tempRoot = "";

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-broker-first-snapshot-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(guardDestructivePath(tempRoot, "broker-first-snapshot"));
		tempRoot = "";
	});

	test("the startup snapshot reaches the cache while the stream sends nothing", async () => {
		const cachePath = path.join(tempRoot, "snapshot.enc");
		const written = Promise.withResolvers<void>();
		const watcher = fs.watch(tempRoot, (_event, filename) => {
			if (filename === path.basename(cachePath)) written.resolve();
		});
		spyOn(globalThis, "fetch").mockImplementation(brokerWithSilentStream as typeof fetch);

		await withEnv(
			{
				VEYYON_AUTH_BROKER_URL: BROKER_URL,
				VEYYON_AUTH_BROKER_TOKEN: TOKEN,
				VEYYON_AUTH_BROKER_SNAPSHOT_TTL_MS: String(TTL_MS),
			},
			async () => {
				const storage = await discoverAuthStorage({ agentDir: tempRoot, storeAgentDir: tempRoot, cachePath });
				try {
					await written.promise;
					const cached = await readAuthBrokerSnapshotCache({
						path: cachePath,
						token: TOKEN,
						url: BROKER_URL,
						ttlMs: TTL_MS,
					});
					expect(cached?.generation).toBe(GENERATION);
				} finally {
					storage.close();
					watcher.close();
				}
			},
		);
	});
});
