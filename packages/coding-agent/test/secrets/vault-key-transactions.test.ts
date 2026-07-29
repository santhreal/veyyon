/**
 * Crash, concurrency, and boundary behavior for vault key publication.
 *
 * The key file is the only material that can decrypt every vault. These tests pin the exact
 * on-disk winner and prove that interrupted publication never turns a partial or exposed file
 * into an accepted key.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadOrCreateVaultKey,
	readVaultKey,
	VAULT_KEY_FILENAME,
	vaultKeyPath,
} from "@veyyon/coding-agent/secrets/vault-crypto";
import { useSpyTeardown } from "../helpers/spy-teardown";

const roots = new Set<string>();

async function rootFixture(label = "plain"): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `veyyon-key-transaction-${label}-`));
	roots.add(root);
	return root;
}

function stagePath(root: string): string {
	return path.join(root, `.${VAULT_KEY_FILENAME}.${process.pid}.${crypto.randomUUID()}.tmp`);
}

const teardown = useSpyTeardown();

afterEach(async () => {
	await Promise.all([...roots].map(root => fs.rm(root, { recursive: true, force: true })));
	roots.clear();
});

describe("vault key publication", () => {
	/**
	 * Every concurrent first-use caller must receive the one inode that won publication.
	 *
	 * The deadline is DECLARED rather than inherited. This row does real key generation under a
	 * cross-process file lock, so it costs ~1.6s idle and 1.8-2.0s measured under 48 busy cores,
	 * against a 5s default. On a machine running several suites at once that margin runs out, and a
	 * deadline kill here is indistinguishable from a genuine deadlock in the publication path — which
	 * is exactly the misread that sent three lanes hunting a defect that did not exist. The concurrent
	 * caller count is the contract and stays; the timing budget is what gets stated out loud.
	 */
	it("returns one exact key to concurrent creators", async () => {
		const root = await rootFixture();
		const keys = await Promise.all(Array.from({ length: 16 }, () => loadOrCreateVaultKey(root)));
		const [winner] = keys;
		if (winner === undefined) throw new Error("Concurrent key creation returned no winner");

		for (const key of keys) expect(key).toEqual(winner);
		expect((await fs.readFile(vaultKeyPath(root))).equals(winner)).toBe(true);
		expect((await fs.lstat(vaultKeyPath(root))).nlink).toBe(1);
	}, 30_000);

	/**
	 * Abandoned-stage cleanup creates a mutation window after an existing key can be inspected.
	 * The authoritative read must happen after that window so a replacement can never make the
	 * function return stale bytes from an inode that is no longer reachable.
	 */
	it("returns the reachable key when it is replaced during crash-stage cleanup", async () => {
		const root = await rootFixture();
		const keyPath = vaultKeyPath(root);
		const original = await loadOrCreateVaultKey(root);
		const originalStat = await fs.lstat(keyPath);
		const replacement = crypto.randomBytes(32);
		const replacementPath = path.join(root, "replacement.key");
		await fs.writeFile(replacementPath, replacement, { mode: 0o600, flag: "wx" });
		const replacementStat = await fs.lstat(replacementPath);

		const realOpendir = fs.opendir;
		let swapped = false;
		const opendirSpy = teardown.spy(fs, "opendir").mockImplementation(async (...args) => {
			if (!swapped) {
				swapped = true;
				await fs.rename(replacementPath, keyPath);
			}
			return await Reflect.apply(realOpendir, fs, args);
		});
		let loaded: Buffer;
		try {
			loaded = await loadOrCreateVaultKey(root);
		} finally {
			opendirSpy.mockRestore();
		}

		expect(loaded).toEqual(replacement);
		expect(await fs.readFile(keyPath)).toEqual(replacement);
		const finalStat = await fs.lstat(keyPath);
		expect(finalStat.ino).toBe(replacementStat.ino);
		expect(finalStat.ino).not.toBe(originalStat.ino);
		expect(replacement.equals(original)).toBe(false);
	});

	/** A crash after atomic publication leaves two links to complete bytes, which is recoverable. */
	it("recovers a synced key published before its staging link was removed", async () => {
		const root = await rootFixture();
		const bytes = crypto.randomBytes(32);
		const staged = stagePath(root);
		await fs.writeFile(staged, bytes, { mode: 0o600, flag: "wx" });
		await fs.link(staged, vaultKeyPath(root));

		expect(await readVaultKey(root)).toEqual(bytes);
		await expect(fs.lstat(staged)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fs.lstat(vaultKeyPath(root))).nlink).toBe(1);
	});

	/** Recovery is idempotent when lockless readers observe the same two-link crash state. */
	it("lets concurrent readers converge on one recovered publication", async () => {
		const root = await rootFixture();
		const bytes = crypto.randomBytes(32);
		const staged = stagePath(root);
		await fs.writeFile(staged, bytes, { mode: 0o600, flag: "wx" });
		await fs.link(staged, vaultKeyPath(root));

		const readers = await Promise.all(Array.from({ length: 32 }, () => readVaultKey(root)));
		for (const key of readers) expect(key).toEqual(bytes);
		expect((await fs.lstat(vaultKeyPath(root))).nlink).toBe(1);
	});

	/**
	 * The exact interleaving the lockless recovery used to lose, driven rather than sampled.
	 *
	 * WHAT RACES. Completing a published recovery means unlinking the leftover staging link, and
	 * `removePathIfSameInode` does that in TWO steps so the removal is a CAS: rename the path to a
	 * quarantine name, re-verify the inode, then unlink. Between the rename and the unlink the
	 * staging PATH is already absent while the inode STILL HAS BOTH LINKS. A second reader that
	 * lands in that window reads a two-link key that no longer has a staging path to reap, and the
	 * reader then re-stat'd ONCE and demanded `nlink === 1` — a fact the winner has not published
	 * yet. It read a peer's in-progress removal as tampering and refused a perfectly good key with
	 * "has 2 hard links. Refusing a key that is reachable through another path."
	 *
	 * WHY IT IS PINNED THIS WAY. The suite already covers this state with 32 concurrent readers, and
	 * that test failed about one run in five — enough to look like flake and be retried away, never
	 * enough to prove a fix. This one drives the interleaving with a two-gate rendezvous instead of
	 * hoping for it. Gate 1 parks the winner inside `fs.rm`, after the rename and before the unlink,
	 * and the second reader is not even STARTED until that gate opens, so it cannot miss the window.
	 * Gate 2 releases the winner's unlink as soon as that reader has read a link count of 2 from
	 * inside the window — released on the peer's OBSERVATION, never on its completion, because a
	 * reader that is allowed to wait for convergence would otherwise deadlock against the parked
	 * winner it is waiting for.
	 *
	 * Starting both readers together is the trap here: they serialize, the second one runs after the
	 * first has finished, and the test passes no matter how broken the recovery is. An earlier
	 * version of this test did exactly that and stayed green against three separate sabotages of the
	 * fix, which is the only reason it was caught. If this test ever stops failing when the
	 * convergence loop in `readVaultKeyPinned` is reverted to a single re-stat, it has gone vacuous
	 * again and is worth nothing.
	 */
	it("does not mistake a peer's in-progress staging unlink for tampering", async () => {
		const root = await rootFixture();
		const bytes = crypto.randomBytes(32);
		const staged = stagePath(root);
		await fs.writeFile(staged, bytes, { mode: 0o600, flag: "wx" });
		await fs.link(staged, vaultKeyPath(root));

		const stageName = path.basename(staged);
		// Barrier: BOTH readers must be inside the removal before either finishes it. A removal starts
		// with an lstat of the staging path, so parking the first arrival there until a second arrives
		// leaves them both to race the no-replace rename that follows, and exactly one of them loses
		// it. This is the only barrier that reaches the losing branch: park the winner any later, after
		// its rename, and the second reader's directory scan finds no staging entry at all, so it never
		// attempts a removal and never loses one. Were the pair ever to serialize, the first arrival
		// would wait forever and this test would time out rather than pass vacuously.
		const barrier = teardown.gate();
		// Gate: the loser has READ the key's link count after losing the rename. The winner's unlink is
		// held until then, so the loser is guaranteed to read the two-link state and to decide on it.
		const loserRead = teardown.gate();

		let arrivals = 0;
		let renamed = false;
		let lostTheRename = false;
		const realLstat = fs.lstat;
		const lstatSpy = teardown.spy(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
			// Basenames throughout, because readers reach these paths through a `/proc/self/fd/<n>` pin
			// of the directory and never through the absolute paths this fixture created.
			const name = path.basename(String(args[0]));
			// The winner's check of its own quarantine entry, which only exists once the rename landed:
			// from here the staging path is gone while the inode still carries both links.
			if (name.endsWith(".removing")) renamed = true;
			try {
				const stat = await Reflect.apply(realLstat, fs, args);
				if (name === stageName) {
					arrivals += 1;
					if (arrivals === 1) await barrier.reached;
					else barrier.open();
				}
				// Resolved only AFTER the count is in the loser's hands, never before, or the winner
				// would be free to unlink and the loser would read a settled 1 instead of the race.
				if (name === VAULT_KEY_FILENAME && renamed) loserRead.open();
				return stat;
			} catch (error) {
				// The loser's staging lstat, inside the failed-rename path: it lost. Release here too so
				// a first arrival can never be stranded if the pair does not split as expected.
				if (name === stageName) {
					lostTheRename = true;
					barrier.open();
				}
				throw error;
			}
		}) as typeof fs.lstat);

		const realRm = fs.rm;
		const rmSpy = teardown.spy(fs, "rm").mockImplementation(async (...args) => {
			// Hold the winner's unlink until the loser has read the link count. Released on the loser's
			// READ and never on its completion, or a reader that waits for the count to settle would
			// deadlock against the very winner it is waiting for.
			if (renamed) await loserRead.reached;
			return await Reflect.apply(realRm, fs, args);
		});

		let readers: [Buffer | null, Buffer | null];
		try {
			readers = await Promise.all([readVaultKey(root), readVaultKey(root)]);
		} finally {
			rmSpy.mockRestore();
			lstatSpy.mockRestore();
		}

		// The interleaving under test actually happened: two readers reached the removal, and one lost
		// the rename and had to reason about a key whose second link was still up.
		expect(arrivals).toBeGreaterThanOrEqual(2);
		expect(lostTheRename).toBe(true);
		for (const key of readers) expect(key).toEqual(bytes);
		expect((await fs.lstat(vaultKeyPath(root))).nlink).toBe(1);
		await expect(fs.lstat(staged)).rejects.toMatchObject({ code: "ENOENT" });
	});

	/**
	 * A reader that finds a two-link key with NOTHING LEFT TO REAP must classify the second link, not
	 * refuse the key.
	 *
	 * The other half of the same race, and the half that was actually observed in the wild: two agents
	 * measured this as a load-dependent failure, red under a full-directory run and green when run
	 * alone, reporting "has 2 hard links. Refusing a key that is reachable through another path." for a
	 * key that was never compromised.
	 *
	 * A reader arriving after a peer renamed the staging link to its quarantine name finds a link count
	 * of 2 and no staging entry, so recovery has nothing to do and the count does not move on its own.
	 * A count of 2 is AMBIGUOUS — a reap in flight, or a genuine foreign path to the key — and it
	 * cannot be told apart by comparing inodes, because a recovery link is the same inode as the
	 * published key by construction. So the second link has to be identified structurally, by finding
	 * the entry that accounts for it. Waiting for the count to drop instead is what made this
	 * load-dependent in the first place: it turns a correctness property into a bet on how fast a peer
	 * finishes, which a busy machine loses.
	 *
	 * The winner is parked inside its unlink for the whole life of the second reader, so the second
	 * link is guaranteed to still be up when that reader judges it. The park is released by the second
	 * reader reaching `fs.open`, which it only does once it has ACCEPTED the key — so a reader that
	 * refuses instead never releases it, and this test fails rather than hanging quietly.
	 */
	it("accepts a two-link key whose second link is an in-flight recovery entry", async () => {
		const root = await rootFixture();
		const bytes = crypto.randomBytes(32);
		const staged = stagePath(root);
		await fs.writeFile(staged, bytes, { mode: 0o600, flag: "wx" });
		await fs.link(staged, vaultKeyPath(root));

		const window = teardown.gate();
		const winner = teardown.gate();

		let parked = false;
		let sawTwoLinks = false;
		const realLstat = fs.lstat;
		const lstatSpy = teardown.spy(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
			const stat = await Reflect.apply(realLstat, fs, args);
			if (parked && path.basename(String(args[0])) === VAULT_KEY_FILENAME && stat.nlink === 2) {
				sawTwoLinks = true;
			}
			return stat;
		}) as typeof fs.lstat);

		const reap = teardown.gate();

		const realOpen = fs.open;
		const openSpy = teardown.spy(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
			// Only a reader that ACCEPTED the two-link key gets this far, which is why the winner is
			// released here and nowhere earlier: a reader that refuses never releases it, so a
			// regression fails this test instead of quietly passing.
			if (parked && path.basename(String(args[0])) === VAULT_KEY_FILENAME) {
				winner.open();
				// And the reap is forced to land BETWEEN this reader's two stats: it judged the key at
				// two links, and by the time it stats the open handle the peer has finished, so the
				// count AND the inode's ctime have both moved under it. Metadata that a peer's reap
				// changes must not be read as "the key changed while it was being opened".
				await reap.reached;
			}
			return await Reflect.apply(realOpen, fs, args);
		}) as typeof fs.open);

		const realRm = fs.rm;
		const rmSpy = teardown.spy(fs, "rm").mockImplementation(async (...args) => {
			if (!parked) {
				parked = true;
				window.open();
				await winner.reached;
			}
			try {
				return await Reflect.apply(realRm, fs, args);
			} finally {
				if (parked) reap.open();
			}
		});

		let readers: [Buffer | null, Buffer | null];
		try {
			const winner = readVaultKey(root);
			// The second reader is not started until the staging link is already renamed away, so it
			// cannot help with the reap and has to judge the leftover link on its own.
			await window.reached;
			readers = await Promise.all([winner, readVaultKey(root)]);
		} finally {
			// Unblock the winner unconditionally, so a refusal fails this test instead of hanging it.
			winner.open();
			rmSpy.mockRestore();
			openSpy.mockRestore();
			lstatSpy.mockRestore();
		}

		expect(sawTwoLinks).toBe(true);
		for (const key of readers) expect(key).toEqual(bytes);
		expect((await fs.lstat(vaultKeyPath(root))).nlink).toBe(1);
	});

	/** A crash before publication must not leave a second key-shaped residue forever. */
	it("wipes and removes an unpublished crash stage before creating the winner", async () => {
		const root = await rootFixture();
		const staged = stagePath(root);
		const abandoned = crypto.randomBytes(32);
		await fs.writeFile(staged, abandoned, { mode: 0o600, flag: "wx" });

		const winner = await loadOrCreateVaultKey(root);
		expect(winner.equals(abandoned)).toBe(false);
		await expect(fs.lstat(staged)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fs.readFile(vaultKeyPath(root))).equals(winner)).toBe(true);
	});

	/**
	 * Cleanup's inode check and pathname removal are one CAS operation. A racing file installed
	 * after the check must be restored byte-for-byte and reported as a conflict, never unlinked
	 * under the identity of the abandoned stage that cleanup had already wiped.
	 */
	it("preserves a racing replacement of an unpublished crash stage", async () => {
		const root = await rootFixture();
		const staged = stagePath(root);
		const displaced = path.join(root, "wiped-abandoned-stage");
		const sentinel = crypto.randomBytes(32);
		await fs.writeFile(staged, crypto.randomBytes(32), { mode: 0o600, flag: "wx" });

		const realLstat = fs.lstat;
		let stageChecks = 0;
		let swapped = false;
		const lstatSpy = teardown.spy(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
			const stat = await Reflect.apply(realLstat, fs, args);
			if (!swapped && path.basename(String(args[0])) === path.basename(staged) && ++stageChecks === 2) {
				await fs.rename(staged, displaced);
				await fs.writeFile(staged, sentinel, { mode: 0o600, flag: "wx" });
				swapped = true;
			}
			return stat;
		}) as typeof fs.lstat);
		try {
			await expect(loadOrCreateVaultKey(root)).rejects.toThrow(/cleanup entry changed before removal/i);
		} finally {
			lstatSpy.mockRestore();
		}

		expect(swapped).toBe(true);
		expect(await fs.readFile(staged)).toEqual(sentinel);
		expect(await fs.readFile(displaced)).toEqual(Buffer.alloc(0));
		await expect(fs.lstat(vaultKeyPath(root))).rejects.toMatchObject({ code: "ENOENT" });
	});

	/** An intermediate symlink cannot redirect first-use key creation outside the requested tree. */
	it("rejects a symlink in an ancestor before creating any key", async () => {
		if (process.platform === "win32") return;
		const root = await rootFixture();
		const outside = path.join(root, "outside");
		const inside = path.join(root, "inside");
		await fs.mkdir(outside);
		await fs.mkdir(inside);
		await fs.symlink(outside, path.join(inside, "redirect"));
		const redirectedRoot = path.join(inside, "redirect", "config");

		await expect(loadOrCreateVaultKey(redirectedRoot)).rejects.toThrow(/crosses the symlink/);
		await expect(fs.lstat(vaultKeyPath(path.join(outside, "config")))).rejects.toMatchObject({ code: "ENOENT" });
	});

	/** First use hardens an empty writable config root before any key bytes are staged. */
	it("hardens an empty key root before creating the key", async () => {
		if (process.platform === "win32") return;
		const root = await rootFixture();
		await fs.chmod(root, 0o777);

		expect(await loadOrCreateVaultKey(root)).toHaveLength(32);
		expect((await fs.lstat(root)).mode & 0o777).toBe(0o700);
	});

	/** Hardening must not legitimize key bytes that were already exposed in a writable root. */
	it("refuses an existing key in a writable root without changing it", async () => {
		if (process.platform === "win32") return;
		const root = await rootFixture();
		const key = crypto.randomBytes(32);
		await fs.writeFile(vaultKeyPath(root), key, { mode: 0o600, flag: "wx" });
		await fs.chmod(root, 0o777);

		await expect(loadOrCreateVaultKey(root)).rejects.toThrow(/writable by other users/);
		expect(await fs.readFile(vaultKeyPath(root))).toEqual(key);
		expect((await fs.lstat(root)).mode & 0o777).toBe(0o777);
	});

	/** Recovery must not bless or remove an exposed file merely because its name looks staged. */
	it("refuses an exposed orphan publication without unlinking either path", async () => {
		if (process.platform === "win32") return;
		const root = await rootFixture();
		const staged = stagePath(root);
		await fs.writeFile(staged, crypto.randomBytes(32), { mode: 0o644, flag: "wx" });
		await fs.link(staged, vaultKeyPath(root));

		await expect(readVaultKey(root)).rejects.toThrow(/readable by other users/);
		expect((await fs.lstat(staged)).nlink).toBe(2);
		expect((await fs.lstat(vaultKeyPath(root))).nlink).toBe(2);
	});

	/** A huge sparse key is rejected from descriptor metadata before a caller-sized read allocation. */
	it("rejects an oversized sparse key at the fixed 32-byte boundary", async () => {
		const root = await rootFixture();
		const keyPath = vaultKeyPath(root);
		await fs.writeFile(keyPath, Buffer.alloc(0), { mode: 0o600 });
		await fs.truncate(keyPath, 1024 * 1024 * 1024);

		await expect(readVaultKey(root)).rejects.toThrow(/1073741824 bytes, expected 32/);
	});

	/** Terminal controls in an operator-controlled root never execute through a key error. */
	it("escapes controls from key paths in failures", async () => {
		const root = await rootFixture("bad\u001b[2Jpath");
		await fs.writeFile(vaultKeyPath(root), Buffer.alloc(16), { mode: 0o600 });

		const error = await readVaultKey(root).then(
			() => undefined,
			(reason: unknown) => reason as Error,
		);
		expect(error).toBeInstanceOf(Error);
		expect(error?.message).not.toContain("\u001b");
		expect(error?.message).toContain("\\u001B[2J");
	});
});
