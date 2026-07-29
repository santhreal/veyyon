/**
 * Store a secret and spend it in the same session, with no refresh in between.
 *
 * THE BUG THIS LOCKS OUT. This is the primary secret workflow and it was exactly the case that
 * broke. `/secret add` publishes a new vault inode, which moved `revision()`, so the session that
 * had just stored the credential decided its own captured revision was stale. Downstream that
 * read as "the vault changed in another session or process" and the expansion was refused, so the
 * user could not spend the secret they had just added, in the session they had just added it in.
 *
 * The two halves are asserted together on purpose. Freshness alone proves nothing if the value no
 * longer expands, and expansion alone proves nothing if the guard would have refused first.
 *
 * IF THIS REGRESSES: `/secret add` followed by a command using the placeholder fails, which is the
 * feature's entire happy path.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets";
import { buildNamePlaceholder } from "@veyyon/coding-agent/secrets/placeholder";
import { SecretVault, type VaultLocations } from "@veyyon/coding-agent/secrets/vault";

const roots = new Set<string>();

const TOKEN_VALUE = "ghp_a_real_looking_credential_value";

interface Session {
	readonly locations: VaultLocations;
	readonly vault: SecretVault;
	readonly obfuscator: SecretObfuscator;
	/** What the real add path does after a write: reload the vault into the live obfuscator. */
	reconcile(): Promise<void>;
}

async function session(): Promise<Session> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-add-then-spend-"));
	roots.add(root);
	const locations: VaultLocations = {
		globalConfigRoot: path.join(root, "config"),
		profileDir: path.join(root, "config", "profiles", "work", "agent"),
		projectDir: path.join(root, "project", ".veyyon"),
	};
	const vault = new SecretVault(locations);
	const obfuscator = new SecretObfuscator([]);
	return {
		locations,
		vault,
		obfuscator,
		async reconcile() {
			for (const secret of await vault.namedSecrets()) {
				obfuscator.addNamedSecret(secret.name, secret.value, secret.expiresAt);
			}
		},
	};
}

afterEach(async () => {
	await Promise.all([...roots].map(root => fs.rm(root, { recursive: true, force: true })));
	roots.clear();
});

describe("a session can spend a secret it just added", () => {
	/** The whole workflow, on a session that already held a secret when the revision was captured. */
	it("stays fresh and expands the new placeholder after its own add", async () => {
		const { vault, obfuscator, reconcile } = await session();
		await vault.add({ name: "EXISTING_TOKEN", value: "an_existing_credential_value", scope: "profile", ttl: null });
		await reconcile();
		// Captured the way the freshness guard captures it: once, after loading named secrets.
		const capturedRevision = vault.revision();

		await vault.add({ name: "DEPLOY_TOKEN", value: TOKEN_VALUE, scope: "profile", ttl: null });
		await reconcile();

		expect(vault.revision()).toBe(capturedRevision);
		const command = `curl -H "Authorization: Bearer ${buildNamePlaceholder("DEPLOY_TOKEN")}" https://example.test`;
		expect(obfuscator.containsLivePlaceholder(command)).toBe(true);
		expect(obfuscator.deobfuscate(command)).toBe(
			`curl -H "Authorization: Bearer ${TOKEN_VALUE}" https://example.test`,
		);
	});

	/** The same workflow on a first-run session, where the add has to create the vault file. */
	it("stays fresh and expands when the add creates the vault from nothing", async () => {
		const { vault, obfuscator, reconcile } = await session();
		const capturedRevision = vault.revision();

		await vault.add({ name: "FIRST_TOKEN", value: TOKEN_VALUE, scope: "profile", ttl: null });
		await reconcile();

		expect(vault.revision()).toBe(capturedRevision);
		const command = `deploy --token ${buildNamePlaceholder("FIRST_TOKEN")}`;
		expect(obfuscator.containsLivePlaceholder(command)).toBe(true);
		expect(obfuscator.deobfuscate(command)).toBe(`deploy --token ${TOKEN_VALUE}`);
	});

	/** Rotating a credential is an add over an existing name, and must not strand the session. */
	it("stays fresh and expands the rotated value after rotating in place", async () => {
		const { vault, obfuscator, reconcile } = await session();
		await vault.add({ name: "ROTATING_TOKEN", value: "the_old_credential_value", scope: "profile", ttl: null });
		await reconcile();
		const capturedRevision = vault.revision();

		await vault.add({ name: "ROTATING_TOKEN", value: TOKEN_VALUE, scope: "profile", ttl: null });
		await reconcile();

		expect(vault.revision()).toBe(capturedRevision);
		expect(obfuscator.deobfuscate(buildNamePlaceholder("ROTATING_TOKEN"))).toBe(TOKEN_VALUE);
	});
});
