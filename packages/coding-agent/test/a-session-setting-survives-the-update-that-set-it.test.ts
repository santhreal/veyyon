/**
 * WHY: `UpdateSessionParams` declared `breadth`, `attempts`, `maxParallel` and
 * `certify`, and `updateSession` built its SET clause from the other thirteen
 * fields only. Raising breadth on a live session — which is what the setup
 * console does when it is reopened on a running loop — returned a session row
 * that still read the old value, so the loop kept the shape it was opened with
 * and every later read of the row agreed with the stale value.
 *
 * The class is a declared-but-unwritten update field: one silent `if` missing
 * from the clause builder, with no error and no log. It is closed at the choke
 * point every field passes through, and the field list is read off the session
 * row at run time rather than typed out here, so a column `updateSession` cannot
 * write turns this red on the commit that adds it. The five fields that are not
 * updatable are pinned by exact equality instead of by count.
 *
 * What it does not catch: whether the setup console sends the update at all (the
 * console suite owns that), and whether a loop already inside a segment re-reads
 * the row before its next arm starts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	closeAllAutoresearchStorages,
	type OpenSessionParams,
	openAutoresearchStorage,
	type SessionRow,
	type UpdateSessionParams,
} from "@veyyon/coding-agent/autoresearch/storage";
import { TempDir } from "@veyyon/utils";

/**
 * Session-row fields that no update writes: the identity, the name it was opened
 * under, the segment the loop advances on its own, and the two timestamps. Every
 * other field must change, or `updateSession` is dropping it.
 */
const NOT_UPDATABLE = ["closedAt", "createdAt", "currentSegment", "id", "name"];

/** What the update has to move each field away from. */
const OPENED: OpenSessionParams = {
	name: "startup-latency",
	goal: "make it faster",
	primaryMetric: "duration",
	metricUnit: "ms",
	direction: "lower",
	preferredCommand: null,
	branch: "autoresearch/one",
	baselineCommit: "a".repeat(40),
	maxIterations: null,
	scopePaths: ["src/a.ts"],
	offLimits: ["vendor"],
	constraints: ["no api change"],
	secondaryMetrics: ["rss"],
};

/** A different value for every field an update is allowed to write. */
const UPDATES: UpdateSessionParams = {
	goal: "make it faster, then smaller",
	primaryMetric: "wall",
	metricUnit: "s",
	direction: "higher",
	preferredCommand: "bun test",
	branch: "autoresearch/two",
	baselineCommit: "b".repeat(40),
	maxIterations: 9,
	scopePaths: ["src/b.ts"],
	offLimits: ["dist"],
	constraints: ["no new deps"],
	secondaryMetrics: ["allocs"],
	notes: "## Plan\n- raise breadth\n",
	breadth: 4,
	attempts: 3,
	maxParallel: 2,
	certify: false,
};

function fields(session: SessionRow): Record<string, unknown> {
	return session as unknown as Record<string, unknown>;
}

describe("a session setting survives the update that set it", () => {
	let dbDir: TempDir;
	let projectDir: TempDir;

	beforeEach(() => {
		dbDir = TempDir.createSync("@pi-session-update-db-");
		process.env.VEYYON_AUTORESEARCH_DB_DIR = dbDir.path();
		projectDir = TempDir.createSync("@pi-session-update-cwd-");
	});

	afterEach(() => {
		delete process.env.VEYYON_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		projectDir.removeSync();
		dbDir.removeSync();
	});

	it("writes every field an update is allowed to change", async () => {
		const storage = await openAutoresearchStorage(projectDir.path());
		const opened = storage.openSession({ ...OPENED });

		const updated = storage.updateSession(opened.id, UPDATES);
		const reloaded = storage.getSessionById(opened.id);

		// The returned row is the stored row, not the caller's own object echoed.
		expect(reloaded).toEqual(updated);
		const before = fields(opened);
		const after = fields(updated);
		const unwritten = Object.keys(before).filter(
			key => !NOT_UPDATABLE.includes(key) && JSON.stringify(after[key]) === JSON.stringify(before[key]),
		);
		expect(unwritten).toEqual([]);
		// Pinned, so a new updatable column joins the sweep above rather than
		// quietly joining the exemptions.
		expect(
			Object.keys(before)
				.filter(key => NOT_UPDATABLE.includes(key))
				.sort(),
		).toEqual(NOT_UPDATABLE);
	});

	it("keeps the swarm shape a console raised, across a reopen of the store", async () => {
		// The console writes breadth and its three companions, and the next process
		// to open the database is the one that has to see them.
		const storage = await openAutoresearchStorage(projectDir.path());
		const opened = storage.openSession({ ...OPENED });
		expect({
			breadth: opened.breadth,
			attempts: opened.attempts,
			maxParallel: opened.maxParallel,
			certify: opened.certify,
		}).toEqual({ breadth: 1, attempts: 1, maxParallel: 8, certify: true });

		storage.updateSession(opened.id, { breadth: 4, attempts: 3, maxParallel: 2, certify: false });
		closeAllAutoresearchStorages();
		const reopened = await openAutoresearchStorage(projectDir.path());
		const session = reopened.getActiveSessionForBranch("autoresearch/one");

		expect(session).not.toBeNull();
		expect({
			breadth: session?.breadth,
			attempts: session?.attempts,
			maxParallel: session?.maxParallel,
			certify: session?.certify,
		}).toEqual({ breadth: 4, attempts: 3, maxParallel: 2, certify: false });
	});

	it("leaves a field alone when the update does not mention it", async () => {
		// The clause builder is keyed on `!== undefined`, so a partial update must
		// not blank the fields it omits — a console that sends only breadth would
		// otherwise erase the goal.
		const storage = await openAutoresearchStorage(projectDir.path());
		const opened = storage.openSession({ ...OPENED });

		const updated = storage.updateSession(opened.id, { breadth: 4 });

		expect(updated.breadth).toBe(4);
		expect(updated.goal).toBe(OPENED.goal);
		expect(updated.primaryMetric).toBe(OPENED.primaryMetric);
		expect(updated.scopePaths).toEqual([...OPENED.scopePaths]);
		expect(updated.certify).toBe(true);
	});
});
