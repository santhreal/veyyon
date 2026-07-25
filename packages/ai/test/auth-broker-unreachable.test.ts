import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAuthStorage } from "@veyyon/ai/auth-broker";
import { removeWithRetries } from "@veyyon/utils";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";

/**
 * AUTHC-10: an unreachable auth broker must never present as "you have no
 * credentials".
 *
 * When credentials live on a broker, the client holds only a snapshot. If the
 * broker cannot be reached and the failure is swallowed, the store is simply
 * EMPTY, and empty is indistinguishable from a user who has never logged in.
 * The agent then reports no credentials, offers a login flow, and the user
 * concludes their account is broken when the truth is that a network hop failed.
 * This is Law 10 in its purest form: the quiet answer and the correct answer
 * look identical from the outside, and only the quiet one is wrong.
 *
 * The distinction these tests draw is the whole point:
 *
 *  - broker reachable, zero credentials  → an empty list, no error. A real state.
 *  - broker unreachable or erroring      → a raised error naming the broker.
 *
 * Both directions are asserted, because a change that made every failure loud
 * by also making the empty case loud would break the legitimate first-run
 * experience, and a test that only checked the failure would not notice.
 */
describe("an unreachable auth broker is never reported as an empty credential set", () => {
	let tempRoot = "";
	const ENV_KEYS = [
		"VEYYON_AUTH_BROKER_URL",
		"VEYYON_AUTH_BROKER_TOKEN",
		"VEYYON_AUTH_BROKER_SNAPSHOT_TTL_MS",
	] as const;
	const saved: Record<string, string | undefined> = {};
	const BROKER_URL = "https://broker.invalid.test";

	beforeEach(() => {
		for (const key of ENV_KEYS) saved[key] = process.env[key];
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-broker-unreachable-"));
		process.env.VEYYON_AUTH_BROKER_URL = BROKER_URL;
		process.env.VEYYON_AUTH_BROKER_TOKEN = "test-token";
		// The snapshot cache is disabled so every test exercises the LIVE fetch. With
		// a cache in play a failure could be masked by a previous run's snapshot,
		// which is a legitimate feature but not what is under test here.
		process.env.VEYYON_AUTH_BROKER_SNAPSHOT_TTL_MS = "0";
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		if (tempRoot) {
			await removeWithRetries(guardDestructivePath(tempRoot, "auth-broker-unreachable"));
			tempRoot = "";
		}
	});

	/** Options that keep every path this test touches inside the temp root. */
	function discoverOptions() {
		return {
			agentDir: tempRoot,
			storeAgentDir: tempRoot,
			cachePath: path.join(tempRoot, "snapshot-cache.json"),
		};
	}

	function mockFetch(handler: () => Response | Promise<Response>): void {
		spyOn(globalThis, "fetch").mockImplementation((async () => await handler()) as unknown as typeof fetch);
	}

	describe("the broker cannot be reached", () => {
		test("a refused connection raises instead of yielding an empty store", async () => {
			// The exact silent-logout scenario: without the throw, the caller receives a
			// store with zero credentials and shows a login prompt.
			spyOn(globalThis, "fetch").mockImplementation((async () => {
				throw new TypeError("Unable to connect. Is the computer able to access the url?");
			}) as unknown as typeof fetch);

			await expect(discoverAuthStorage(discoverOptions())).rejects.toThrow();
		});

		test("a 503 from the broker raises and carries the status", async () => {
			mockFetch(() => new Response("", { status: 503, statusText: "Service Unavailable" }));

			// The status is what tells a user (or a support thread) that the broker
			// answered and is unwell, rather than that the URL or token is wrong.
			await expect(discoverAuthStorage(discoverOptions())).rejects.toThrow(/snapshot|503/i);
		});

		test("a 401 raises rather than presenting as a logged-out user", async () => {
			// An expired broker token and an empty account are the two states most often
			// confused, and the remedies are completely different: rotate a token versus
			// log in again.
			mockFetch(() => new Response("", { status: 401, statusText: "Unauthorized" }));

			await expect(discoverAuthStorage(discoverOptions())).rejects.toThrow();
		});

		test("a timeout raises rather than resolving to nothing", async () => {
			const timeout = new Error("The operation timed out.");
			timeout.name = "TimeoutError";
			spyOn(globalThis, "fetch").mockImplementation((async () => {
				throw timeout;
			}) as unknown as typeof fetch);

			await expect(discoverAuthStorage(discoverOptions())).rejects.toThrow();
		});
	});

	describe("the broker answers but has nothing", () => {
		test("a 200 with zero credentials is an empty store and NOT an error", async () => {
			// The legitimate first-run state. Making this loud too would be an
			// over-correction that turns a normal onboarding into an error message, and
			// it is the reason the failure tests above are meaningful: they distinguish
			// two states rather than just making everything throw.
			mockFetch(
				() =>
					new Response(
						JSON.stringify({
							generation: 1,
							generatedAt: Date.now(),
							serverNowMs: Date.now(),
							refresher: { enabled: false, intervalMs: 60_000, skewMs: 0, nextSweepInMs: 60_000 },
							credentials: [],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			);

			const storage = await discoverAuthStorage(discoverOptions());
			expect(storage.listStoredCredentials()).toEqual([]);
			// And the provider list is empty too, which is what the UI reads to decide
			// whether to offer a login.
			expect(storage.list()).toEqual([]);
		});
	});

	describe("what the failure says", () => {
		test("the error names the broker rather than blaming the user's login", async () => {
			mockFetch(() => new Response("", { status: 500, statusText: "Internal Server Error" }));

			let message = "";
			await discoverAuthStorage(discoverOptions()).catch((err: unknown) => {
				message = String(err);
			});
			// Naming the broker is what stops the misdiagnosis. A message about missing
			// credentials would send the user to re-authenticate, which cannot possibly
			// help when the broker itself is down.
			expect(message.toLowerCase()).toContain("broker");
		});
	});
});
