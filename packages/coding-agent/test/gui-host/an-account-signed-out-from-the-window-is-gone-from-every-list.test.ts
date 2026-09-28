/**
 * WHY: the terminal's `/logout` and its account card remove one stored
 * credential and leave the provider's other accounts signed in. The window had
 * no way to do either: it was told which providers were authenticated but not
 * which accounts were stored, and it had no action that removed one, so an
 * account signed in from the desktop could only be removed from a terminal.
 *
 * This suite drives the real host over its socket against a throwaway
 * credential store and defends:
 * 1. `RefreshProviders` states the stored accounts as the rows the terminal's
 *    account card lists, labelled the way the card labels them.
 * 2. `SignOutAccount` removes the one credential it names from the store and
 *    answers with the account list, the provider list and the model list as
 *    they stand after the removal, so one sign-out leaves the provider's other
 *    account signed in and the last one signs the provider out.
 * 3. A credential that is not stored is refused in the `Authentication` scope
 *    and removes nothing.
 *
 * Not caught: a key the provider reads from an environment variable or a
 * config file, which is not stored and which no sign-out removes; and what the
 * window draws for the rows, which the desktop's own view tests own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@veyyon/ai";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { ModelsView, ProviderView, StoredAccountView } from "../../src/gui-host/wire";
import { accountDisplayLabel, buildAccountInventory } from "../../src/session/account-inventory";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

const PROVIDER = "anthropic";

/** The last `Accounts` section a request's frames carried. */
function accountsIn(frames: RequestFrame[]): StoredAccountView[] | undefined {
	return snapshotSections<StoredAccountView[]>(frames, "Accounts").at(-1);
}

/** Whether the last `Providers` section a request's frames carried states `PROVIDER` authenticated. */
function providerAuthenticated(frames: RequestFrame[]): boolean | undefined {
	return snapshotSections<ProviderView[]>(frames, "Providers")
		.at(-1)
		?.find(provider => provider.id === PROVIDER)?.authenticated;
}

describe("an account signed out from the window is gone from every list", () => {
	let dir = "";
	let authStorage: AuthStorage;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	let first = 0;
	let second = 0;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-sign-out-"));
		authStorage = await isolatedAuthStorage(dir);
		await authStorage.set(PROVIDER, [
			{ type: "api_key", key: "sk-ant-first-account" },
			{ type: "api_key", key: "sk-ant-second-account" },
		]);
		[first, second] = authStorage.listStoredCredentials(PROVIDER).map(stored => stored.id);
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: dir, agentDir: dir, authStorage });
		client = await TestSocketClient.connect(server.endpoint);
	});

	afterEach(async () => {
		client?.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("the accounts section lists the rows the terminal's account card lists", async () => {
		const { frames, outcome } = await client.request(1, "RefreshProviders");
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });

		const card = buildAccountInventory(authStorage).providers.flatMap(entry => entry.rows);
		expect(card.map(row => row.credentialId)).toEqual([first, second]);
		expect(accountsIn(frames)).toEqual(
			card.map(row => ({
				provider: PROVIDER,
				credential_id: row.credentialId,
				label: accountDisplayLabel(row),
				kind: "api_key",
				selected: row.selectedForProvider,
			})),
		);
	});

	test("signing out one account leaves the provider's other account signed in", async () => {
		const { frames, outcome } = await client.request(2, {
			SignOutAccount: { provider: PROVIDER, credential_id: first },
		});
		expect(outcome).toEqual({ RequestSucceeded: { request: 2 } });

		expect(accountsIn(frames)?.map(account => account.credential_id)).toEqual([second]);
		expect(providerAuthenticated(frames)).toBe(true);
		await authStorage.reload();
		expect(authStorage.listStoredCredentials(PROVIDER).map(stored => stored.id)).toEqual([second]);
	});

	test("signing out the last account signs the provider out and drops its models", async () => {
		const before = await client.request(3, "RefreshModels");
		const listed = snapshotSections<ModelsView>(before.frames, "Models").at(-1);
		expect(listed?.models.some(model => model.provider === PROVIDER)).toBe(true);

		await client.request(4, { SignOutAccount: { provider: PROVIDER, credential_id: first } });
		const { frames, outcome } = await client.request(5, {
			SignOutAccount: { provider: PROVIDER, credential_id: second },
		});
		expect(outcome).toEqual({ RequestSucceeded: { request: 5 } });

		expect(accountsIn(frames)).toEqual([]);
		expect(providerAuthenticated(frames)).toBe(false);
		const models = snapshotSections<ModelsView>(frames, "Models").at(-1);
		expect(models?.models.filter(model => model.provider === PROVIDER)).toEqual([]);
	});

	test("a credential that is not stored is refused and removes nothing", async () => {
		const missing = Math.max(first, second) + 1000;
		const { outcome } = await client.request(6, {
			SignOutAccount: { provider: PROVIDER, credential_id: missing },
		});

		expect(outcome.RequestFailed?.error).toMatchObject({ scope: "Authentication", code: "ACCOUNT_NOT_STORED" });
		await authStorage.reload();
		expect(authStorage.listStoredCredentials(PROVIDER).map(stored => stored.id)).toEqual([first, second]);
	});
});
