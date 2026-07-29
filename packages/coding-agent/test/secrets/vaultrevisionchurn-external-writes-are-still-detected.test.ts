/**
 * The negative twin of the churn suite: narrowing what counts as a change must not blind it.
 *
 * THE BUG THIS LOCKS OUT. `revision()` exists so a session cannot expand plaintext it captured
 * from a vault that somebody else has since rewritten, revoked, or deleted. Two fixes narrowed
 * what it reacts to: it stopped stat'ing the scope directories, and it stopped counting writes
 * this process made. Either narrowing, taken one step too far, turns a fail-closed mechanism into
 * one that fails OPEN, which is strictly worse than the refusal storm it replaced. A fingerprint
 * that stopped noticing real edits would let a session keep spending a revoked credential.
 *
 * IF THIS REGRESSES: a credential revoked in another terminal stays spendable in this one. Do not
 * make a failure here pass by reintroducing directory stats; the stability suite is the other half
 * of the contract and must stay green at the same time.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretVault, type VaultLocations, vaultPathFor } from "@veyyon/coding-agent/secrets/vault";

const roots = new Set<string>();

const VALUE = "a_secret_value_long_enough_to_protect";
const VAULT_MODULE = path.resolve(import.meta.dir, "../../src/secrets/vault.ts");

interface Fixture {
	readonly root: string;
	readonly locations: VaultLocations;
	readonly vault: SecretVault;
}

async function fixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-revision-external-"));
	roots.add(root);
	const locations: VaultLocations = {
		globalConfigRoot: path.join(root, "config"),
		profileDir: path.join(root, "config", "profiles", "work", "agent"),
		projectDir: path.join(root, "project", ".veyyon"),
	};
	return { root, locations, vault: new SecretVault(locations) };
}

/**
 * Mutate the vault from a genuinely separate OS process.
 *
 * A second `SecretVault` inside this process would NOT do: the identity tracking is deliberately
 * process-wide, because "another session or process" is the question being asked. Only a real
 * child process proves the mechanism still works against the actor it was built to catch.
 */
async function mutateFromAnotherProcess(root: string, locations: VaultLocations, source: string): Promise<void> {
	const scriptPath = path.join(root, "rival-writer.ts");
	await Bun.write(
		scriptPath,
		`import { SecretVault } from ${JSON.stringify(VAULT_MODULE)};\n` +
			`const locations = JSON.parse(process.argv[2]);\n` +
			`const vault = new SecretVault(locations);\n` +
			`${source}\n`,
	);
	const child = Bun.spawn([process.execPath, scriptPath, JSON.stringify(locations)], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (exitCode !== 0) throw new Error(`The rival writer failed (${exitCode}): ${stderr}`);
}

afterEach(async () => {
	await Promise.all([...roots].map(root => fs.rm(root, { recursive: true, force: true })));
	roots.clear();
});

describe("an external write still revokes captured expansion rights", () => {
	/** The real-world case: the operator adds a secret in a second terminal. */
	it("changes when another process adds a secret", async () => {
		const { root, locations, vault } = await fixture();
		await vault.add({ name: "MINE_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const captured = vault.revision();

		await mutateFromAnotherProcess(
			root,
			locations,
			`await vault.add({ name: "RIVAL_TOKEN", value: ${JSON.stringify(`${VALUE}_rival`)}, scope: "profile", ttl: null });`,
		);

		expect(vault.revision()).not.toBe(captured);
	});

	/** The case the mechanism exists for: a credential revoked elsewhere must stop being spendable. */
	it("changes when another process revokes a secret", async () => {
		const { root, locations, vault } = await fixture();
		await vault.add({ name: "DOOMED_TOKEN", value: VALUE, scope: "profile", ttl: null });
		await vault.add({ name: "OTHER_TOKEN", value: `${VALUE}_other`, scope: "profile", ttl: null });
		const captured = vault.revision();

		await mutateFromAnotherProcess(root, locations, `await vault.remove("DOOMED_TOKEN");`);

		expect(vault.revision()).not.toBe(captured);
	});

	/** Detection must not be spent by our own writes: it has to keep working after any number. */
	it("changes when another process writes after a long run of our own writes", async () => {
		const { root, locations, vault } = await fixture();
		for (let index = 0; index < 8; index++) {
			await vault.add({ name: `OURS_${index}`, value: `${VALUE}_${index}`, scope: "profile", ttl: null });
		}
		const captured = vault.revision();

		await mutateFromAnotherProcess(
			root,
			locations,
			`await vault.add({ name: "LATE_RIVAL", value: ${JSON.stringify(`${VALUE}_late`)}, scope: "profile", ttl: null });`,
		);

		expect(vault.revision()).not.toBe(captured);
	});

	/**
	 * Deleting the vault is how a vault is destroyed, and it returns the path to the ONE state that
	 * carries no distinguishing metadata: absent. An identity scheme that simply inherited the
	 * pre-write state would report "absent" both before our first write and after this deletion,
	 * and would miss it. That regression is why identities are minted from a monotonic counter.
	 */
	it("changes when the vault file is deleted underneath the session", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: "DELETED_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const captured = vault.revision();

		await fs.unlink(vaultPathFor(locations, "profile"));

		expect(vault.revision()).not.toBe(captured);
	});

	/** The same trap one level deeper: delete, let US recreate, then delete again. */
	it("changes on a second external deletion after this session recreated the vault", async () => {
		const { locations, vault } = await fixture();
		const vaultPath = vaultPathFor(locations, "profile");
		await vault.add({ name: "CYCLE_TOKEN", value: VALUE, scope: "profile", ttl: null });

		await fs.unlink(vaultPath);
		const afterFirstDeletion = vault.revision();

		await vault.add({ name: "CYCLE_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const afterOurRecreate = vault.revision();
		expect(afterOurRecreate).toBe(afterFirstDeletion);

		await fs.unlink(vaultPath);

		expect(vault.revision()).not.toBe(afterOurRecreate);
	});

	/** Losing the whole scope directory takes the vault with it and must revoke. */
	it("changes when the scope directory is moved away", async () => {
		const { root, locations, vault } = await fixture();
		await vault.add({ name: "HOMELESS_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const captured = vault.revision();

		await fs.rename(locations.profileDir, path.join(root, "displaced-profile"));

		expect(vault.revision()).not.toBe(captured);
	});

	/**
	 * Adversarial: an external writer that restores the mtime and size it found, trying to look
	 * like it never touched the file. ctime is set by the kernel on every inode change and no
	 * syscall can set it, so the disguise cannot hold.
	 */
	it("changes when an external writer edits in place and restores mtime and size", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: "FORGED_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const vaultPath = vaultPathFor(locations, "profile");
		const original = await fs.readFile(vaultPath);
		const before = await fs.stat(vaultPath);
		const captured = vault.revision();

		const tampered = Buffer.from(original);
		tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x41 ? 0x42 : 0x41;
		await fs.writeFile(vaultPath, tampered);
		await fs.utimes(vaultPath, before.atime, before.mtime);

		expect((await fs.stat(vaultPath)).size).toBe(before.size);
		expect(vault.revision()).not.toBe(captured);
	});

	/**
	 * Adversarial: replacement by a byte-identical file at a new inode, which is what an atomic
	 * publication from another process looks like. Content equality is not identity equality.
	 */
	it("changes when the vault is replaced by a byte-identical inode", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: "SWAPPED_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const vaultPath = vaultPathFor(locations, "profile");
		const staging = path.join(locations.profileDir, "staged-vault");
		const original = await fs.readFile(vaultPath);
		const originalInode = (await fs.stat(vaultPath)).ino;
		const captured = vault.revision();

		await fs.writeFile(staging, original, { mode: 0o600 });
		await fs.rename(staging, vaultPath);

		// The bytes really are identical and the inode really did change, so only identity can tell.
		expect(await fs.readFile(vaultPath)).toEqual(original);
		expect((await fs.stat(vaultPath)).ino).not.toBe(originalInode);
		expect(vault.revision()).not.toBe(captured);
	});

	/** Once an external change is seen it must STAY seen, not wash out on the next poll. */
	it("keeps reporting an external change on every later poll", async () => {
		const { root, locations, vault } = await fixture();
		await vault.add({ name: "STICKY_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const captured = vault.revision();

		await mutateFromAnotherProcess(
			root,
			locations,
			`await vault.add({ name: "STICKY_RIVAL", value: ${JSON.stringify(`${VALUE}_sticky`)}, scope: "profile", ttl: null });`,
		);

		const observed = vault.revision();
		expect(observed).not.toBe(captured);
		expect(vault.revision()).toBe(observed);
		expect(vault.revision()).toBe(observed);
	});

	/**
	 * The subtlest one. An external write lands, and THEN this session publishes. Our publication
	 * must not launder the external change back out of the fingerprint: the captured revision has
	 * to stay invalid, because the plaintext captured before the external write is still stale.
	 */
	it("does not launder an earlier external change through this session's own later write", async () => {
		const { root, locations, vault } = await fixture();
		await vault.add({ name: "ORIGINAL_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const captured = vault.revision();

		await mutateFromAnotherProcess(
			root,
			locations,
			`await vault.add({ name: "INTERLOPER", value: ${JSON.stringify(`${VALUE}_interloper`)}, scope: "profile", ttl: null });`,
		);
		await vault.add({ name: "AFTERWARDS", value: `${VALUE}_after`, scope: "profile", ttl: null });

		expect(vault.revision()).not.toBe(captured);
	});
});
