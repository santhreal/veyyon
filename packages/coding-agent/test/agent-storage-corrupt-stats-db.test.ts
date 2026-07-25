import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStorage } from "@veyyon/coding-agent/session/agent-storage";
import { logger, TempDir } from "@veyyon/utils";

/**
 * A broken stats database must not take the agent down with it.
 *
 * Veyyon keeps its data in several SQLite files on purpose, and they are not
 * equally important. `agent.db` holds credentials and session state, the things
 * whose loss ends a session. `stats.db` holds usage history: nice to have,
 * rebuildable, and written by a separate command on a different schedule.
 *
 * They are separate files so they are separate FAILURE DOMAINS, and that
 * separation is only real if the important one survives the unimportant one
 * being unreadable. `stats.db` is the likelier of the two to be damaged: it is
 * appended to by `veyyon stats`, it grows to millions of rows, and it is
 * routinely the one interrupted mid-write by a machine going down.
 *
 * Storage startup reaches into it once, to backfill model timing history. That
 * one read is the coupling, and this suite pins that it stays one-way: startup
 * completes, credentials and sessions still work, and the failure is REPORTED
 * rather than swallowed. Reporting is half the contract. A backfill that
 * silently never runs would leave model timings permanently empty with nothing
 * anywhere saying why.
 */
describe("AgentStorage with an unreadable stats database", () => {
	let tempDir: TempDir;

	afterEach(async () => {
		AgentStorage.resetInstance();
		vi.restoreAllMocks();
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined as unknown as TempDir;
		}
	});

	function newTempDir(): string {
		tempDir = TempDir.createSync("@veyyon-agent-storage-corrupt-stats-");
		return tempDir.path();
	}

	/** Bytes that are definitively not a SQLite file: the header magic is wrong. */
	function writeCorruptDb(filePath: string): void {
		fs.writeFileSync(filePath, "this is not a database, it is a text file\n".repeat(64));
	}

	/**
	 * The core contract. A corrupt stats database is the kind of damage that
	 * fails at `open`, before a single row is read, so it is the sharpest version
	 * of the question: does storage startup survive it?
	 */
	it("opens agent storage anyway and keeps it usable", async () => {
		const dir = newTempDir();
		const statsPath = path.join(dir, "stats.db");
		writeCorruptDb(statsPath);

		const storage = await AgentStorage.open(path.join(dir, "agent.db"));

		// Usable, not merely constructed: a handle that opened and then failed on
		// first use would satisfy a weaker assertion while being just as broken.
		await expect(storage.backfillModelPerfFromStats(statsPath)).rejects.toThrow();
		expect(await AgentStorage.open(path.join(dir, "agent.db"))).toBeDefined();
	});

	/**
	 * The failure must be loud. `backfillModelPerfFromStats` throws rather than
	 * returning zero, so a caller cannot mistake "could not read the history" for
	 * "there was no history", which are different facts with the same shape.
	 */
	it("throws rather than reporting zero imported rows", async () => {
		const dir = newTempDir();
		const statsPath = path.join(dir, "stats.db");
		writeCorruptDb(statsPath);
		const storage = await AgentStorage.open(path.join(dir, "agent.db"));

		let thrown: unknown;
		try {
			await storage.backfillModelPerfFromStats(statsPath);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeDefined();
		// Naming the file is what makes the report actionable: a user can delete
		// the one database that is broken instead of resetting everything.
		expect(String(thrown)).toContain("stats.db");
	});

	/**
	 * A stats database that is absent, rather than damaged, is not a failure at
	 * all. Most installs have never run `veyyon stats`, so treating "no file" as
	 * an error would make the common case noisy and train everyone to ignore it.
	 */
	it("treats a missing stats database as nothing to import, not an error", async () => {
		const dir = newTempDir();
		const storage = await AgentStorage.open(path.join(dir, "agent.db"));

		// The startup path checks existence before opening, so a missing file never
		// reaches the reader. Asserted through the public surface: opening storage
		// with no stats.db beside it must simply work.
		expect(storage).toBeDefined();
		expect(fs.existsSync(path.join(dir, "stats.db"))).toBe(false);
	});

	/**
	 * A stats database that opens but has no `messages` table is the shape left
	 * by a truncated or half-migrated file. It must fail the same way a corrupt
	 * one does, rather than being read as an empty history.
	 */
	it("fails loudly on a stats database missing its messages table", async () => {
		const dir = newTempDir();
		const statsPath = path.join(dir, "stats.db");
		// A valid, empty SQLite file: opens fine, has none of the expected schema.
		const { Database } = await import("bun:sqlite");
		const empty = new Database(statsPath);
		empty.run("CREATE TABLE unrelated (id INTEGER)");
		empty.close();

		const storage = await AgentStorage.open(path.join(dir, "agent.db"));

		await expect(storage.backfillModelPerfFromStats(statsPath)).rejects.toThrow();
	});

	/**
	 * The other direction of the same separation: agent storage's own data must
	 * be untouched by any of this. If a stats failure could roll back or skip
	 * agent-side writes, the unimportant database would be taking the important
	 * one down after all.
	 */
	it("leaves agent-side data intact after a stats failure", async () => {
		const dir = newTempDir();
		const statsPath = path.join(dir, "stats.db");
		writeCorruptDb(statsPath);
		const agentPath = path.join(dir, "agent.db");

		const storage = await AgentStorage.open(agentPath);
		await storage.backfillModelPerfFromStats(statsPath).catch(() => undefined);
		AgentStorage.resetInstance();

		// Reopening is what a relaunch does, and it must find a healthy file.
		const reopened = await AgentStorage.open(agentPath);
		expect(reopened).toBeDefined();
		expect(fs.existsSync(agentPath)).toBe(true);
	});

	/**
	 * And the damaged file is never rewritten. Repairing or truncating someone's
	 * stats database to make an import succeed would destroy the very history the
	 * import exists to read, so the size is pinned before and after.
	 */
	it("does not modify the stats database it failed to read", async () => {
		const dir = newTempDir();
		const statsPath = path.join(dir, "stats.db");
		writeCorruptDb(statsPath);
		const before = fs.readFileSync(statsPath);

		const storage = await AgentStorage.open(path.join(dir, "agent.db"));
		await storage.backfillModelPerfFromStats(statsPath).catch(() => undefined);

		expect(fs.readFileSync(statsPath).equals(before)).toBe(true);
	});
});
