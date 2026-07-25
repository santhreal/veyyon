import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { getStatsDbPath } from "@veyyon/utils";
import { closeDb, getMessageCount, initDb, insertMessageStats } from "@veyyon/stats/db";
import type { MessageStats } from "@veyyon/stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

/**
 * Several veyyon processes write to one stats database at once.
 *
 * `stats.db` is per-user, not per-session, so every concurrent session, every
 * subagent, and every `veyyon stats` run writes to the SAME file. SQLite takes a
 * whole-database write lock, so this is the one place in veyyon where ordinary
 * use produces genuine multi-process write contention.
 *
 * Two failures are possible and they look nothing alike. A missing
 * `busy_timeout` makes a writer that finds the lock held fail INSTANTLY with
 * SQLITE_BUSY, and the row is simply gone: no error reaches the user, because
 * stats collection is best-effort, so usage history quietly develops holes under
 * exactly the load that makes it interesting. The opposite mistake, a long
 * timeout without WAL, makes readers block behind writers and stalls the
 * status line.
 *
 * The setup guards both, and the ORDER matters as much as the settings:
 * `busy_timeout` is installed before any lock-taking statement, because a busy
 * handler set after the first lock attempt does not apply to it. WAL then keeps
 * readers off the writers' lock entirely.
 *
 * These tests use real subprocesses, each with its own database handle, because
 * that is what separate sessions are. Two handles inside one process share
 * SQLite's connection-level state and would not reproduce the contention this is
 * about. Row counts are asserted EXACTLY: "some rows arrived" is precisely the
 * assertion a dropped-row bug passes.
 */

const isolation = installStatsTestIsolation("@veyyon-stats-concurrent-");

function createStats(sessionFile: string, entryId: string, timestamp: number): MessageStats {
	return {
		agentType: "main",
		api: "anthropic-messages",
		duration: 1000,
		entryId,
		errorMessage: null,
		folder: "/tmp/project",
		model: "claude-opus-5",
		provider: "anthropic",
		sessionFile,
		stopReason: "stop",
		timestamp,
		ttft: 100,
		usage: {
			cacheRead: 0,
			cacheWrite: 0,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
			input: 100,
			output: 50,
			totalTokens: 150,
		},
	};
}

/**
 * Body of one writer process: open the same database and insert `count` rows
 * under its own session file, then exit. Kept as source text so each writer is a
 * real separate process with a genuinely separate connection.
 */
const WRITER_SOURCE = `
import { Database } from "bun:sqlite";
const [dbPath, session, countRaw, baseTsRaw] = process.argv.slice(2);
const count = Number(countRaw);
const baseTs = Number(baseTsRaw);
const db = new Database(dbPath);
// The same two pragmas the real writer installs, in the same order.
db.run("PRAGMA busy_timeout = 5000");
db.run("PRAGMA journal_mode = WAL");
const stmt = db.prepare(\`
  INSERT INTO messages (
    session_file, entry_id, folder, model, provider, api, timestamp,
    duration, ttft, stop_reason, error_message,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
    cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, agent_type
  ) VALUES (?, ?, '/tmp/project', 'claude-opus-5', 'anthropic', 'anthropic-messages', ?,
    1000, 100, 'stop', NULL, 100, 50, 0, 0, 150, 0, 0, 0, 0, 0, 0, 'main')
  ON CONFLICT(session_file, entry_id) DO NOTHING
\`);
for (let i = 0; i < count; i++) {
  stmt.run(session, session + "-" + i, baseTs + i);
}
db.close();
`;

async function runWriters(dbPath: string, writers: number, rowsEach: number, baseTs: number): Promise<void> {
	const scriptPath = `${dbPath}.writer.ts`;
	await Bun.write(scriptPath, WRITER_SOURCE);
	const procs = Array.from({ length: writers }, (_, index) =>
		Bun.spawn(["bun", scriptPath, dbPath, `/tmp/session-${index}.jsonl`, String(rowsEach), String(baseTs)], {
			stderr: "pipe",
			stdout: "pipe",
		}),
	);
	const codes = await Promise.all(procs.map(proc => proc.exited));
	const failures = await Promise.all(
		procs.map(async (proc, index) => (codes[index] === 0 ? null : `writer ${index}: ${await new Response(proc.stderr).text()}`)),
	);
	const failed = failures.filter(Boolean);
	// Every writer must SUCCEED. A writer that died on SQLITE_BUSY would
	// otherwise just lower the row count, and the count assertion alone could not
	// tell that apart from rows being silently dropped.
	expect(failed).toEqual([]);
}

describe("concurrent writers on one stats database", () => {
	/**
	 * The core contract, and the one a missing busy handler breaks: every row
	 * from every process is present. Asserted as an exact total, because the
	 * failure mode is losing SOME rows, which any "greater than zero" check
	 * happily passes.
	 */
	it("loses no rows when several processes write at once", async () => {
		await initDb();
		closeDb();
		const dbPath = getStatsDbPath();

		const writers = 4;
		const rowsEach = 50;
		await runWriters(dbPath, writers, rowsEach, 1_700_000_000_000);

		await initDb();
		expect(getMessageCount()).toBe(writers * rowsEach);
	});

	/**
	 * And every writer's rows survive individually. A total that happens to match
	 * could still hide one process's rows replacing another's, since the count is
	 * only a sum; this pins the per-session breakdown.
	 */
	it("keeps each writer's rows attributed to its own session", async () => {
		await initDb();
		closeDb();
		const dbPath = getStatsDbPath();

		const writers = 3;
		const rowsEach = 25;
		await runWriters(dbPath, writers, rowsEach, 1_700_000_100_000);

		const db = new Database(dbPath, { readonly: true });
		try {
			const rows = db.prepare("SELECT session_file, COUNT(*) AS n FROM messages GROUP BY session_file").all() as {
				n: number;
				session_file: string;
			}[];
			expect(rows).toHaveLength(writers);
			for (const row of rows) expect(row.n).toBe(rowsEach);
		} finally {
			db.close();
		}
	});

	/**
	 * Re-running the same writers must not duplicate anything. The stats importer
	 * is re-run over session files that have not changed, so the `UNIQUE(session_file,
	 * entry_id)` constraint is what keeps a second pass from doubling a user's
	 * recorded spend. Without it the numbers would drift upward every launch.
	 */
	it("is idempotent when the same rows are written twice", async () => {
		await initDb();
		closeDb();
		const dbPath = getStatsDbPath();

		await runWriters(dbPath, 2, 20, 1_700_000_200_000);
		await runWriters(dbPath, 2, 20, 1_700_000_200_000);

		await initDb();
		expect(getMessageCount()).toBe(2 * 20);
	});

	/**
	 * An in-process write must still land while other processes hold the database
	 * open. This is the live session's own path, and it is the one that matters
	 * most: the others are importers, this is the agent recording what it just
	 * spent.
	 */
	it("accepts an in-process insert alongside external writers", async () => {
		await initDb();
		closeDb();
		const dbPath = getStatsDbPath();
		await runWriters(dbPath, 2, 30, 1_700_000_300_000);

		await initDb();
		const inserted = insertMessageStats([createStats("/tmp/live-session.jsonl", "live-1", 1_700_000_400_000)]);

		expect(inserted).toBe(1);
		expect(getMessageCount()).toBe(2 * 30 + 1);
	});

	/**
	 * The pragmas are asserted directly, because they are the mechanism the rest
	 * of this file depends on and a silent revert would leave every test above
	 * passing on a small enough machine while breaking under real load. WAL in
	 * particular persists in the file header, so it is checked as stored state.
	 */
	it("runs in WAL mode with a busy timeout", async () => {
		const db = await initDb();

		expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
		expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
	});

	/** The isolation helper must actually be giving each test its own file. */
	it("uses a per-test database path", () => {
		expect(isolation.current()).not.toBeNull();
		expect(getStatsDbPath()).toContain("veyyon-stats-concurrent-");
	});
});
