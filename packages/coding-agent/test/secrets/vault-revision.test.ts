/**
 * Runtime revocation fingerprints for named-secret vaults.
 *
 * A request captures this fingerprint after loading vault values. Any path, parent, or vault
 * identity change must invalidate that request before it can expand the captured plaintext.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretVault, type VaultLocations, vaultPathFor } from "@veyyon/coding-agent/secrets/vault";

const roots = new Set<string>();

async function fixture(): Promise<{ root: string; locations: VaultLocations; vault: SecretVault }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-vault-revision-"));
	roots.add(root);
	const locations: VaultLocations = {
		globalConfigRoot: path.join(root, "global"),
		profileDir: path.join(root, "profile"),
		projectDir: path.join(root, "project"),
	};
	return { root, locations, vault: new SecretVault(locations) };
}

afterEach(async () => {
	await Promise.all([...roots].map(root => fs.rm(root, { recursive: true, force: true })));
	roots.clear();
});

describe("vault revision", () => {
	/** An unchanged filesystem must not spuriously revoke a request between capture and dispatch. */
	it("is stable while every scope inode is unchanged", async () => {
		const { vault } = await fixture();
		await vault.add({ name: "STABLE_TOKEN", value: "stable_secret_value" });

		const captured = vault.revision();
		expect(vault.revision()).toBe(captured);
		expect(captured).toMatch(/^[0-9a-f]{64}$/);
	});

	/** Creating a previously absent scope boundary changes what future vault resolution may read. */
	it("changes when an absent scope directory appears", async () => {
		const { locations, vault } = await fixture();
		const captured = vault.revision();

		await fs.mkdir(locations.projectDir);
		expect(vault.revision()).not.toBe(captured);
	});

	/** Atomic replacement must revoke values loaded from the old vault even when its bytes match. */
	it("changes when a vault is replaced by a byte-identical inode", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: "ROTATED_TOKEN", value: "rotated_secret_value" });
		const vaultPath = vaultPathFor(locations, "profile");
		const replacement = path.join(locations.profileDir, "replacement-vault");
		const captured = vault.revision();
		await fs.writeFile(replacement, await fs.readFile(vaultPath), { mode: 0o600 });

		await fs.rename(replacement, vaultPath);
		expect(vault.revision()).not.toBe(captured);
	});

	/** Equal-size in-place rollback with restored mtime still changes ctime and revokes the lease. */
	it("changes when vault bytes roll back inside the same inode", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: "ROLLBACK_TOKEN", value: "first_secret_value" });
		const vaultPath = vaultPathFor(locations, "profile");
		const priorBytes = await fs.readFile(vaultPath);
		await vault.add({ name: "ROLLBACK_TOKEN", value: "other_secret_value" });
		const currentStat = await fs.stat(vaultPath);
		const captured = vault.revision();
		expect(priorBytes.byteLength).toBe(currentStat.size);

		await fs.writeFile(vaultPath, priorBytes);
		await fs.utimes(vaultPath, currentStat.atime, currentStat.mtime);
		expect(vault.revision()).not.toBe(captured);
	});

	/** Adding a second path to the same ciphertext changes the vault's accepted path policy. */
	it("changes when a vault gains a hard-link alias", async () => {
		if (process.platform === "win32") return;
		const { root, locations, vault } = await fixture();
		await vault.add({ name: "ALIASED_TOKEN", value: "aliased_secret_value" });
		const vaultPath = vaultPathFor(locations, "profile");
		const captured = vault.revision();

		await fs.link(vaultPath, path.join(root, "vault-alias"));
		expect(vault.revision()).not.toBe(captured);
	});

	/** Replacing the scope directory revokes the old physical ownership boundary before expansion. */
	it("changes when a scope parent is replaced", async () => {
		if (process.platform === "win32") return;
		const { root, locations, vault } = await fixture();
		await vault.add({ name: "PARENT_TOKEN", value: "parent_secret_value" });
		const captured = vault.revision();
		const displaced = path.join(root, "displaced-profile");
		await fs.rename(locations.profileDir, displaced);
		await fs.mkdir(locations.profileDir);

		expect(vault.revision()).not.toBe(captured);
	});
});
