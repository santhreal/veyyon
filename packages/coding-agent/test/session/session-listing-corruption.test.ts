import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { clearUnreadableSessions, getUnreadableSessions, listSessions } from "@veyyon/kernel/session/session-listing";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { removeWithRetries } from "@veyyon/utils";
import { guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makeSessionCorruptDir = useTrackedTempDirs("veyyon-session-corrupt-");

/**
 * SESS-1: a damaged session must not take the other sessions down with it, and
 * must not disappear in silence either.
 *
 * Two behaviours are in tension and both matter. Listing has to be FAIL-SOFT: if
 * one corrupt file threw, `/resume` and the welcome shortlist would break
 * entirely, stranding someone whose only route to fixing it is the tool that no
 * longer starts. But it was implemented as fail-SILENT, which is a different
 * product: a session that vanishes with no message is indistinguishable from one
 * the user never created, so the damage presents as their own faulty memory
 * instead of as a file to go and look at.
 *
 * The whole-directory case is worse still. A scan failure returned `[]`, turning
 * "your sessions are unreadable" into the calm, plausible, completely wrong
 * answer "you have no sessions".
 *
 * So the contract this suite pins is: the good sessions still list, the damaged
 * one is left out, AND the drop is recorded where a surface can report it. Two
 * silences stay deliberate — a missing directory (first run) and a file that
 * disappears between the scan and the read (a race, not damage) — because a
 * warning that fires in normal use trains people to ignore the line.
 */
describe("session listing survives corruption without hiding it", () => {
	const storage = new FileSessionStorage();
	let sessionDir = "";

	function writeSession(name: string, title: string): string {
		const file = path.join(sessionDir, name);
		const header = { type: "session", id: name.replace(".jsonl", ""), title, timestamp: new Date(0).toISOString() };
		const message = { type: "message", role: "user", content: [{ type: "text", text: `hello from ${title}` }] };
		fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
		return file;
	}

	beforeEach(() => {
		sessionDir = makeSessionCorruptDir();
		clearUnreadableSessions();
	});

	afterEach(async () => {
		clearUnreadableSessions();
		if (sessionDir) {
			await removeWithRetries(guardDestructivePath(sessionDir, "session-listing-corruption"));
			sessionDir = "";
		}
	});

	describe("a healthy directory", () => {
		test("lists every session and records nothing", async () => {
			// The control the rest of the file depends on. Without it, every
			// "the good ones survive" assertion below could pass while listing was
			// broken outright.
			writeSession("2020-01-01_a.jsonl", "first task");
			writeSession("2020-01-02_b.jsonl", "second task");

			const sessions = await listSessions(sessionDir, storage);

			expect(sessions.map(s => s.title).sort()).toEqual(["first task", "second task"]);
			expect(getUnreadableSessions()).toEqual([]);
		});

		test("an empty directory lists nothing and records nothing", async () => {
			expect(await listSessions(sessionDir, storage)).toEqual([]);
			expect(getUnreadableSessions()).toEqual([]);
		});
	});

	describe("one damaged file among healthy ones", () => {
		test("the damaged file is RECORDED, not merely skipped", async () => {
			// The assertion the row is actually about. Everything else here would pass
			// just as well with the old silent `return undefined`.
			//
			// Note which code path this exercises: garbage does not THROW, because the
			// JSONL parse is lenient. It yields no readable header and returns early,
			// which is why reporting had to be added at that branch and not only in the
			// catch — the catch never sees the common case.
			const broken = path.join(sessionDir, "2020-01-03_broken.jsonl");
			fs.writeFileSync(broken, "{not json at all\n  ");

			await listSessions(sessionDir, storage);

			const recorded = getUnreadableSessions();
			expect(recorded).toHaveLength(1);
			expect(recorded[0]?.path).toBe(broken);
			expect(recorded[0]?.kind).toBe("file");
			expect(recorded[0]?.reason).toContain("no readable session header");
		});

		test("an empty file is recorded too", async () => {
			// The zero-byte outcome of a crash mid-create. It has no header either, and
			// it is the case most likely to be dismissed as "nothing there".
			const empty = path.join(sessionDir, "2020-01-04_empty.jsonl");
			fs.writeFileSync(empty, "");

			await listSessions(sessionDir, storage);

			expect(getUnreadableSessions().map(entry => entry.path)).toEqual([empty]);
		});

		test("every damaged file is recorded when several are broken", async () => {
			// One report per casualty: a user with three broken sessions needs three
			// paths, not a note that something somewhere failed.
			fs.writeFileSync(path.join(sessionDir, "2020-01-01_a.jsonl"), "garbage\n");
			fs.writeFileSync(path.join(sessionDir, "2020-01-02_b.jsonl"), "more garbage\n");

			await listSessions(sessionDir, storage);

			expect(getUnreadableSessions()).toHaveLength(2);
		});

		test("a healthy session is never recorded alongside a broken one", async () => {
			// Guards against over-reporting, which would be its own failure: a warning
			// that fires for working sessions is one people learn to ignore.
			writeSession("2020-01-01_a.jsonl", "first task");
			fs.writeFileSync(path.join(sessionDir, "2020-01-02_b.jsonl"), "garbage\n");

			await listSessions(sessionDir, storage);

			expect(getUnreadableSessions().map(entry => path.basename(entry.path))).toEqual(["2020-01-02_b.jsonl"]);
		});

		test("the healthy sessions still list", async () => {
			// The fail-soft half: this is why the catch exists at all, and it must keep
			// working after the reporting was added.
			writeSession("2020-01-01_a.jsonl", "first task");
			writeSession("2020-01-02_b.jsonl", "second task");
			fs.writeFileSync(path.join(sessionDir, "2020-01-03_broken.jsonl"), "{not json at all\n\x00\x00");

			const sessions = await listSessions(sessionDir, storage);

			expect(sessions.map(s => s.title).sort()).toEqual(["first task", "second task"]);
		});

		test("a file with no parseable header is left out rather than listed as a blank", async () => {
			// Deliberate: a header-less file has no id, no title and no timestamp, so
			// listing it would put an unusable row in `/resume` that resumes nothing.
			fs.writeFileSync(path.join(sessionDir, "2020-01-03_headerless.jsonl"), '{"type":"message"}\n');

			expect(await listSessions(sessionDir, storage)).toEqual([]);
		});

		test("a directory of only damaged files lists nothing, which must not look like success", async () => {
			// The shape that motivated the whole row: every session gone, empty list
			// returned, and previously not one word about it anywhere.
			fs.writeFileSync(path.join(sessionDir, "2020-01-01_a.jsonl"), "garbage\n");
			fs.writeFileSync(path.join(sessionDir, "2020-01-02_b.jsonl"), "more garbage\n");

			expect(await listSessions(sessionDir, storage)).toEqual([]);
		});
	});

	describe("what stays quiet on purpose", () => {
		test("a session directory that does not exist yet records nothing", async () => {
			// First run. If absence were reported, every new user would be told their
			// sessions are broken, and the report would stop meaning anything.
			const missing = path.join(sessionDir, "not-created-yet");

			expect(await listSessions(missing, storage)).toEqual([]);
			expect(getUnreadableSessions()).toEqual([]);
		});
	});

	describe("the record itself", () => {
		test("clearing it empties it, so a reporting surface can consume and reset", async () => {
			fs.writeFileSync(path.join(sessionDir, "2020-01-01_a.jsonl"), "garbage\n");
			await listSessions(sessionDir, storage);

			clearUnreadableSessions();

			expect(getUnreadableSessions()).toEqual([]);
		});

		test("rescanning the same broken file does not report it twice", async () => {
			// A directory is rescanned on every `/resume`. An ever-growing list of the
			// same broken file is noise, not information, so the accessor dedupes by
			// path.
			fs.writeFileSync(path.join(sessionDir, "2020-01-01_a.jsonl"), "garbage\n");

			await listSessions(sessionDir, storage);
			await listSessions(sessionDir, storage);
			await listSessions(sessionDir, storage);

			const paths = getUnreadableSessions().map(entry => entry.path);
			expect(new Set(paths).size).toBe(paths.length);
		});
	});
});
