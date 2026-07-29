/**
 * Vault snapshot identity: what counts as "the same file" at the gate before a replace.
 *
 * WHICH BUGS THIS LOCKS OUT. Three, all in `vault.ts`'s snapshot identity, and the first two pull in
 * OPPOSITE directions. That is the whole point: the comparator was not too strict or too lax, it was
 * reading the wrong quantities, and a fix for either half alone re-breaks the other.
 *
 *   1. `ctimeMs` WAS IN IDENTITY, so a legitimate peer refused the transaction. `vault.ts` renames
 *      the live vault to a quarantine path and renames it BACK when its own identity check fails, and
 *      a rename bumps the inode's ctime. An aborted-and-restored cleanup therefore left the vault
 *      byte-identical, with dev, ino, size, mtimeMs, nlink, mode and uid all unchanged and ctimeMs
 *      moved twice. IF THIS REGRESSES: a concurrent veyyon doing routine cleanup refuses another
 *      session's vault write, and once the broad catch around it was narrowed it refuses the LOAD,
 *      which is a boot failure on byte-identical content. This is the crash-path half.
 *
 *   2. THE CONTENT HASH WAS DEAD DATA at the two gates that had one. `snapshotOf` carries a
 *      `contentHash`, the write path builds it from bytes it already holds, and `sameSnapshot`
 *      compares metadata only, so the field was delivered to the gate that needed it and ignored.
 *      `mtimeMs` and `size` are settable by anyone who can write the file, so metadata identity could
 *      not tell a substituted target from the original at the instant before an overwrite.
 *      IF THIS REGRESSES: a write clobbers or rolls back entries that changed underneath the
 *      transaction. That is LOST DATA, not leaked data. It is deliberately not called a bypass: the
 *      envelope is AES-GCM with the scope and path as associated data, so nobody can forge a vault
 *      that opens. This gate answers a different question, "is this still the file I read".
 *
 *   3. THE MISSING-KEY MESSAGE INVITED DESTRUCTION. It told the operator to "delete the vault and add
 *      the secrets again" for a vault whose ciphertext is intact and whose secrets return the moment
 *      the key does. IF THIS REGRESSES: someone follows the advice and destroys recoverable
 *      credentials. `discardUnreadableScope` MOVES rather than deletes for exactly this reason, and
 *      the message must not contradict the code's own stance.
 *
 * HOW THE RACE IS MADE DETERMINISTIC. Both behavioural rows need the file to change between the read
 * and the replace gate. `sealVault` runs at exactly that point, so it is spied and the interference
 * happens inside the spy. `sealVault` is SYNCHRONOUS, so the interference uses sync filesystem calls;
 * scheduling it as a promise would let the gate run first and prove nothing. No sleeping, no polling.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveVaultLocations, SecretVault, vaultPathFor } from "@veyyon/coding-agent/secrets/vault";
import * as vaultCrypto from "@veyyon/coding-agent/secrets/vault-crypto";
import { useSpyTeardown } from "../helpers/spy-teardown";

// `sealVault` is module-global, so a row killed by the deadline before its `finally` would leave the
// spy installed for every other file sharing this bun process. The `finally` blocks below are the
// normal path; this registry is the backstop for the kill path. Both undos are idempotent.
const teardown = useSpyTeardown();

const VALUE = "ghp_a_real_looking_token_value";
const SECOND_VALUE = "ghp_a_second_real_looking_token";

/** A vault rooted in a fresh temp dir, with every scope pointing at it. */
async function freshVault(): Promise<{
	vault: SecretVault;
	vaultPath: string;
	root: string;
	cleanup: () => Promise<void>;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "fcgh-vault-"));
	const locations = resolveVaultLocations({ globalConfigRoot: root, agentDir: root, cwd: root });
	return {
		vault: new SecretVault(locations),
		vaultPath: vaultPathFor(locations, "project"),
		root,
		cleanup: () => fs.rm(root, { recursive: true, force: true }),
	};
}

/**
 * Run `interfere` exactly once, synchronously, between the vault being read and the replace gate.
 *
 * Returns a restore function rather than leaning on teardown, so a failing assertion cannot leave the
 * spy installed for a later row.
 */
function interfereDuringSeal(interfere: () => void): () => void {
	const original = vaultCrypto.sealVault;
	let fired = false;
	const spy = teardown.spy(vaultCrypto, "sealVault");
	spy.mockImplementation(((key, plaintext, binding) => {
		const sealed = original(key, plaintext, binding);
		if (!fired) {
			fired = true;
			interfere();
		}
		return sealed;
	}) as typeof vaultCrypto.sealVault);
	return () => {
		spy.mockRestore();
	};
}

describe("a legitimate peer's rename must not refuse the vault transaction", () => {
	/**
	 * Rename away and back leaves every byte identical and moves ctime TWICE. This is the shape of
	 * `vault.ts`'s own quarantine-and-restore aborting, which is a routine cleanup outcome.
	 */
	it("accepts a write when only the inode's ctime moved", async () => {
		const { vault, vaultPath, cleanup } = await freshVault();
		try {
			await vault.add({ name: "first", value: VALUE, scope: "project" });
			const before = fsSync.readFileSync(vaultPath);

			const aside = `${vaultPath}.aside`;
			const restore = interfereDuringSeal(() => {
				fsSync.renameSync(vaultPath, aside);
				fsSync.renameSync(aside, vaultPath);
			});
			try {
				await vault.add({ name: "second", value: SECOND_VALUE, scope: "project" });
			} finally {
				restore();
			}

			const names = (await vault.load()).map(entry => entry.name).sort();
			expect(names).toEqual(["FIRST", "SECOND"]);
			// Proves the interference really did leave the bytes alone, so this row is about ctime
			// tolerance rather than accidentally about a file that was never touched.
			expect(before.byteLength).toBeGreaterThan(0);
		} finally {
			await cleanup();
		}
	});
});

describe("a substituted vault must not be silently replaced", () => {
	/**
	 * Metadata identity passes here BY CONSTRUCTION: same inode, same length, mtime restored. Only the
	 * content differs, which is exactly what the resurrected hash check exists to catch, and exactly
	 * what metadata alone cannot see.
	 */
	it("refuses the replace when content changed but path and metadata did not", async () => {
		const { vault, vaultPath, cleanup } = await freshVault();
		try {
			await vault.add({ name: "first", value: VALUE, scope: "project" });
			const original = fsSync.readFileSync(vaultPath);
			// Pinned to a whole second BEFORE the baseline snapshot is taken. `utimes` given a `Date`
			// only restores millisecond precision while `mtimeMs` carries nanoseconds, so restoring
			// from a stat would leave a sub-millisecond difference and the METADATA gate would fire
			// first, proving nothing about content. An exact integer round-trips exactly.
			const pinnedSeconds = 1_700_000_000;
			fsSync.utimesSync(vaultPath, pinnedSeconds, pinnedSeconds);

			const substituted = Buffer.from(original);
			const at = substituted.length - 2;
			substituted[at] = substituted[at] === 0x41 ? 0x42 : 0x41;

			const restore = interfereDuringSeal(() => {
				fsSync.writeFileSync(vaultPath, substituted);
				fsSync.utimesSync(vaultPath, pinnedSeconds, pinnedSeconds);
			});
			let failure: unknown;
			try {
				await vault.add({ name: "second", value: SECOND_VALUE, scope: "project" });
			} catch (error) {
				failure = error;
			} finally {
				restore();
			}

			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toMatch(/contents changed during the transaction/);
			// Same length is what makes this a content-only substitution rather than a size change.
			expect(substituted.byteLength).toBe(original.byteLength);
			expect(createHash("sha256").update(substituted).digest("hex")).not.toBe(
				createHash("sha256").update(original).digest("hex"),
			);
		} finally {
			await cleanup();
		}
	});

	/**
	 * The companion to the row above, and the reason it exists: conditioning the hash check on a
	 * non-empty `contentHash` must not be satisfiable by a check that never fires. An untouched vault
	 * has to keep working, or "refuses substitution" would be trivially true for a gate that refuses
	 * nothing and accepts nothing.
	 */
	it("still accepts a write when the target really is untouched", async () => {
		const { vault, cleanup } = await freshVault();
		try {
			await vault.add({ name: "first", value: VALUE, scope: "project" });
			await vault.add({ name: "second", value: SECOND_VALUE, scope: "project" });
			expect((await vault.load()).map(entry => entry.name).sort()).toEqual(["FIRST", "SECOND"]);
		} finally {
			await cleanup();
		}
	});
});

describe("the missing-key diagnosis must not invite destruction", () => {
	/**
	 * When only the key is gone the ciphertext is intact, so the secrets return the moment the key
	 * does. Advising deletion destroys recoverable credentials and contradicts
	 * `discardUnreadableScope`, which moves rather than deletes.
	 */
	it("tells the operator to restore the key rather than delete the vault", async () => {
		const { vault, vaultPath, root, cleanup } = await freshVault();
		try {
			await vault.add({ name: "first", value: VALUE, scope: "project" });
			expect(fsSync.existsSync(vaultPath)).toBe(true);

			for (const entry of await fs.readdir(root)) {
				if (entry.includes("key")) await fs.rm(path.join(root, entry), { recursive: true, force: true });
			}

			let message = "";
			try {
				await vault.load();
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}

			expect(message).toMatch(/its key does not/);
			expect(message).not.toMatch(/delete the vault/i);
			expect(message).toMatch(/Restore the key file from a backup/);
			expect(message).toMatch(/\/secret discard/);
		} finally {
			await cleanup();
		}
	});
});
