/**
 * Relabelling a stored credential, without changing anything else about it.
 *
 * A rename is the one vault mutation that touches only the label, so every property the
 * operator relies on - the value the placeholder expands to, and the moment the entry dies -
 * has to survive it byte for byte. It is also the one mutation with no legitimate reading of
 * "land on an existing name": `add` overwrites on purpose because that is how a credential is
 * rotated, but a rename carries no new value, so overwriting could only destroy a live secret
 * in exchange for nothing. These tests hold both halves of that.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveVaultLocations, SecretVault, vaultPathFor } from "@veyyon/coding-agent/secrets/vault";

/** Long enough for the obfuscator to accept, distinctive enough to assert on exactly. */
const VALUE = "ghp_renameKeepsTheValueIntact01";
/** A second credential, so a collision has something real to destroy. */
const OTHER_VALUE = "ghp_renameCollisionOccupant0002";

let home: string;
let project: string;

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-rename-home-"));
	project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-rename-proj-"));
});

afterEach(async () => {
	await fs.rm(home, { recursive: true, force: true });
	await fs.rm(project, { recursive: true, force: true });
});

function makeVault(): SecretVault {
	return new SecretVault(
		resolveVaultLocations({
			globalConfigRoot: home,
			agentDir: path.join(home, "profiles", "default"),
			cwd: project,
		}),
	);
}

/** The sealed bytes on disk, so "wrote nothing" can be asserted rather than inferred. */
async function sealedBytes(scope: "profile" | "project" | "global"): Promise<string> {
	return await fs.readFile(
		vaultPathFor(
			resolveVaultLocations({
				globalConfigRoot: home,
				agentDir: path.join(home, "profiles", "default"),
				cwd: project,
			}),
			scope,
		),
		"utf8",
	);
}

describe("renaming a stored secret", () => {
	/**
	 * The core regression: a rename that rebuilt the entry instead of relabelling it would reset
	 * `createdAt`/`expiresAt` and silently move the credential's death date, and could lose the
	 * value entirely. Value and lifetime must come back byte-identical under the new name.
	 */
	it("keeps the value, createdAt and expiresAt exactly", async () => {
		const vault = makeVault();
		await vault.add({ name: "github-token", value: VALUE });
		const [before] = await vault.load();

		const result = await vault.rename("GITHUB_TOKEN", "GH_MAIN");

		expect(result).toEqual({ scope: "profile", name: "GH_MAIN" });
		const after = await vault.load();
		expect(after).toHaveLength(1);
		expect(after[0].name).toBe("GH_MAIN");
		expect(after[0].value).toBe(VALUE);
		expect(after[0].createdAt).toBe(before.createdAt);
		expect(after[0].expiresAt).toBe(before.expiresAt);
		expect(after[0].expiresAt).not.toBeNull();
		expect(after[0].scope).toBe("profile");
	});

	/**
	 * Renaming a name nobody stored must report the miss instead of inventing an entry, and it
	 * must not re-seal the vault: a mutation that rewrote on a miss would churn the file (and its
	 * mtime) every time an operator mistyped a name.
	 */
	it("returns null for a name that does not exist and writes nothing", async () => {
		const vault = makeVault();
		await vault.add({ name: "github-token", value: VALUE });
		const bytesBefore = await sealedBytes("profile");

		const result = await vault.rename("NOPE_HERE", "GH_MAIN");

		expect(result).toBeNull();
		expect(await sealedBytes("profile")).toBe(bytesBefore);
		const after = await vault.load();
		expect(after).toHaveLength(1);
		expect(after[0].name).toBe("GITHUB_TOKEN");
		expect(after[0].value).toBe(VALUE);
	});

	/**
	 * `add` overwrites a same-named entry on purpose (rotation) and says so. A rename has no such
	 * reading, so it must refuse: the version that reused `add`'s overwrite would have deleted a
	 * live credential with no value replacing it and nothing on screen about it.
	 */
	it("throws when the target name is already taken and leaves both entries intact", async () => {
		const vault = makeVault();
		await vault.add({ name: "github-token", value: VALUE });
		await vault.add({ name: "gh-main", value: OTHER_VALUE });
		const before = await vault.load();

		await expect(vault.rename("github-token", "gh-main")).rejects.toThrow(/GH_MAIN/);

		const after = await vault.load();
		expect(after).toHaveLength(2);
		expect(after.map(entry => entry.name).sort()).toEqual(["GH_MAIN", "GITHUB_TOKEN"]);
		const byName = new Map(after.map(entry => [entry.name, entry]));
		expect(byName.get("GITHUB_TOKEN")?.value).toBe(VALUE);
		expect(byName.get("GH_MAIN")?.value).toBe(OTHER_VALUE);
		for (const original of before) {
			expect(byName.get(original.name)?.createdAt).toBe(original.createdAt);
			expect(byName.get(original.name)?.expiresAt).toBe(original.expiresAt);
		}
	});

	/**
	 * Renaming to the name already held is a request that is already satisfied, so it reports the
	 * entry rather than tripping the collision guard against the entry being renamed itself.
	 */
	it("treats a same-name rename as a no-op that still reports the entry", async () => {
		const vault = makeVault();
		await vault.add({ name: "github-token", value: VALUE });
		const bytesBefore = await sealedBytes("profile");

		const result = await vault.rename("github token", "GITHUB_TOKEN");

		expect(result).toEqual({ scope: "profile", name: "GITHUB_TOKEN" });
		expect(await sealedBytes("profile")).toBe(bytesBefore);
		const after = await vault.load();
		expect(after).toHaveLength(1);
		expect(after[0].name).toBe("GITHUB_TOKEN");
		expect(after[0].value).toBe(VALUE);
	});

	/**
	 * Both sides go through the same name normalisation the rest of the vault uses, so the shapes
	 * people actually type resolve to the stored name and produce a stored-shaped name. Skipping
	 * it on either side made `rename("github token", ...)` report "no such secret".
	 */
	it("normalises both the source and the target name", async () => {
		const vault = makeVault();
		await vault.add({ name: "github-token", value: VALUE });

		const result = await vault.rename("github token", "gh main");

		expect(result).toEqual({ scope: "profile", name: "GH_MAIN" });
		const after = await vault.load();
		expect(after).toHaveLength(1);
		expect(after[0].name).toBe("GH_MAIN");
		expect(after[0].value).toBe(VALUE);
	});

	/**
	 * An unusable target name is rejected before anything is written, so a typo cannot leave the
	 * vault holding a name the placeholder syntax could never address, and cannot damage the
	 * entry that was being renamed.
	 */
	it("throws on an unusable target name and leaves the original untouched", async () => {
		const vault = makeVault();
		await vault.add({ name: "github-token", value: VALUE });
		const [before] = await vault.load();
		const bytesBefore = await sealedBytes("profile");

		await expect(vault.rename("github-token", "ab")).rejects.toThrow(/not a usable secret name/);

		expect(await sealedBytes("profile")).toBe(bytesBefore);
		const after = await vault.load();
		expect(after).toHaveLength(1);
		expect(after[0].name).toBe("GITHUB_TOKEN");
		expect(after[0].value).toBe(VALUE);
		expect(after[0].createdAt).toBe(before.createdAt);
		expect(after[0].expiresAt).toBe(before.expiresAt);
	});

	/**
	 * The scope walk is the whole reason `remove`/`extend` iterate: a rename that only looked in
	 * the default scope would report "no such secret" for an entry the operator can plainly see,
	 * and the reported scope has to name where the entry actually lives.
	 */
	it("renames an entry in a non-default scope and reports that scope", async () => {
		const vault = makeVault();
		await vault.add({ name: "github-token", value: VALUE, scope: "project" });
		const [before] = await vault.load();
		expect(before.scope).toBe("project");

		const result = await vault.rename("github-token", "gh-main");

		expect(result).toEqual({ scope: "project", name: "GH_MAIN" });
		const after = await vault.load();
		expect(after).toHaveLength(1);
		expect(after[0].name).toBe("GH_MAIN");
		expect(after[0].scope).toBe("project");
		expect(after[0].value).toBe(VALUE);
		expect(after[0].createdAt).toBe(before.createdAt);
		expect(after[0].expiresAt).toBe(before.expiresAt);
	});
});
