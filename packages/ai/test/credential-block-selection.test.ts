/**
 * When every account for a provider is blocked, selection still has to name
 * one. Which one it names decides whether the next request has any chance.
 *
 * The observed failure is a provider-wide quota wall: each account gets marked
 * as its turn comes round, and selection then fell back to the round-robin
 * head. That head is whichever account happens to sort first, routinely the one
 * just marked with the longest window, so the next request was guaranteed to
 * fail the same way. 27 consecutive `403 usage limit` turns and 13 sessions
 * ended on that shape.
 *
 * Three selection paths reach this decision and each is exercised here. They
 * are separate code paths for real reasons (peek vs resolve, api-key vs oauth),
 * which is exactly why a fix applied to one of them is worth nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@veyyon/ai";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "kimi-code";
const MINUTE = 60_000;

/** Block windows in save order: the soonest one is deliberately not first. */
const BLOCK_OFFSETS_MS = [30 * MINUTE, 2 * MINUTE, 20 * MINUTE];
const SOONEST_SUFFIX = "2";

function oauthCredential(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("credential selection under a provider-wide quota wall", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-block-select-"));
		dbPath = path.join(tempDir, "agent.db");
	});

	afterEach(async () => {
		storage?.close();
		storage = undefined;
		store = undefined;
		dbPath = "";
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/**
	 * Three credentials of `type`, blocked for the offsets given. An offset of
	 * `undefined` leaves that credential usable. Ranking is disabled so the
	 * unranked selection paths — the ones this fix touches — are the ones under
	 * test rather than the usage-report comparator.
	 */
	async function seed(type: "oauth" | "api_key", offsets: readonly (number | undefined)[]): Promise<AuthStorage> {
		store = await SqliteAuthCredentialStore.open(dbPath);
		for (const suffix of ["1", "2", "3"]) {
			if (type === "oauth") store.saveOAuth(PROVIDER, oauthCredential(suffix));
			else store.upsertAuthCredentialForProvider(PROVIDER, { type: "api_key", key: `access-${suffix}` });
		}
		const rows = store.listAuthCredentials(PROVIDER);
		storage = new AuthStorage(store, { rankingStrategyResolver: () => undefined });
		await storage.reload();
		const now = Date.now();
		for (const [position, offset] of offsets.entries()) {
			if (offset === undefined) continue;
			storage.upsertCredentialBlock({
				credentialId: rows[position]!.id,
				providerKey: `${PROVIDER}:${type}`,
				blockScope: "",
				blockedUntilMs: now + offset,
			});
		}
		return storage;
	}

	it("peekApiKey hands back the account that frees up soonest, not the round-robin head", async () => {
		const auth = await seed("oauth", BLOCK_OFFSETS_MS);
		expect(await auth.peekApiKey(PROVIDER)).toBe(`access-${SOONEST_SUFFIX}`);
	});

	it("peekApiKey does the same for stored api keys", async () => {
		const auth = await seed("api_key", BLOCK_OFFSETS_MS);
		expect(await auth.peekApiKey(PROVIDER)).toBe(`access-${SOONEST_SUFFIX}`);
	});

	// Session id seeds the round-robin rotation, so a single id can land on the
	// right answer for the wrong reason. Every id has to agree.
	const SESSION_IDS = ["session-a", "session-b", "session-c", "session-d", "session-e"];

	it("getApiKey does the same on the oauth resolution path, from any session", async () => {
		for (const sessionId of SESSION_IDS) {
			await afterEachCleanup();
			const auth = await seed("oauth", BLOCK_OFFSETS_MS);
			expect(`${sessionId}: ${await auth.getApiKey(PROVIDER, sessionId)}`).toBe(
				`${sessionId}: access-${SOONEST_SUFFIX}`,
			);
		}
	});

	it("getApiKey does the same on the api-key selection path, from any session", async () => {
		for (const sessionId of SESSION_IDS) {
			await afterEachCleanup();
			const auth = await seed("api_key", BLOCK_OFFSETS_MS);
			expect(`${sessionId}: ${await auth.getApiKey(PROVIDER, sessionId)}`).toBe(
				`${sessionId}: access-${SOONEST_SUFFIX}`,
			);
		}
	});

	it("still prefers a usable account over every blocked one, however soon they free up", async () => {
		// The wall is the exception, not the rule. A usable account must never
		// lose to a blocked one just because the blocked one expires in a second.
		for (const type of ["oauth", "api_key"] as const) {
			for (const sessionId of SESSION_IDS) {
				await afterEachCleanup();
				const auth = await seed(type, [1000, 2000, undefined]);
				expect(`${type}/${sessionId}: ${await auth.peekApiKey(PROVIDER)}`).toBe(`${type}/${sessionId}: access-3`);
				expect(`${type}/${sessionId}: ${await auth.getApiKey(PROVIDER, sessionId)}`).toBe(
					`${type}/${sessionId}: access-3`,
				);
			}
		}
	});

	it("never returns a longer-blocked account than one it could have returned", async () => {
		// The invariant behind all of the above, stated directly: whatever comes
		// back, no other candidate frees up sooner. This is what fails when a
		// fourth selection path is added and forgets to order by availability.
		for (const type of ["oauth", "api_key"] as const) {
			for (const offsets of [
				[30 * MINUTE, 2 * MINUTE, 20 * MINUTE],
				[2 * MINUTE, 30 * MINUTE, 20 * MINUTE],
				[20 * MINUTE, 30 * MINUTE, 2 * MINUTE],
			]) {
				await afterEachCleanup();
				const auth = await seed(type, offsets);
				const soonest = `access-${offsets.indexOf(Math.min(...offsets)) + 1}`;
				expect(`${type}/${offsets.join(",")}: ${await auth.peekApiKey(PROVIDER)}`).toBe(
					`${type}/${offsets.join(",")}: ${soonest}`,
				);
			}
		}
	});

	/** Tear down and re-create the temp database between in-test iterations. */
	async function afterEachCleanup(): Promise<void> {
		storage?.close();
		storage = undefined;
		store = undefined;
		await removeWithRetries(tempDir);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-block-select-"));
		dbPath = path.join(tempDir, "agent.db");
	}
});
