/**
 * `SecretVault.revision()` must move for an external write and for nothing else.
 *
 * THE BUG THIS LOCKS OUT. The revision fingerprint used to stat the scope DIRECTORIES as well as
 * the vault files. The three scope directories are `~/.veyyon`, the profile agent directory, and
 * `<cwd>/.veyyon`, which are the busiest state directories in the product: SQLite `-wal`/`-shm`
 * files, session files, blobs, caches, and the vault's own `<vault>.lock` sibling are created and
 * removed in them constantly. A directory's mtime and ctime move whenever any entry inside it is
 * created or removed, so the fingerprint moved constantly with a single process running and no
 * secret touched. Downstream, a moved revision meant "the vault changed in another session or
 * process" and every secret expansion was refused, which on render paths took the TUI down.
 *
 * Worse, the vault invalidated ITSELF: `/secret add` replaces the vault inode, so a session that
 * stored a secret immediately considered its own captured revision stale and could not spend the
 * secret it had just added. Pruning an expired entry during `load()` did the same thing on a read.
 *
 * IF THIS REGRESSES: secret expansion is refused in ordinary single-process use, the primary
 * add-then-spend workflow breaks, and the session crashes on render. Do not "fix" a failure here
 * by loosening the file fingerprint; the external-detection suite below is the other half of the
 * contract and must stay green at the same time.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretVault, type VaultLocations, vaultPathFor } from "@veyyon/coding-agent/secrets/vault";
import { withFileLock } from "@veyyon/utils";

const roots = new Set<string>();

const VALUE = "a_secret_value_long_enough_to_protect";
const MINUTE = 60_000;

interface Fixture {
	readonly root: string;
	readonly locations: VaultLocations;
	readonly vault: SecretVault;
	readonly clock: { now: number };
}

async function fixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-revision-churn-"));
	roots.add(root);
	const locations: VaultLocations = {
		globalConfigRoot: path.join(root, "config"),
		profileDir: path.join(root, "config", "profiles", "work", "agent"),
		projectDir: path.join(root, "project", ".veyyon"),
	};
	const clock = { now: 1_800_000_000_000 };
	return { root, locations, vault: new SecretVault(locations, () => clock.now), clock };
}

afterEach(async () => {
	await Promise.all([...roots].map(root => fs.rm(root, { recursive: true, force: true })));
	roots.clear();
});

describe("a revision only moves for changes this process did not make", () => {
	/**
	 * The exact root cause. An unrelated file appearing beside the vault is not a vault change.
	 * In production this is a SQLite `-wal` file in the profile agent directory.
	 */
	it("is stable when unrelated files appear and vanish in the scope directory", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: "CHURN_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const directory = path.dirname(vaultPathFor(locations, "profile"));
		const captured = vault.revision();

		for (const name of ["history.db-wal", "history.db-shm", "agent.db-wal", "session-01.json"]) {
			await Bun.write(path.join(directory, name), "unrelated state");
			expect(vault.revision()).toBe(captured);
		}
		for (const name of ["history.db-wal", "agent.db-wal"]) {
			await fs.unlink(path.join(directory, name));
			expect(vault.revision()).toBe(captured);
		}
		await fs.mkdir(path.join(directory, "terminal-sessions"));
		expect(vault.revision()).toBe(captured);
	});

	/**
	 * The vault's own concurrency control lives at `<vault>.lock`, a SIBLING of the file it
	 * guards. Taking the lock therefore used to invalidate the very vault it was protecting.
	 */
	it("is stable across a lock acquire and release cycle on the vault", async () => {
		const { locations, vault } = await fixture();
		await vault.add({ name: "LOCKED_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const vaultPath = vaultPathFor(locations, "profile");
		const directory = path.dirname(vaultPath);
		const captured = vault.revision();

		let heldEntries: string[] = [];
		await withFileLock(vaultPath, async () => {
			heldEntries = await fs.readdir(directory);
			expect(vault.revision()).toBe(captured);
		});

		// The lock really is a sibling dirent, so it really did perturb the directory.
		expect(heldEntries).toContain(`${path.basename(vaultPath)}.lock`);
		expect(await fs.readdir(directory)).not.toContain(`${path.basename(vaultPath)}.lock`);
		expect(vault.revision()).toBe(captured);
	});

	/** A locked operation that changes nothing must not look like somebody else changed something. */
	it("is stable when a mutation finds nothing to do", async () => {
		const { vault } = await fixture();
		await vault.add({ name: "PRESENT_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const captured = vault.revision();

		expect(await vault.remove("NEVER_STORED_TOKEN")).toBeNull();
		expect(vault.revision()).toBe(captured);
	});

	/**
	 * THE primary workflow: store a secret and spend it in the same session, no refresh between.
	 * A session must never decide that its own successful write revoked its own expansion rights.
	 */
	it("is stable across this session's own add", async () => {
		const { vault } = await fixture();
		await vault.add({ name: "FIRST_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const captured = vault.revision();

		await vault.add({ name: "SECOND_TOKEN", value: `${VALUE}_two`, scope: "profile", ttl: null });

		expect(vault.revision()).toBe(captured);
		expect((await vault.load()).map(entry => entry.name).sort()).toEqual(["FIRST_TOKEN", "SECOND_TOKEN"]);
	});

	/** The very first secret creates the vault file, and that is still this session's own doing. */
	it("is stable when this session's own add creates the vault from nothing", async () => {
		const { vault } = await fixture();
		const captured = vault.revision();

		await vault.add({ name: "ONLY_TOKEN", value: VALUE, scope: "profile", ttl: null });

		expect(vault.revision()).toBe(captured);
	});

	/** Removing and re-timing a secret publish just like adding one, and are just as much ours. */
	it("is stable across this session's own remove and extend", async () => {
		const { vault } = await fixture();
		await vault.add({ name: "KEEP_TOKEN", value: VALUE, scope: "profile", ttl: MINUTE });
		await vault.add({ name: "DROP_TOKEN", value: `${VALUE}_drop`, scope: "profile", ttl: MINUTE });
		const captured = vault.revision();

		expect(await vault.remove("DROP_TOKEN")).toBe("profile");
		expect(vault.revision()).toBe(captured);

		expect(await vault.extend("KEEP_TOKEN", 10 * MINUTE)).toMatchObject({ name: "KEEP_TOKEN" });
		expect(vault.revision()).toBe(captured);
	});

	/**
	 * `load()` DELETES expired entries from disk rather than filtering them in memory, because an
	 * expired value must not linger in the file. That write is a read path writing, and it used to
	 * invalidate the reader. Keeping the deletion is deliberate; making it self-invalidating is not.
	 */
	it("is stable when a read prunes an expired entry off disk", async () => {
		const { locations, vault, clock } = await fixture();
		await vault.add({ name: "LIVE_TOKEN", value: VALUE, scope: "profile", ttl: null });
		await vault.add({ name: "DYING_TOKEN", value: `${VALUE}_dying`, scope: "profile", ttl: MINUTE });
		clock.now += 2 * MINUTE;
		const captured = vault.revision();

		expect((await vault.load()).map(entry => entry.name)).toEqual(["LIVE_TOKEN"]);

		expect(vault.revision()).toBe(captured);
		// The prune really did hit the disk: a reader on a clock BEFORE expiry still cannot see it.
		const rereader = new SecretVault(locations, () => 1_800_000_000_000);
		expect((await rereader.load()).map(entry => entry.name)).toEqual(["LIVE_TOKEN"]);
	});

	/** Many publications in a row must not accumulate into a change. */
	it("is stable across a long run of this session's own writes", async () => {
		const { vault } = await fixture();
		await vault.add({ name: "BASE_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const captured = vault.revision();

		for (let index = 0; index < 12; index++) {
			await vault.add({ name: `LOOP_TOKEN_${index}`, value: `${VALUE}_${index}`, scope: "profile", ttl: null });
		}

		expect(vault.revision()).toBe(captured);
	});

	/** Reading is the common case and must be free of side effects when nothing has expired. */
	it("is stable across repeated loads", async () => {
		const { vault } = await fixture();
		await vault.add({ name: "READ_TOKEN", value: VALUE, scope: "profile", ttl: null });
		const captured = vault.revision();

		for (let index = 0; index < 5; index++) await vault.load();

		expect(vault.revision()).toBe(captured);
	});
});
