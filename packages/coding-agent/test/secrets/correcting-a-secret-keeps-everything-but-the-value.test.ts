/**
 * `SecretVault.replaceValue`: correcting a credential without minting a new one.
 *
 * WHY THIS EXISTS. The vault could add, remove, rename, extend and move. It could not change a
 * VALUE. A token pasted with a character missing, or rotated at the provider, had to be revoked and
 * stored again, which is two different losses: the name goes, and every prompt in the session that
 * already spends `#NAME#` now spends a placeholder nothing resolves; and the entry is re-dated, so a
 * secret with two days left comes back with the default lifetime.
 *
 * WHAT THIS SUITE CLOSES. The write touches the value and NOTHING else, on every field the entry
 * has, for a target in any scope; a value the vault would refuse from `add` is refused here by the
 * same rule rather than by a second copy of it; and a name that is not in the vault is reported as
 * such instead of silently creating an entry. The class is "an edit path that quietly differs from
 * the store path", which is why the field-by-field comparison below is derived from the stored
 * entry's own keys rather than from a list of fields somebody remembered.
 *
 * WHAT IT DOES NOT CATCH. Whether the running session picks the new value up: that is the card's
 * `refreshSecrets` wiring, asserted in `secret-manager-credential-management.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretVault, type VaultScope } from "@veyyon/coding-agent/secrets/vault";

/** Long enough to clear the obfuscatable-length floor; the vault refuses anything shorter. */
const ORIGINAL = "ghp_originalCredential001";
const CORRECTED = "ghp_correctedCredential02";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-31T12:00:00Z");

async function freshVault(): Promise<{ vault: SecretVault; cleanup: () => Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-correct-secret-"));
	const vault = new SecretVault(
		{
			globalConfigRoot: path.join(root, "global"),
			profileDir: path.join(root, "profile"),
			projectDir: path.join(root, "project"),
		},
		() => NOW,
	);
	return { vault, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

describe("replacing a credential's value", () => {
	/**
	 * THE WHOLE CONTRACT, asserted field by field and derived from the entry itself.
	 *
	 * Comparing the two entries key by key is what makes this close the class: an implementation that
	 * rebuilt the entry, or routed through `add`, would carry a new `createdAt` and a new `expiresAt`,
	 * and a test naming only the fields somebody thought of would not see the third one.
	 */
	it("changes the value and nothing else about the entry", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			await vault.add({ name: "GITHUB_TOKEN", value: ORIGINAL, scope: "profile", ttl: 2 * DAY });
			const before = (await vault.loadEverywhere()).find(entry => entry.name === "GITHUB_TOKEN");
			expect(before).toBeDefined();
			if (before === undefined) return;

			const replaced = await vault.replaceValue("GITHUB_TOKEN", CORRECTED);
			expect(replaced?.value).toBe(CORRECTED);

			const after = (await vault.loadEverywhere()).find(entry => entry.name === "GITHUB_TOKEN");
			expect(after).toBeDefined();
			if (after === undefined) return;
			const changed = Object.keys(before).filter(
				key => before[key as keyof typeof before] !== after[key as keyof typeof after],
			);
			expect(changed).toEqual(["value"]);
		} finally {
			await cleanup();
		}
	});

	/**
	 * The name is normalised the way every other entry point normalises it, so the entry an operator
	 * points at from a prompt is the entry that is edited. Without this, `github-token` would report
	 * "not in the vault" for a credential that is plainly on screen as `#GITHUB_TOKEN#`.
	 */
	it("finds the entry through the vault's own name normalisation", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			await vault.add({ name: "GITHUB_TOKEN", value: ORIGINAL, scope: "profile" });
			const replaced = await vault.replaceValue("  github-token  ", CORRECTED);
			expect(replaced?.name).toBe("GITHUB_TOKEN");
			expect(replaced?.value).toBe(CORRECTED);
		} finally {
			await cleanup();
		}
	});

	/**
	 * EVERY SCOPE, not the one the author had in mind. The walk is narrowest first, which is the
	 * order a placeholder resolves in, so the entry that is edited is the entry that would have been
	 * spent. A scope this loop cannot reach is a credential that cannot be corrected at all.
	 */
	const SCOPES: readonly VaultScope[] = ["global", "profile", "project"];
	for (const scope of SCOPES) {
		it(`edits an entry stored in the ${scope} vault, in place`, async () => {
			const { vault, cleanup } = await freshVault();
			try {
				await vault.add({ name: "DEPLOY_KEY", value: ORIGINAL, scope });
				const replaced = await vault.replaceValue("DEPLOY_KEY", CORRECTED);
				expect(replaced?.scope).toBe(scope);
				const stored = await vault.loadEverywhere();
				expect(stored.filter(entry => entry.name === "DEPLOY_KEY")).toHaveLength(1);
				expect(stored.find(entry => entry.name === "DEPLOY_KEY")?.value).toBe(CORRECTED);
			} finally {
				await cleanup();
			}
		});
	}

	/**
	 * Two scopes holding the same name is legal, and the narrower copy is the one a placeholder
	 * spends. Editing the wider one would leave the operator correcting a credential and watching the
	 * old value keep going out, with the card showing the corrected one.
	 */
	it("edits the narrowest copy when a name is held in more than one scope", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			await vault.add({ name: "SHARED_TOKEN", value: ORIGINAL, scope: "global" });
			await vault.add({ name: "SHARED_TOKEN", value: "ghp_projectCredential001", scope: "project" });

			const replaced = await vault.replaceValue("SHARED_TOKEN", CORRECTED);
			expect(replaced?.scope).toBe("project");

			const stored = await vault.loadEverywhere();
			expect(stored.find(entry => entry.scope === "project")?.value).toBe(CORRECTED);
			expect(stored.find(entry => entry.scope === "global")?.value).toBe(ORIGINAL);
		} finally {
			await cleanup();
		}
	});

	/**
	 * A missing name is reported, not created. `add` under an unknown name is a legitimate store;
	 * `replaceValue` under one is a mistake, and inventing the entry would hide the mistake behind a
	 * credential that authenticates against nothing.
	 */
	it("reports null for a name the vault does not hold, and stores nothing", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			expect(await vault.replaceValue("ABSENT_TOKEN", CORRECTED)).toBeNull();
			expect(await vault.loadEverywhere()).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	/**
	 * An expired entry is not a target. It cannot be spent, and editing it would resurrect a
	 * credential the operator's own expiry decided was over.
	 */
	it("does not edit an entry whose expiry has passed", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-correct-expired-"));
		let clock = NOW;
		const vault = new SecretVault(
			{
				globalConfigRoot: path.join(root, "global"),
				profileDir: path.join(root, "profile"),
				projectDir: path.join(root, "project"),
			},
			() => clock,
		);
		try {
			await vault.add({ name: "SHORT_LIVED", value: ORIGINAL, scope: "profile", ttl: DAY });
			clock = NOW + 2 * DAY;
			expect(await vault.replaceValue("SHORT_LIVED", CORRECTED)).toBeNull();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	/**
	 * THE VALUE RULES ARE ONE RULE. A value under the obfuscation floor is refused here with the
	 * sentence `add` uses, because they call the same guard. Two copies of this limit is a value that
	 * is refused when it is stored and accepted when it is corrected, and the second write is the one
	 * nobody exercises by hand.
	 */
	it("refuses a value the store path would refuse, with the same sentence", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			await vault.add({ name: "GITHUB_TOKEN", value: ORIGINAL, scope: "profile" });

			const fromAdd = await vault
				.add({ name: "OTHER_TOKEN", value: "pin1234", scope: "profile" })
				.then(() => null)
				.catch((error: unknown) => (error as Error).message);
			const fromEdit = await vault
				.replaceValue("GITHUB_TOKEN", "pin1234")
				.then(() => null)
				.catch((error: unknown) => (error as Error).message);

			expect(fromAdd).not.toBeNull();
			expect(fromEdit).toBe(fromAdd);
			// And the credential it was pointed at is untouched.
			expect((await vault.loadEverywhere()).find(entry => entry.name === "GITHUB_TOKEN")?.value).toBe(ORIGINAL);
		} finally {
			await cleanup();
		}
	});

	/**
	 * An empty value is refused as empty. Reaching the vault with one would replace a working
	 * credential with a placeholder that expands to nothing, which is the failure mode a correction is
	 * most likely to arrive as: the operator cleared the field and pressed enter.
	 */
	it("refuses an empty value and keeps the credential", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			await vault.add({ name: "GITHUB_TOKEN", value: ORIGINAL, scope: "profile" });
			await expect(vault.replaceValue("GITHUB_TOKEN", "")).rejects.toThrow("A secret cannot be empty.");
			expect((await vault.loadEverywhere()).find(entry => entry.name === "GITHUB_TOKEN")?.value).toBe(ORIGINAL);
		} finally {
			await cleanup();
		}
	});
});
