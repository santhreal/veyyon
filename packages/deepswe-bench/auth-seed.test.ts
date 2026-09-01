/**
 * The credential-staging decision.
 *
 * WHY THIS SUITE EXISTS. Every task container authenticates with the copy of
 * `agent.db` this decision produces. A wrong choice does not raise: the agent
 * launches, fails to authenticate, and the run comes back as N failed tasks that
 * read like a model or harness regression. A real 40-trial run was lost to
 * exactly that, so both historical failure modes are pinned here.
 *
 * Mode 1, a pre-move store winning over the live one: logins moved from
 * `profiles/<name>/shared-auth` to the machine-wide `~/.veyyon/shared-auth`, and
 * the abandoned files stay on disk indefinitely. The old candidate order tried
 * them FIRST, so on any machine that has both, the expired leftover was staged
 * and the live store went unread.
 *
 * Mode 2, a frozen snapshot: the staged copy was kept whenever the file merely
 * existed. OAuth access tokens rotate, so once the live store refreshed, every
 * container got a token the provider had already retired.
 *
 * Mode 3, a wedge: one torn copy was newer than the live store, so the
 * timestamp rule kept choosing it. Every run after it died on `database disk
 * image is malformed`, minutes in, blaming the auth layer. The staged copy is
 * checked now, not just dated.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthSeedDecision, decideAuthSeed, probeCredentialStore, snapshotCredentialStore } from "./auth-seed";

const CANONICAL = "/home/u/.veyyon/shared-auth/agent.db";
const LEGACY_DEFAULT = "/home/u/.veyyon/profiles/default/shared-auth/agent.db";
const LEGACY_WORK = "/home/u/.veyyon/profiles/work/shared-auth/agent.db";
const SOURCES = [CANONICAL, LEGACY_DEFAULT, LEGACY_WORK] as const;
const STAGED = "/bench/assets/auth-agent.db";

/** A fake filesystem: path -> mtime. Absent key means the file does not exist. */
const fsWith = (files: Record<string, number>) => (p: string) => files[p];

/**
 * Decide with a fake filesystem. `fault` is what probing the staged copy
 * reports; the default of undefined means it opens cleanly, so every test that
 * is about timestamps reads as one.
 */
const decide = (files: Record<string, number>, fault?: string): AuthSeedDecision =>
	decideAuthSeed(SOURCES, STAGED, fsWith(files), () => fault);

describe("which store gets staged", () => {
	/**
	 * Mode 1, the exact regression. A stale pre-move file next to a live store is
	 * the common state of any machine that has been through the move, and the live
	 * store must win. Reversing the candidate order turns this red.
	 */
	it("prefers the machine-wide store over a pre-move per-profile leftover", () => {
		const decision = decide({ [CANONICAL]: 2_000, [LEGACY_DEFAULT]: 1_000, [LEGACY_WORK]: 500 });
		expect(decision).toEqual({ kind: "seed", source: CANONICAL, legacy: false });
	});

	/**
	 * Recency must NOT override canonicity. A pre-move file can easily be the newer
	 * one (a stray write, a restored backup, a copied home directory) while still
	 * holding credentials for an account the operator no longer uses.
	 */
	it("still prefers the machine-wide store when a legacy file is newer", () => {
		const decision = decide({ [CANONICAL]: 1_000, [LEGACY_DEFAULT]: 9_999 });
		expect(decision).toEqual({ kind: "seed", source: CANONICAL, legacy: false });
	});

	/** An operator who has not logged in since the move has only the old file, and
	 * must still be able to run: fall back, but report it as legacy so the caller
	 * can warn instead of proceeding silently. */
	it("falls back to a pre-move store and marks it legacy", () => {
		expect(decide({ [LEGACY_DEFAULT]: 1_000 })).toEqual({
			kind: "seed",
			source: LEGACY_DEFAULT,
			legacy: true,
		});
	});

	/** Fallback follows declaration order among the legacy entries too, so the
	 * choice is deterministic rather than dependent on directory iteration. */
	it("takes the first available legacy store in declared order", () => {
		const decision = decide({ [LEGACY_WORK]: 5_000, [LEGACY_DEFAULT]: 1_000 });
		expect(decision).toEqual({ kind: "seed", source: LEGACY_DEFAULT, legacy: true });
	});

	/** With no store anywhere the run cannot authenticate at all. Reporting it here
	 * is what turns "40 mysterious task failures" into one message before any
	 * container starts. */
	it("reports missing when no candidate exists", () => {
		expect(decide({})).toEqual({ kind: "missing" });
		expect(decide({ [STAGED]: 1_000 })).toEqual({ kind: "missing" });
	});
});

describe("when the staged copy is rewritten", () => {
	/**
	 * Mode 2, the exact regression: the live store has been refreshed since the
	 * copy was staged, so the copy may carry a rotated-out access token. The old
	 * code returned early on existence alone and never reached this case.
	 */
	it("re-seeds when the live store is newer than the staged copy", () => {
		expect(decide({ [CANONICAL]: 2_000, [STAGED]: 1_000 })).toEqual({
			kind: "reseed",
			source: CANONICAL,
			legacy: false,
			reason: "stale",
		});
	});

	/** The staged copy is current, so rewriting it would be pure churn. */
	it("keeps a staged copy that is newer than the live store", () => {
		expect(decide({ [CANONICAL]: 1_000, [STAGED]: 2_000 })).toEqual({
			kind: "current",
			source: CANONICAL,
			legacy: false,
		});
	});

	/** Boundary: equal mtimes mean the store has not been touched since staging.
	 * Copying on equality would rewrite the asset on every single run. */
	it("treats an equal mtime as current, not stale", () => {
		expect(decide({ [CANONICAL]: 1_000, [STAGED]: 1_000 })).toEqual({
			kind: "current",
			source: CANONICAL,
			legacy: false,
		});
	});

	/** Boundary: mtime 0 is a real timestamp, not "absent". Conflating the two
	 * would make an epoch-stamped store look missing and abort a runnable bench. */
	it("does not confuse an mtime of 0 with a missing file", () => {
		expect(decide({ [CANONICAL]: 0 })).toEqual({ kind: "seed", source: CANONICAL, legacy: false });
		expect(decide({ [CANONICAL]: 0, [STAGED]: 0 })).toEqual({
			kind: "current",
			source: CANONICAL,
			legacy: false,
		});
	});

	/** Staleness is judged against the store that was actually CHOSEN. Comparing
	 * against some other candidate would let an untouched legacy file suppress a
	 * needed re-seed. */
	it("judges staleness against the chosen store, not another candidate", () => {
		const decision = decide({ [CANONICAL]: 3_000, [LEGACY_DEFAULT]: 1_000, [STAGED]: 2_000 });
		expect(decision).toEqual({ kind: "reseed", source: CANONICAL, legacy: false, reason: "stale" });
	});

	/** A legacy fallback is subject to the same freshness rule; nothing about
	 * falling back should also freeze the copy. */
	it("re-seeds from a legacy store too when it is newer than the copy", () => {
		expect(decide({ [LEGACY_DEFAULT]: 2_000, [STAGED]: 1_000 })).toEqual({
			kind: "reseed",
			source: LEGACY_DEFAULT,
			legacy: true,
			reason: "stale",
		});
	});
});

/**
 * Mode 3, the wedge. One torn write used to disable the bench indefinitely,
 * because the damaged copy was newer than the live store and the only rule was
 * "newer wins". Every later run kept it, and every later run died the same way,
 * several minutes in, with a message that pointed at the auth layer rather than
 * at the asset.
 */
describe("when the staged copy does not open", () => {
	/** The exact regression. A newer-but-damaged copy must lose to the live store. */
	it("re-seeds a staged copy that is newer than the live store but unreadable", () => {
		expect(decide({ [CANONICAL]: 1_000, [STAGED]: 2_000 }, "database disk image is malformed")).toEqual({
			kind: "reseed",
			source: CANONICAL,
			legacy: false,
			reason: "unreadable",
			fault: "database disk image is malformed",
		});
	});

	/** The fault text is carried, not just the fact of one, so the operator reads
	 * what SQLite actually said instead of an unexplained extra copy. */
	it("carries the probe's fault text into the decision", () => {
		const decision = decide({ [CANONICAL]: 1_000, [STAGED]: 2_000 }, "file is not a database");
		expect(decision).toMatchObject({ reason: "unreadable", fault: "file is not a database" });
	});

	/** Equal mtimes take the same path. The wedge does not require the staged copy
	 * to be strictly newer, only for it to survive the timestamp rule. */
	it("re-seeds an unreadable copy whose mtime merely ties the live store", () => {
		expect(decide({ [CANONICAL]: 1_000, [STAGED]: 1_000 }, "malformed")).toMatchObject({
			kind: "reseed",
			reason: "unreadable",
		});
	});

	/** A legacy source is subject to the same rule; nothing about falling back
	 * should also make a damaged copy acceptable. */
	it("re-seeds from a legacy store when the staged copy is unreadable", () => {
		expect(decide({ [LEGACY_DEFAULT]: 1_000, [STAGED]: 2_000 }, "malformed")).toEqual({
			kind: "reseed",
			source: LEGACY_DEFAULT,
			legacy: true,
			reason: "unreadable",
			fault: "malformed",
		});
	});

	/**
	 * The probe must not be consulted when the decision is already to copy. It
	 * opens a file, which on the re-seed paths is about to be deleted, and on the
	 * seed path does not exist at all. Reading a doomed file to decide its own
	 * replacement is wasted work at best and an error at worst.
	 */
	it("does not probe when the copy is being replaced anyway", () => {
		const probed: string[] = [];
		const probe = (p: string): string | undefined => {
			probed.push(p);
			return undefined;
		};
		decideAuthSeed(SOURCES, STAGED, fsWith({ [CANONICAL]: 2_000, [STAGED]: 1_000 }), probe);
		decideAuthSeed(SOURCES, STAGED, fsWith({ [CANONICAL]: 2_000 }), probe);
		decideAuthSeed(SOURCES, STAGED, fsWith({}), probe);
		expect(probed).toEqual([]);
	});

	/** The healthy path still short-circuits to `current`, so a good copy is not
	 * rewritten just because it is now also checked. */
	it("keeps a readable, current copy", () => {
		const probed: string[] = [];
		const decision = decideAuthSeed(SOURCES, STAGED, fsWith({ [CANONICAL]: 1_000, [STAGED]: 2_000 }), p => {
			probed.push(p);
			return undefined;
		});
		expect(decision).toEqual({ kind: "current", source: CANONICAL, legacy: false });
		expect(probed).toEqual([STAGED]);
	});
});

describe("probeCredentialStore", () => {
	/** A healthy store reports no fault, which is what keeps the staged copy from
	 * being rewritten on every run now that it is checked. */
	it("reports no fault for a healthy database", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-seed-probe-"));
		const file = path.join(dir, "ok.db");
		const db = new Database(file, { create: true });
		db.run("CREATE TABLE credential (provider TEXT PRIMARY KEY, token TEXT)");
		db.run("INSERT INTO credential VALUES ('google', 'tok')");
		db.close();

		expect(probeCredentialStore(file)).toBeUndefined();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * The wedge, reproduced. A file with a valid SQLite header whose pages have
	 * been overwritten is exactly what a torn copy leaves behind: it exists, it is
	 * the right size, and it opens far enough to fail later. `quick_check` is what
	 * turns that into a verdict here instead of an uncaught `SQLiteError` minutes
	 * into the run.
	 */
	it("reports a fault for a database whose pages have been corrupted", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-seed-probe-"));
		const file = path.join(dir, "torn.db");
		const db = new Database(file, { create: true });
		db.run("CREATE TABLE credential (provider TEXT PRIMARY KEY, token TEXT)");
		const insert = db.prepare("INSERT INTO credential VALUES (?, ?)");
		db.transaction(() => {
			for (let i = 0; i < 400; i++) insert.run(`p${i}`, "x".repeat(200));
		})();
		db.close();

		// Keep the 100-byte header intact and shred what follows, which is what a
		// half-written copy looks like: recognisably a database, structurally not one.
		const bytes = fs.readFileSync(file);
		bytes.fill(0x5a, 200, Math.min(bytes.length, 8_000));
		fs.writeFileSync(file, bytes);

		const fault = probeCredentialStore(file);
		expect(fault).toBeDefined();
		expect(fault).toMatch(/malformed|quick_check|corrupt|not a database/i);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** A file that is not a database at all must be a fault, not an exception. The
	 * caller's contract is that probing never throws, so a bad asset costs one
	 * re-seed rather than aborting the run. */
	it("reports a fault for a file that is not a database", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-seed-probe-"));
		const file = path.join(dir, "notes.txt");
		fs.writeFileSync(file, "this is not a database");

		expect(probeCredentialStore(file)).toBeDefined();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** An empty file is SQLite's one special case: a zero-length file is a valid
	 * empty database. It carries no credentials, but it is not damage, and the
	 * freshness rule is what handles it. Pinned so the distinction is deliberate. */
	it("treats a zero-length file as an empty database rather than damage", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-seed-probe-"));
		const file = path.join(dir, "empty.db");
		fs.writeFileSync(file, "");

		expect(probeCredentialStore(file)).toBeUndefined();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** The snapshot the runner writes must pass the check the runner then applies,
	 * or the two mechanisms would fight and re-seed on every run forever. */
	it("passes a store produced by snapshotCredentialStore", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-seed-probe-"));
		const source = path.join(dir, "agent.db");
		const live = new Database(source, { create: true });
		live.run("PRAGMA journal_mode = WAL");
		live.run("CREATE TABLE credential (provider TEXT PRIMARY KEY, token TEXT)");
		live.run("INSERT INTO credential VALUES ('google', 'live-token')");

		const snapshot = path.join(dir, "staged.db");
		snapshotCredentialStore(source, snapshot);
		live.close();

		expect(probeCredentialStore(snapshot)).toBeUndefined();
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe("snapshotCredentialStore", () => {
	/**
	 * The regression this function exists for, made deterministic.
	 *
	 * A live store runs in WAL mode, so a committed row can sit only in
	 * `agent.db-wal` until a checkpoint folds it back. Copying the main file on
	 * its own therefore captures a database that is missing already-committed
	 * data, and the same gap is what produces a torn page when the copy lands
	 * mid-write: the run that died on `database disk image is malformed` failed
	 * that way while the source itself checked out clean.
	 *
	 * The race cannot be reproduced reliably, but its cause can: this asserts the
	 * snapshot carries a row that exists ONLY in the WAL, which no file copy of
	 * the main database can do.
	 */
	it("carries rows that are still only in the write-ahead log", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-seed-wal-"));
		const source = path.join(dir, "agent.db");
		const live = new Database(source, { create: true });
		live.run("PRAGMA journal_mode = WAL");
		live.run("CREATE TABLE credential (provider TEXT PRIMARY KEY, token TEXT)");
		live.run("INSERT INTO credential VALUES ('google', 'live-token')");

		// The connection stays OPEN and unchecked-pointed, so the row is committed
		// but still lives in the WAL, exactly as it does in a running install.
		expect(fs.existsSync(`${source}-wal`)).toBe(true);

		const snapshot = path.join(dir, "staged.db");
		snapshotCredentialStore(source, snapshot);
		live.close();

		const staged = new Database(snapshot, { readonly: true });
		expect(staged.query("SELECT token FROM credential WHERE provider = 'google'").all()).toEqual([
			{ token: "live-token" },
		]);
		staged.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * A naive file copy is shown losing that row, so the test above is proving a
	 * real difference rather than restating what any copy would do. If SQLite ever
	 * changed such that both worked, this is the assertion that would say so.
	 */
	it("differs from a file copy, which loses the un-checkpointed row", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-seed-naive-"));
		const source = path.join(dir, "agent.db");
		const live = new Database(source, { create: true });
		live.run("PRAGMA journal_mode = WAL");
		live.run("CREATE TABLE credential (provider TEXT PRIMARY KEY, token TEXT)");
		live.run("INSERT INTO credential VALUES ('google', 'live-token')");

		const naive = path.join(dir, "naive.db");
		fs.copyFileSync(source, naive);
		live.close();

		const copied = new Database(naive, { readonly: true });
		// The table itself never made it out of the WAL, so the copy has no schema
		// at all: the container would mount a credential store with nothing in it.
		expect(copied.query("SELECT name FROM sqlite_master WHERE name = 'credential'").all()).toEqual([]);
		copied.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * A stale `-wal` beside a previous snapshot would be read as part of the new
	 * one and could resurrect retired credentials, so the sidecars are cleared
	 * along with the destination.
	 */
	it("clears a previous snapshot's sidecar files", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-seed-sidecar-"));
		const source = path.join(dir, "agent.db");
		const live = new Database(source, { create: true });
		live.run("CREATE TABLE credential (provider TEXT PRIMARY KEY)");
		live.close();

		const destination = path.join(dir, "staged.db");
		fs.writeFileSync(destination, "stale");
		fs.writeFileSync(`${destination}-wal`, "stale wal");
		fs.writeFileSync(`${destination}-shm`, "stale shm");

		snapshotCredentialStore(source, destination);

		expect(fs.existsSync(`${destination}-wal`)).toBe(false);
		expect(fs.existsSync(`${destination}-shm`)).toBe(false);
		const staged = new Database(destination, { readonly: true });
		expect(staged.query("SELECT name FROM sqlite_master WHERE name = 'credential'").all()).toEqual([
			{ name: "credential" },
		]);
		staged.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
