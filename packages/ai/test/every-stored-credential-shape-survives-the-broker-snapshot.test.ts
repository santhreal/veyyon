/**
 * WHY: the broker's wire schemas reject unknown keys, and `apiKeyCredentialSchema`
 * omitted `source`, the field `AuthStorage` writes when a key arrives from an
 * interactive login. The broker persisted and served such a credential, and every
 * client then failed the whole snapshot with "credentials[N].credential.source must
 * be removed" — one logged-in API key made the entire credential pool unreadable, so
 * containerized eval trials ran with no auth and scored zero.
 *
 * The class this closes: a field of a stored credential that the wire schemas do not
 * carry. Each shape is written through the real broker over HTTP and read back by a
 * fresh client, so both directions (`writableAuthCredentialSchema` on upload,
 * `snapshotResponseSchema` on read) are exercised, and the assertion is that every
 * field is preserved rather than that a specific key is allowed. The strictness the
 * schemas exist for is pinned too: a key no credential type declares is still refused.
 *
 * What it does not catch: a field that exists only on a credential shape not listed in
 * SHAPES (the list cannot be derived from TypeScript types at run time), and a
 * semantic mismatch where a field survives with the wrong meaning.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredential, AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@veyyon/ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@veyyon/ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";

interface Shape {
	readonly label: string;
	readonly provider: string;
	readonly credential: AuthCredential;
}

/** Every credential shape `AuthStorage` writes today, with each optional field set. */
const SHAPES: readonly Shape[] = [
	{
		label: "api key pasted by hand",
		provider: "opencode-zen",
		credential: { type: "api_key", key: "sk-pasted" },
	},
	{
		label: "api key minted by an interactive login",
		provider: "opencode-go",
		credential: { type: "api_key", key: "sk-login", source: "login" },
	},
	{
		label: "oauth with account identity and endpoint overrides",
		provider: "anthropic",
		credential: {
			type: "oauth",
			access: "access-oauth",
			refresh: "refresh-oauth",
			expires: Date.now() + 60_000,
			apiEndpoint: "https://api.example.com",
			enterpriseUrl: "https://enterprise.example.com",
			projectId: "project-1",
			email: "person@example.com",
			accountId: "account-1",
			orgId: "org-1",
			orgName: "Org One",
		},
	},
];

describe("every stored credential shape survives the broker snapshot", () => {
	let tempDir = "";
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	let clientStorage: AuthStorage | undefined;
	const token = "credential-shape-bearer";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-credential-shapes-"));
		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		serverStorage = new AuthStorage(serverStore);
		await serverStorage.reload();
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle.url, token }),
			streamSnapshots: false,
		});
		clientStorage = new AuthStorage(remote);
		await clientStorage.reload();
	});

	afterEach(async () => {
		clientStorage?.close();
		await handle?.close();
		serverStorage?.close();
		serverStore?.close();
		await removeWithRetries(tempDir);
	});

	test("a fresh client reads back every field of every shape in one snapshot", async () => {
		for (const shape of SHAPES) {
			await clientStorage!.set(shape.provider, shape.credential);
		}

		const result = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (result.status !== 200) throw new Error(`expected a snapshot, got status ${result.status}`);
		expect(result.snapshot.credentials).toHaveLength(SHAPES.length);

		for (const shape of SHAPES) {
			const entry = result.snapshot.credentials.find(candidate => candidate.provider === shape.provider);
			expect(entry, `${shape.label}: no snapshot entry`).toBeDefined();
			const served = entry!.credential as unknown as Record<string, unknown>;
			// `refresh` is deliberately redacted to the sentinel; every other field
			// must arrive exactly as stored.
			const expected: Record<string, unknown> = { ...(shape.credential as unknown as Record<string, unknown>) };
			if (expected.type === "oauth") expected.refresh = REMOTE_REFRESH_SENTINEL;
			expect(served, shape.label).toMatchObject(expected);
			expect(Object.keys(served).sort(), `${shape.label}: field dropped or added`).toEqual(
				Object.keys(expected).sort(),
			);
		}
	});

	test("a key no credential shape declares is still refused, in both directions", async () => {
		const bogus = { type: "api_key", key: "sk-bogus", nonsense: "x" } as unknown as AuthCredential;
		await expect(clientStorage!.set("devin", bogus)).rejects.toThrow(/400 Bad Request/);

		// And a fresh client still reads the pool: the refused write left nothing behind.
		const result = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (result.status !== 200) throw new Error(`expected a snapshot, got status ${result.status}`);
		expect(result.snapshot.credentials.map(entry => entry.provider)).toEqual([]);
	});
});
