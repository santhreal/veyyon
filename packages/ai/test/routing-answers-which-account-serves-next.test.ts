/**
 * WHY THIS FILE EXISTS. `sessionCredentialRouting` left `activeCredentialId` UNDEFINED whenever
 * there was no pin and no sticky last-used record, which is the state every session opens in. So an
 * operator with three Anthropic accounts opened the account card, asked the one question the card
 * exists to answer, and no row was marked: the answer arrived only after a request had gone out and
 * the card was reopened. The routing now replays the selection the next request would make and marks
 * it `activeIsPrediction`, so a surface can say `serves next` without claiming traffic that has not
 * happened.
 *
 * THE CLASS THIS CLOSES is "routing reports a next-serving account that is not the one that will
 * serve, or reporting it changes what will serve". Members:
 *
 *  - No answer at all before the first request (the reported defect).
 *  - An answer that names a different credential than the one `getApiKey` then resolves to. A
 *    confidently wrong row is worse than a blank one: the operator switches away from an account
 *    that was never going to serve.
 *  - AN ANSWER WITH SIDE EFFECTS. This is the expensive member and the reason the predictor exists
 *    separately from `#getCredentialOrder`: the sessionless order runs through
 *    `#getNextRoundRobinIndex`, which MUTATES `#providerRoundRobinIndex`. A prediction routed
 *    through it would advance the cursor on every render of a status line, so merely LOOKING at the
 *    card would change which account the next request spends. Painting a screen must not move
 *    traffic.
 *  - A prediction that outranks an observation, so a row that actually served is relabelled as a
 *    guess (or the reverse: a blocked account that last served still reported as serving).
 *  - A blocked account being named as the next to serve while a usable sibling sits there.
 *
 * WHAT IT DOES NOT CATCH, honestly. The prediction is a pure read of stored order and block state,
 * so it cannot see an async usage-ranking strategy or a refresh that fails at request time; a
 * provider that ranks by remaining quota can still land elsewhere, which is exactly why the flag is
 * called a prediction and why surfaces word it in the future. `#orderByBlockAvailability` is shared
 * with the real resolution path, so a bug inside it moves both together and stays invisible here.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-serves-next";
const HOUR_MS = 60 * 60_000;
const SESSION_ID = "session-with-no-requests-yet";

describe("routing answers which account serves next", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-serves-next-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	function oauthRow(suffix: string) {
		return {
			type: "oauth" as const,
			access: `access-${suffix}`,
			refresh: `refresh-${suffix}`,
			expires: Date.now() + HOUR_MS,
			accountId: `account-${suffix}`,
			email: `${suffix}@example.com`,
		};
	}

	/** Three accounts, so a predictor that always answers "the first row" cannot pass by luck. */
	async function seedThree(storage: AuthStorage): Promise<number[]> {
		await storage.set(PROVIDER, [oauthRow("first"), oauthRow("second"), oauthRow("third")]);
		return storage.listStoredCredentials(PROVIDER).map(row => row.id);
	}

	/** The access token of one stored row, so a predicted id can be compared against a served bearer. */
	function accessOf(storage: AuthStorage, credentialId: number): string {
		const row = storage.listStoredCredentials(PROVIDER).find(entry => entry.id === credentialId);
		if (row?.credential.type !== "oauth") throw new Error(`no oauth row ${credentialId}`);
		return row.credential.access;
	}

	function blockFor(storage: AuthStorage, credentialId: number, ms: number): void {
		storage.upsertCredentialBlock({
			credentialId,
			providerKey: `${PROVIDER}:oauth`,
			blockScope: "",
			blockedUntilMs: Date.now() + ms,
		});
	}

	/**
	 * THE REPORTED DEFECT. A session that has sent nothing still gets an answer, and the answer says
	 * out loud that it is a replay rather than an observation.
	 */
	test("a session with no requests yet still names the account that serves next", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await seedThree(authStorage);

		const routing = authStorage.sessionCredentialRouting(PROVIDER, SESSION_ID);

		expect(routing?.activeCredentialId).toBeDefined();
		expect(routing?.activeIsPrediction).toBe(true);
	});

	/**
	 * The prediction is CORRECT, not merely present. Compared against the bearer a real `getApiKey`
	 * returns for the same session, because the only honest oracle for "what serves next" is what
	 * then serves.
	 */
	test("the predicted account is the one the next request actually spends", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		await seedThree(storage);

		const predicted = storage.sessionCredentialRouting(PROVIDER, SESSION_ID)?.activeCredentialId;
		if (predicted === undefined) throw new Error("routing predicted nothing");

		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe(accessOf(storage, predicted));
	});

	/**
	 * PAINTING A SCREEN MUST NOT MOVE TRAFFIC. A status line and an open account card rebuild this
	 * answer on every frame, and the sessionless credential order advances a round-robin cursor. Ten
	 * reads stand in for those frames: with a mutating predictor the cursor walks past the account it
	 * first named, and the request lands somewhere else.
	 */
	test("reading the answer repeatedly does not change which account serves", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		await seedThree(storage);

		const first = storage.sessionCredentialRouting(PROVIDER, undefined)?.activeCredentialId;
		if (first === undefined) throw new Error("routing predicted nothing");
		for (let i = 0; i < 10; i++) {
			expect(storage.sessionCredentialRouting(PROVIDER, undefined)?.activeCredentialId).toBe(first);
		}

		expect(await storage.getApiKey(PROVIDER)).toBe(accessOf(storage, first));
	});

	/**
	 * AN OBSERVATION OUTRANKS A PREDICTION. Once a request has served, the row that served is named
	 * and the flag is gone, so a surface stops hedging the moment it has a fact.
	 */
	test("once a request has served, the answer is an observation and not a prediction", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const ids = await seedThree(storage);

		const served = await storage.getApiKey(PROVIDER, SESSION_ID);
		const routing = storage.sessionCredentialRouting(PROVIDER, SESSION_ID);
		const servedId = ids.find(id => accessOf(storage, id) === served);

		expect(routing?.activeCredentialId).toBe(servedId);
		expect(routing?.activeIsPrediction).toBeFalsy();
	});

	/**
	 * A BLOCKED ACCOUNT THAT LAST SERVED IS NOT SERVING. The sticky record still says where traffic
	 * went, and the card asks a different question; naming the blocked row would send the operator
	 * looking for a rate limit on an account that is about to be skipped.
	 */
	test("a blocked last-used account hands the answer to a usable sibling", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const ids = await seedThree(storage);

		const served = await storage.getApiKey(PROVIDER, SESSION_ID);
		const servedId = ids.find(id => accessOf(storage, id) === served);
		if (servedId === undefined) throw new Error("no credential served");
		blockFor(storage, servedId, HOUR_MS);

		const routing = storage.sessionCredentialRouting(PROVIDER, SESSION_ID);

		expect(routing?.activeCredentialId).toBeDefined();
		expect(routing?.activeCredentialId).not.toBe(servedId);
		expect(routing?.activeIsPrediction).toBe(true);
	});

	/**
	 * EVERY SIBLING BLOCKED still answers. The provider is stalled, not accountless, and a card with
	 * no row marked cannot say which account the wait is on. The answer stays a prediction, because
	 * nothing is serving anything.
	 */
	test("every account blocked still names one, as a prediction", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const ids = await seedThree(storage);
		for (const id of ids) blockFor(storage, id, HOUR_MS);

		const routing = storage.sessionCredentialRouting(PROVIDER, SESSION_ID);

		// Narrowed rather than compared through `?.`: an answer of `undefined` is the failure this
		// test is about, so it has to fail here rather than passing a hole to a membership check.
		const active = routing?.activeCredentialId;
		if (active === undefined) throw new Error("routing named no account while every sibling was blocked");
		expect(ids).toContain(active);
		expect(routing?.activeIsPrediction).toBe(true);
	});

	/**
	 * A USABLE CHOICE IS NOT A PREDICTION. The operator picked it, the pick is what serves, and
	 * hedging a fact the operator established themselves would read as the choice not having taken.
	 */
	test("a usable chosen account is reported as chosen and not as a guess", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const ids = await seedThree(storage);
		const chosen = ids[2];
		if (chosen === undefined) throw new Error("seed produced too few rows");

		expect(storage.selectProviderCredential(PROVIDER, chosen, { sessionId: SESSION_ID })).toBe(true);
		const routing = storage.sessionCredentialRouting(PROVIDER, SESSION_ID);

		expect(routing?.selectedCredentialId).toBe(chosen);
		expect(routing?.activeCredentialId).toBe(chosen);
		expect(routing?.activeIsPrediction).toBeFalsy();
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe(accessOf(storage, chosen));
	});

	/**
	 * A HELD CHOICE still predicts itself, because it still serves: a hold is our prediction about a
	 * quota window and no longer moves the request off the account the operator named. The card needs
	 * both facts anyway — the choice, and the deadline we believe it is under — so it can say "you
	 * chose X; we think it is out of quota until 16:03, `c` lifts the hold" rather than substituting
	 * an account nobody picked.
	 */
	test("a held chosen account keeps both the choice and the traffic, and carries its deadline", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const ids = await seedThree(storage);
		const chosen = ids[0];
		if (chosen === undefined) throw new Error("seed produced too few rows");
		expect(storage.selectProviderCredential(PROVIDER, chosen, { sessionId: SESSION_ID })).toBe(true);
		blockFor(storage, chosen, HOUR_MS);

		const routing = storage.sessionCredentialRouting(PROVIDER, SESSION_ID);

		expect(routing?.selectedCredentialId).toBe(chosen);
		expect(routing?.selectedBlockedUntilMs).toBeGreaterThan(Date.now());
		expect(routing?.activeCredentialId).toBe(chosen);
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe(accessOf(storage, chosen));
	});

	/**
	 * The prediction machinery itself, on the accounts it is actually for: with no choice recorded,
	 * a held head is substituted and the answer is marked a prediction, so the card never presents a
	 * substitute as somebody's pick.
	 */
	test("an unchosen held account is substituted, and the substitute is marked a prediction", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const storage = authStorage;
		const ids = await seedThree(storage);
		const held = ids[0];
		if (held === undefined) throw new Error("seed produced too few rows");
		blockFor(storage, held, HOUR_MS);

		const routing = storage.sessionCredentialRouting(PROVIDER, SESSION_ID);

		expect(routing?.activeCredentialId).not.toBe(held);
		expect(routing?.activeIsPrediction).toBe(true);
	});

	/** A provider that stores nothing has nothing to route, and says so by answering at all. */
	test("a provider with no credentials routes to nothing", () => {
		if (!authStorage) throw new Error("test setup failed");

		expect(authStorage.sessionCredentialRouting(PROVIDER, SESSION_ID)).toBeUndefined();
	});
});
