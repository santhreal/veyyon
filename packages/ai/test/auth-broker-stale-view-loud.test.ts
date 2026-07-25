import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { AuthBrokerClient, RemoteAuthCredentialStore, type SnapshotResponse } from "@veyyon/ai/auth-broker";
import { logger } from "@veyyon/utils";

/**
 * When this process's view of the broker's credentials goes stale, say so (Law 10).
 *
 * `RemoteAuthCredentialStore` keeps a local copy of the broker's credential
 * snapshot and answers every read from it: which credential to use, which is
 * blocked, which token is current. Four separate paths could fail to bring that
 * copy back in line, and all four caught the error, wrote a `logger.debug` line
 * and carried on:
 *
 *  - the background sync loop, whose failure means the copy stops advancing;
 *  - the refresh fired after a local write, which leaves the write invisible;
 *  - the refresh fired after a credential refresh, which leaves the OLD access
 *    token in the local copy while the broker has already rotated it;
 *  - the consumer callback, which leaves whoever subscribed even further behind
 *    than the store itself.
 *
 * Every one of them is a silent fallback in the strict sense: the operation the
 * caller asked for SUCCEEDED, so nothing surfaces as an error, and the next
 * decision is quietly made against data the code already knows is out of date.
 * An operator watching a session route to a blocked credential, or retry with a
 * token the broker replaced ten minutes ago, had nothing above debug level to
 * explain it.
 *
 * These are reported, not fail-closed: a broker that briefly cannot be reached
 * must not take down a process that has a perfectly usable cached credential.
 * The bound is one warning per cause, because the cause is normally a broker
 * that is down for the whole process lifetime.
 */
describe("A stale auth-broker credential view is announced, not logged at debug", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;
	let debugs: Array<{ message: string; fields: Record<string, unknown> }>;
	const stores: RemoteAuthCredentialStore[] = [];

	beforeEach(() => {
		warnings = [];
		debugs = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
		vi.spyOn(logger, "debug").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			debugs.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		for (const store of stores.splice(0)) store.close();
		vi.restoreAllMocks();
	});

	const emptySnapshot = (generation = 1): SnapshotResponse =>
		({
			generation,
			serverNowMs: Date.now(),
			credentials: [],
			refresher: { enabled: false, intervalMs: 0, nextRunAtMs: 0 },
		}) as unknown as SnapshotResponse;

	/**
	 * A store wired to a client whose network calls are stubbed. Streaming is off
	 * so the test drives the snapshot paths directly rather than racing an SSE
	 * loop, and the background loop is neutralised per test by whichever stub the
	 * case installs.
	 */
	function createStore(
		fetchSnapshot: (opts?: { ifGenerationGt?: number }) => Promise<unknown>,
		onSnapshot?: (snapshot: SnapshotResponse, generation: number) => void,
	): RemoteAuthCredentialStore {
		const client = new AuthBrokerClient({ url: "http://127.0.0.1:1/never", token: "t" });
		vi.spyOn(client, "fetchSnapshot").mockImplementation(fetchSnapshot as never);
		vi.spyOn(client, "openSnapshotStream").mockImplementation((() => ({
			// A stream that ends immediately, so the store falls back to polling
			// without ever reaching a real socket.
			async *[Symbol.asyncIterator]() {},
		})) as never);
		const store = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: emptySnapshot(),
			streamSnapshots: false,
			onSnapshot,
		});
		stores.push(store);
		return store;
	}

	const staleWarnings = () => warnings.filter(entry => entry.message.includes("credential view is stale"));

	/**
	 * A stub that serves `generation` once and then behaves like a real long-poll:
	 * 304 with a short wait. Returning 200 unconditionally would spin the store's
	 * background loop with no backoff and wedge the test process, which is not a
	 * bug in the store, just what a broker that answers instantly forever looks
	 * like.
	 */
	const servesOnce = (generation: number) => async (opts?: { ifGenerationGt?: number }) => {
		if ((opts?.ifGenerationGt ?? 0) >= generation) {
			await Bun.sleep(20);
			return { status: 304 };
		}
		return { status: 200, snapshot: emptySnapshot(generation), generation };
	};

	/** Poll until `predicate` holds, so the background loop's timing is not asserted. */
	async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(5);
		}
		throw new Error(`timed out waiting for ${label}`);
	}

	/**
	 * The most consequential of the four. The background loop is the only thing
	 * keeping the local copy current when nothing else touches the store, so a
	 * loop that has been failing for an hour is exactly the state an operator
	 * needs told about, and it is also the state that produces no error anywhere:
	 * every read still answers, from data that stopped advancing.
	 */
	test("warns, naming the cause, when the background sync loop fails", async () => {
		let attempts = 0;
		createStore(async () => {
			attempts++;
			throw new Error("ECONNREFUSED: broker is not listening");
		});

		await waitUntil("the background loop to report a stale view", () => staleWarnings().length > 0);

		const reported = staleWarnings();
		expect(reported[0]?.message).toContain("outdated credential or block state");
		expect(String(reported[0]?.fields.error)).toContain("ECONNREFUSED");
		expect(reported[0]?.fields.cause).toBe("background-sync");
		expect(attempts).toBeGreaterThan(0);
	});

	/**
	 * The bound, and the half that makes the fix usable rather than just louder.
	 * A broker that is down stays down and the loop retries forever, so a warning
	 * per attempt would bury the one line worth reading under its own repeats.
	 */
	test("warns once per cause, then keeps recording at debug", async () => {
		createStore(async () => {
			throw new Error("ECONNREFUSED: broker is not listening");
		});

		const quiet = () => debugs.filter(entry => entry.message === "auth-broker credential view still stale");
		await waitUntil("a second background failure", () => quiet().length > 0);

		// However many attempts the loop got through, exactly one was shouted.
		expect(staleWarnings()).toHaveLength(1);
		expect(quiet()[0]?.fields.cause).toBe("background-sync");
	});

	/**
	 * A failing consumer callback is a distinct cause and must warn on its own.
	 * Collapsing the causes into one key would mean whichever failed second is
	 * never announced, which is the original bug scoped down rather than fixed.
	 */
	test("warns separately when the snapshot callback throws", async () => {
		const store = createStore(servesOnce(2), () => {
			throw new Error("consumer blew up applying the snapshot");
		});

		await store.refreshSnapshot();

		const reported = staleWarnings();
		expect(reported).toHaveLength(1);
		expect(reported[0]?.fields.cause).toBe("snapshot-callback");
		expect(String(reported[0]?.fields.error)).toContain("consumer blew up");
		expect(reported[0]?.fields.generation).toBe(2);
	});

	/**
	 * The happy path must be completely silent. Without this the suite would pass
	 * against an implementation that warned on every snapshot, which is the
	 * ordinary case and would make the warning worthless within a minute.
	 */
	test("says nothing when the snapshot refreshes cleanly", async () => {
		const store = createStore(servesOnce(3));

		await store.refreshSnapshot();

		expect(staleWarnings()).toHaveLength(0);
		expect(store.snapshot.generation).toBe(3);
	});

	/**
	 * A callback that succeeds is silent too, so the callback cause is genuinely
	 * tied to the throw and not merely to a callback being registered.
	 */
	test("says nothing when the snapshot callback succeeds", async () => {
		const seen: number[] = [];
		const store = createStore(servesOnce(4), (_snapshot, generation) => {
			seen.push(generation);
		});

		await store.refreshSnapshot();

		// The background loop may deliver the same generation again; what matters
		// is that a working callback produced no warning at all.
		expect(seen).toContain(4);
		expect(staleWarnings()).toHaveLength(0);
	});
});
