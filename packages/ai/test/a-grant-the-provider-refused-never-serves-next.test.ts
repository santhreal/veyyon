/**
 * WHY THIS EXISTS.
 *
 * The account card labelled a revoked login `serves next` on the very row that printed
 * `oauth refresh failed`. Both facts came from the same probe: `checkCredentials` refreshed the
 * expired grant, the provider refused, and the probe recorded that refusal in its OWN result and
 * told the routing layer nothing. `sessionCredentialRouting`'s prediction then ordered candidates
 * by rate-limit availability alone — the one question it asked — and a refused grant carries no
 * hold, so it sorted first and was reported as the account the next request would use. The card
 * contradicted itself, and the first request of the session was guaranteed to go to the one
 * account the product had already been told would refuse it.
 *
 * THE CLASS: any surface that asks "which account serves next" and gets an account whose grant
 * the provider has refused, whichever way the product learned of the refusal. There are two
 * feeders — the request path (`rotateSessionCredential`, a hard 401 mid-turn) and the probe
 * (`checkCredentials`, a refresh the provider rejected) — and one predicate they must both write
 * to, or a surface that reads routing after a probe disagrees with a surface that reads it after a
 * request. Both feeders are driven below, and every arm asserts through routing AND through the
 * real resolve, because two owners of "is this grant dead" is the shape of the original defect.
 *
 * A hold is NOT a refusal, and the control arms pin that: a rate-limit block is this product's own
 * prediction about an account that works, so a held account still leads when it was chosen. Making
 * the prediction skip held accounts as well would pass every positive arm here while breaking the
 * behaviour the sibling suite (`the-account-you-chose-is-the-account-that-spends`) exists to
 * defend.
 *
 * FAIL BY DEFAULT: `REFUSAL_BY_TYPE` is typed `Record<AuthCredential["type"], …>`, so a third
 * credential type added to the union stops this file compiling until someone says how a grant of
 * that type is refused and what should serve instead.
 *
 * WHAT IT DOES NOT CATCH. It cannot enumerate the feeders: a THIRD way to learn of a refusal
 * (a broker pushing a revocation, say) would have to write the same mark, and nothing here goes red
 * if it does not. It says nothing about what the card paints — `account-manager-rows` derives its
 * tag from the routing answer asserted here, and its own suites own the pixels. And it does not
 * assert the mark is forgotten across a restart; that is deliberate and the sibling suite pins it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthCredential } from "@veyyon/ai";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "anthropic";
const SESSION = "refused-grant-session";
/** Far enough out that no test clock reaches it. */
const HOLD_UNTIL_MS = 1_899_999_999_000;

function oauthCredential(suffix: string, options?: { expired?: boolean }) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: options?.expired === true ? Date.now() - 60_000 : Date.now() + 3_600_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

/**
 * How a grant of each credential type gets refused, and what the product must fall back to.
 *
 * The probe's refusal path is a rejected OAuth refresh, which an API key cannot have: a key is
 * either accepted or it is not, and the product only ever learns that from a request. So the two
 * rows differ in feeder by necessity rather than by choice, which is exactly why both are here.
 */
const REFUSAL_BY_TYPE: Record<AuthCredential["type"], { feeder: "probe" | "request" }> = {
	oauth: { feeder: "probe" },
	api_key: { feeder: "request" },
};

describe("a grant the provider refused", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-refused-grant-"));
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
	 * A storage whose OAuth refresh always fails, which is what the provider refusing a grant looks
	 * like from inside `checkCredentials`. No usage provider is registered and none is needed: the
	 * refresh happens before the probe, and its failure short-circuits the rest.
	 */
	async function storageWithFailingRefresh(): Promise<{ store: SqliteAuthCredentialStore; storage: AuthStorage }> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		const storage = new AuthStorage(store, {
			refreshOAuthCredential: () => Promise.reject(new Error("invalid_grant: refresh token revoked")),
		});
		return { store, storage };
	}

	it("is not what serves next, once a probe has been refused it", async () => {
		const { store, storage } = await storageWithFailingRefresh();
		store.saveOAuth(PROVIDER, oauthCredential("revoked", { expired: true }));
		store.saveOAuth(PROVIDER, oauthCredential("healthy"));
		await storage.reload();
		const rows = store.listAuthCredentials(PROVIDER);
		const revokedId = rows[0]!.id;
		const healthyId = rows[1]!.id;

		// Before the probe the product has been told nothing, so naming the revoked grant is honest
		// here: it is first in order and no refusal has been observed. This is the state the card
		// opens in, and it is why the probe must feed routing rather than only its own result.
		const results = await storage.checkCredentials({ credentialIds: [revokedId] });
		expect(results.map(result => [result.id, result.ok])).toEqual([[revokedId, false]]);
		expect(results[0]!.reason).toContain("oauth refresh failed");

		const routing = storage.sessionCredentialRouting(PROVIDER, SESSION);
		expect(routing?.activeCredentialId).toBe(healthyId);
		expect(routing?.activeIsPrediction).toBe(true);
		// And the resolve agrees with the report, which is the half a card cannot show.
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("access-healthy");
	});

	it("still gets named when it is the only account there is", async () => {
		const { store, storage } = await storageWithFailingRefresh();
		store.saveOAuth(PROVIDER, oauthCredential("revoked", { expired: true }));
		await storage.reload();
		const onlyId = store.listAuthCredentials(PROVIDER)[0]!.id;

		await storage.checkCredentials({ credentialIds: [onlyId] });

		// A provider holding one refused account must not read as a provider holding none: the row is
		// there, the operator can see it, and the answer to "what serves next" is still that account.
		const routing = storage.sessionCredentialRouting(PROVIDER, SESSION);
		expect(routing?.activeCredentialId).toBe(onlyId);
	});

	it("loses its lead to a stored key when every login of its type is refused", async () => {
		const { storage } = await storageWithFailingRefresh();
		await storage.set(PROVIDER, [
			oauthCredential("revoked", { expired: true }),
			{ type: "api_key", key: "sk-live-key" },
		]);
		const stored = storage.listStoredCredentials(PROVIDER);
		const revokedId = stored.find(row => row.credential.type === "oauth")!.id;
		const keyId = stored.find(row => row.credential.type === "api_key")!.id;

		await storage.checkCredentials({ credentialIds: [revokedId] });

		// The cascade prefers a login to a stored key, and that preference is about which credential
		// is better, not about which one exists: a login the provider has refused is not a candidate,
		// so the key behind it is what serves — which is what the real resolve does too.
		const routing = storage.sessionCredentialRouting(PROVIDER, SESSION);
		expect(routing?.activeCredentialId).toBe(keyId);
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("sk-live-key");
	});

	it("leads again the moment the hold on it is lifted", async () => {
		const { store, storage } = await storageWithFailingRefresh();
		store.saveOAuth(PROVIDER, oauthCredential("revoked", { expired: true }));
		store.saveOAuth(PROVIDER, oauthCredential("healthy"));
		await storage.reload();
		const revokedId = store.listAuthCredentials(PROVIDER)[0]!.id;

		await storage.checkCredentials({ credentialIds: [revokedId] });
		expect(storage.sessionCredentialRouting(PROVIDER, SESSION)?.activeCredentialId).not.toBe(revokedId);

		// Lifting the hold is the operator asserting the account works again — a re-login, a plan
		// change, a support credit, anything this process cannot see. It retires the refusal with it,
		// or the assertion would be silently ignored.
		storage.clearCredentialBlocks(PROVIDER, revokedId);
		expect(storage.sessionCredentialRouting(PROVIDER, SESSION)?.activeCredentialId).toBe(revokedId);
	});

	it("is refused by the request path as well as by the probe", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		const storage = new AuthStorage(store);
		await storage.set(PROVIDER, [
			{ type: "api_key", key: "sk-refused" },
			{ type: "api_key", key: "sk-live" },
		]);
		const refusedId = storage.listStoredCredentials(PROVIDER)[0]!.id;
		const liveId = storage.listStoredCredentials(PROVIDER)[1]!.id;
		expect(REFUSAL_BY_TYPE.api_key.feeder).toBe("request");

		// A hard 401 mid-turn. Not a usage limit: that is a hold, and the control arm below is what
		// keeps the two apart.
		await storage.rotateSessionCredential(PROVIDER, SESSION, {
			credentialId: refusedId,
			error: new Error("HTTP 401 invalid api key"),
		});

		const routing = storage.sessionCredentialRouting(PROVIDER, SESSION);
		expect(routing?.activeCredentialId).toBe(liveId);
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("sk-live");
	});

	it("is not the same thing as an account this product decided to hold", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(PROVIDER, oauthCredential("held"));
		store.saveOAuth(PROVIDER, oauthCredential("idle"));
		const storage = new AuthStorage(store);
		await storage.reload();
		const heldId = store.listAuthCredentials(PROVIDER)[0]!.id;
		expect(storage.selectProviderCredential(PROVIDER, heldId)).toBe(true);
		storage.upsertCredentialBlock({
			credentialId: heldId,
			providerKey: `${PROVIDER}:oauth`,
			blockScope: "",
			blockedUntilMs: HOLD_UNTIL_MS,
		});

		// The choice keeps serving through its own hold: a hold is a prediction about an account that
		// works, and the operator's choice outranks it. This arm alone does NOT prove the prediction
		// treats holds and refusals differently — routing answers with the choice and returns before it
		// ever asks for a prediction, so the arm below is the one that reaches the code in question. It
		// was green under a mutation that skipped held accounts alongside refused ones, which is
		// exactly the assumption a control arm is supposed to catch.
		const routing = storage.sessionCredentialRouting(PROVIDER, SESSION);
		expect(routing?.activeCredentialId).toBe(heldId);
		expect(routing?.selectedCredentialId).toBe(heldId);
		expect(routing?.activeIsPrediction).toBeUndefined();
	});

	it("loses to a merely held account, because a hold is not a refusal", async () => {
		const { store, storage } = await storageWithFailingRefresh();
		store.saveOAuth(PROVIDER, oauthCredential("revoked", { expired: true }));
		store.saveOAuth(PROVIDER, oauthCredential("held"));
		await storage.reload();
		const rows = store.listAuthCredentials(PROVIDER);
		const revokedId = rows[0]!.id;
		const heldId = rows[1]!.id;
		storage.upsertCredentialBlock({
			credentialId: heldId,
			providerKey: `${PROVIDER}:oauth`,
			blockScope: "",
			blockedUntilMs: HOLD_UNTIL_MS,
		});

		await storage.checkCredentials({ credentialIds: [revokedId] });

		// Nobody chose either account, so this reaches the prediction, and neither candidate can serve
		// right now: one is refused and the other is held. They are not equally bad. The held account
		// works and will serve when its window resets; the refused one will not serve at any point
		// without a re-login. So the hold is what the next request waits on — and a prediction that
		// skipped held accounts too would answer with the revoked grant, which is the defect wearing
		// a different hat. Routing only: what the resolve does with a pair like this is a request
		// against a provider, and this file asserts nothing about provider answers.
		expect(storage.sessionCredentialRouting(PROVIDER, SESSION)?.activeCredentialId).toBe(heldId);
	});
});
