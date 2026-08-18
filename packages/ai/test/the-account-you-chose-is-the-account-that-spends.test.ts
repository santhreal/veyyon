/**
 * WHY THIS EXISTS.
 *
 * An operator chose one account for a provider, the product spent a different one, and there was no
 * way back. Three mechanisms did it, none of which asked whether anybody had chosen anything:
 *
 *  1. `#orderByBlockAvailability` sorted a held account behind an unblocked sibling, and the stored
 *     choice reaches selection as the head of that order — so a hold walked the request off it.
 *  2. Usage ranking picked whichever account had the most headroom, over the top of the choice.
 *  3. The strict resolution pass skipped every held candidate before the provider was ever asked.
 *
 * A hold is OUR prediction, not the provider's ruling. It is written from a 429 we saw, a usage
 * report, or a backoff default, and nothing in it knows about a limit reset redeemed on the
 * provider's own site, a plan change, or a support credit. So an operator with a freshly reset
 * account watched a countdown they could not clear spend a different subscription.
 *
 * And the hold could not be lifted: `clearCredentialBlocks` was private, reachable only from the
 * Codex saved-reset path, and keyed `provider:oauth` regardless of the row's real type, so a held
 * API-key account had no clearing path at all.
 *
 * THE CLASS: any mechanism that moves a request off the account the operator explicitly chose, and
 * any hold this product invented that nothing but time can clear. `accounts.loadBalancing` governs
 * what the product does on its OWN initiative; it never governs what the operator may ask for, so
 * the choice wins with movement on as well as off. Automation among accounts nobody named is
 * untouched, and the arms below pin that too, or "honour the choice" would be indistinguishable
 * from "never move".
 *
 * A choice is not a licence to strand the session, so two boundaries are pinned as well. A grant the
 * provider REFUSED (a hard 401, not a quota hold) stops leading, because that verdict is the
 * provider's and not ours, and lifting the hold on that account is the operator asserting it works
 * again. And the routing report has to distinguish the two: a held choice is what serves next and
 * says so, while an account nobody named is a prediction and must be labelled one.
 *
 * WHAT IT DOES NOT CATCH. It says nothing about whether the provider actually serves the chosen
 * account — that is the provider's answer, and letting it be asked is the point. It does not assert
 * what the account card paints; the card's own suites do.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "anthropic";
const OAUTH_KEY = "anthropic:oauth";
const API_KEY_KEY = "anthropic:api_key";
/** Far enough out that no test clock reaches it. */
const HOLD_UNTIL_MS = 1_899_999_999_000;

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("the account an operator chose", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-chosen-account-"));
		dbPath = path.join(tempDir, "agent.db");
	});

	afterEach(async () => {
		dbPath = "";
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/**
	 * Two OAuth accounts on a real store, the first one held. `choose: false` records no choice at
	 * all, which is what the automatic arms need: with nobody named, the product decides.
	 */
	async function twoAccountsFirstHeld(options?: { loadBalancing?: boolean; choose?: boolean }): Promise<{
		storage: AuthStorage;
		heldId: number;
	}> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(PROVIDER, oauthCredential("chosen"));
		store.saveOAuth(PROVIDER, oauthCredential("sibling"));
		const storage =
			options?.loadBalancing === undefined
				? new AuthStorage(store)
				: new AuthStorage(store, { loadBalancing: options.loadBalancing });
		await storage.reload();
		const heldId = store.listAuthCredentials(PROVIDER)[0]!.id;
		if (options?.choose !== false) {
			expect(storage.selectProviderCredential(PROVIDER, heldId)).toBe(true);
		}
		storage.upsertCredentialBlock({
			credentialId: heldId,
			providerKey: OAUTH_KEY,
			blockScope: "",
			blockedUntilMs: HOLD_UNTIL_MS,
		});
		return { storage, heldId };
	}

	it("spends it while a hold is on it, with nobody having turned account movement on", async () => {
		// The default arm: no `loadBalancing` option at all, which is every embedder that passes none
		// and the value the shipped setting resolves to.
		const { storage } = await twoAccountsFirstHeld();
		try {
			expect(await storage.getApiKey(PROVIDER, "session-1")).toBe("access-chosen");
		} finally {
			storage.close();
		}
	});

	it("spends it while a hold is on it even with account movement ON", async () => {
		// The operator overrides the automation, not the other way round. Movement on means the product
		// may move among accounts nobody named; it never means a choice can be overruled.
		const { storage } = await twoAccountsFirstHeld({ loadBalancing: true });
		try {
			expect(await storage.getApiKey(PROVIDER, "session-1")).toBe("access-chosen");
		} finally {
			storage.close();
		}
	});

	it("does not stop an unchosen held account from being left for a sibling", async () => {
		// The negative control that keeps the arms above from being satisfied by "never move": with no
		// choice recorded, a hold still sorts the account behind a usable sibling.
		const { storage } = await twoAccountsFirstHeld({ loadBalancing: true, choose: false });
		try {
			expect(await storage.getApiKey(PROVIDER, "session-1")).toBe("access-sibling");
		} finally {
			storage.close();
		}
	});

	it("keeps spending across a reload, because a choice outlives the process", async () => {
		const { storage } = await twoAccountsFirstHeld();
		storage.close();
		const reopened = new AuthStorage(await SqliteAuthCredentialStore.open(dbPath));
		await reopened.reload();
		try {
			expect(await reopened.getApiKey(PROVIDER, "session-2")).toBe("access-chosen");
		} finally {
			reopened.close();
		}
	});

	it("can have its hold lifted, and the lift survives a reload", async () => {
		const { storage, heldId } = await twoAccountsFirstHeld({ loadBalancing: true });
		try {
			expect(storage.credentialBlockedUntil(PROVIDER, OAUTH_KEY, 0)).toBe(HOLD_UNTIL_MS);
			storage.clearCredentialBlocks(PROVIDER, heldId);
			expect(storage.credentialBlockedUntil(PROVIDER, OAUTH_KEY, 0)).toBeUndefined();
			expect(storage.listCredentialBlocks([heldId])).toEqual([]);
			expect(await storage.getApiKey(PROVIDER, "session-3")).toBe("access-chosen");
		} finally {
			storage.close();
		}

		const reopened = new AuthStorage(await SqliteAuthCredentialStore.open(dbPath), { loadBalancing: true });
		await reopened.reload();
		try {
			expect(reopened.credentialBlockedUntil(PROVIDER, OAUTH_KEY, 0)).toBeUndefined();
		} finally {
			reopened.close();
		}
	});

	it("spends the held API key too, because a key is an account like any other", async () => {
		// The same class on the other credential type: the override must live where accounts are
		// ordered, not in the OAuth path alone, or half the product still overrules the operator.
		const store = await SqliteAuthCredentialStore.open(dbPath);
		const storage = new AuthStorage(store, { loadBalancing: true });
		await storage.set(PROVIDER, [
			{ type: "api_key", key: "key-chosen" },
			{ type: "api_key", key: "key-sibling" },
		]);
		try {
			const chosenId = store.listAuthCredentials(PROVIDER)[0]!.id;
			expect(storage.selectProviderCredential(PROVIDER, chosenId)).toBe(true);
			storage.upsertCredentialBlock({
				credentialId: chosenId,
				providerKey: API_KEY_KEY,
				blockScope: "",
				blockedUntilMs: HOLD_UNTIL_MS,
			});
			expect(await storage.getApiKey(PROVIDER, "session-4")).toBe("key-chosen");
		} finally {
			storage.close();
		}
	});

	it("can have an API-key hold lifted, which nothing could do before", async () => {
		// The lift read `provider:oauth` for every row, so a held API-key account could not be freed
		// by anything at all, including the redeem path that was its only caller.
		const store = await SqliteAuthCredentialStore.open(dbPath);
		const storage = new AuthStorage(store, { loadBalancing: true });
		await storage.set(PROVIDER, [
			{ type: "api_key", key: "key-chosen" },
			{ type: "api_key", key: "key-sibling" },
		]);
		try {
			const heldId = store.listAuthCredentials(PROVIDER)[0]!.id;
			storage.upsertCredentialBlock({
				credentialId: heldId,
				providerKey: API_KEY_KEY,
				blockScope: "",
				blockedUntilMs: HOLD_UNTIL_MS,
			});
			expect(storage.credentialBlockedUntil(PROVIDER, API_KEY_KEY, 0)).toBe(HOLD_UNTIL_MS);
			// Unchosen and held, so automation is free to route around it.
			expect(await storage.getApiKey(PROVIDER, "session-5")).toBe("key-sibling");

			storage.clearCredentialBlocks(PROVIDER, heldId);

			expect(storage.credentialBlockedUntil(PROVIDER, API_KEY_KEY, 0)).toBeUndefined();
			expect(storage.listCredentialBlocks([heldId])).toEqual([]);
			expect(await storage.getApiKey(PROVIDER, "session-5")).toBe("key-chosen");
		} finally {
			storage.close();
		}
	});

	it("stops pinning traffic to a grant the provider refused, and leads with it again once revived", async () => {
		// A hold is our prediction and the choice outranks it; a 401 is the provider's verdict and
		// outranks the choice, or a revoked grant would be retried until the turn died. Lifting the
		// hold is the operator asserting the account works, which is what makes the choice honourable
		// again — so the round trip, not just the drop, is the contract.
		const { storage, heldId } = await twoAccountsFirstHeld();
		try {
			expect(
				await storage.rotateSessionCredential(PROVIDER, "session-6", { error: new Error("invalid_grant") }),
			).toBe(true);
			expect(await storage.getApiKey(PROVIDER, "session-6")).toBe("access-sibling");

			storage.clearCredentialBlocks(PROVIDER, heldId);

			expect(await storage.getApiKey(PROVIDER, "session-6")).toBe("access-chosen");
		} finally {
			storage.close();
		}
	});

	it("reports a held choice as the account serving next, not as a guess", async () => {
		// The card reads this. While the hold moved traffic off the choice, reporting the choice as
		// active would have been a lie; now that the choice is honoured, reporting it as a PREDICTION
		// is the lie, and the operator cannot tell whether the account they picked is spending.
		const { storage, heldId } = await twoAccountsFirstHeld();
		try {
			expect(storage.sessionCredentialRouting(PROVIDER, "session-7")).toEqual({
				provider: PROVIDER,
				selectedCredentialId: heldId,
				selectedBlockedUntilMs: HOLD_UNTIL_MS,
				activeCredentialId: heldId,
			});
		} finally {
			storage.close();
		}
	});

	it("still labels a substitute nobody chose as a prediction", async () => {
		// The negative control for the arm above: with no choice recorded and nothing spent yet, the
		// answer is replayed selection rather than observed traffic, and saying so is the whole reason
		// the flag exists.
		const { storage } = await twoAccountsFirstHeld({ choose: false });
		try {
			const routing = storage.sessionCredentialRouting(PROVIDER, "session-8");
			expect(routing?.selectedCredentialId).toBeUndefined();
			expect(routing?.activeIsPrediction).toBe(true);
		} finally {
			storage.close();
		}
	});
});
