import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import { SESSION_TITLE_SLOT_ENTRY_TYPE, TITLE_CHANGE_ENTRY_TYPE } from "@veyyon/coding-agent/session/session-entries";
import { cleanupEmptyMoveSession, SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { pathExists, TempDir } from "@veyyon/utils";

/**
 * WHY: two managers can hold one transcript, and a full-file publish used to
 * delete whatever the other one appended.
 *
 * `SessionManager` appends through a writer handle but republishes the WHOLE file
 * for every rewrite (compaction, elision, a title change fallback, a recovered
 * error). The body it publishes is built from the entries it holds, so any line
 * another process appended after this manager read the file simply vanished. Two
 * terminals on one session reach that in three steps: `--continue` twice, or
 * `/resume` a session another instance still has open, then let either side
 * compact. The loss is silent both ways, because the process that loses its turns
 * is not the process that wrote the file.
 *
 * The class these rows close is "a full-file publish loses or duplicates a line",
 * not one reproduction of it. Rows 1 and 2 drive the publish in both directions,
 * row 3 repeats it, rows 4, 5 and 7 pin the opposite failure (a line emitted
 * twice), row 6 pins the diagnosis reaching the operator, and row 8 pins the
 * boundary: a fork or a branch is a NEW file, so the other writer's tail stays
 * behind while our own history stays ours.
 *
 * Rows 9 and 10 close the OTHER half of the same class, on the append side. A
 * publish is a temp write plus a rename, so every handle open on the path keeps
 * writing into an unlinked inode: the append reports success, the entry sits in
 * memory, and no reader ever sees it. Detection is by the identity the backend
 * reports for the path (`dev:ino`), not by size, because the ordinary case is the
 * other window republishing history it loaded from us, byte for byte the same
 * length. Row 10 is the burst: several entries land before the deferred merge can
 * run, and each must reach the file exactly once.
 *
 * Three producers install ids this manager owns (a load, an append, and the
 * title-change push that goes straight into the held list), and each one is
 * covered: a producer that stops claiming its ids republishes its own line as
 * though a stranger wrote it.
 *
 * Rows 11 to 15 are the members of the class that are not the ordinary append. A
 * title change writes through the handle and patches the title slot by PATH, so
 * the title survived a replacement while the entry recording it did not. The
 * publish on the way out (`flushSync`, exit) is the one that cannot be repaired
 * later, since the process is leaving. And the widest members are not publishes at
 * all: two automatic DELETES, the draft-only cleanup and the one that drops the
 * session `/move` left behind. Each decided the session was empty from the entries
 * this manager held, so a window that had typed nothing deleted a conversation
 * another window was having, and each now asks one shared question
 * (`holdsForeignEntries`). Row 14 is the positive control for the draft drop; the
 * one for the move cleanup lives beside it in
 * `test/session-manager/move-session-cleanup.test.ts`, which asserts an empty move
 * session IS deleted.
 *
 * MEASURED (mutation matrix, each mutant applied alone to
 * `packages/coding-agent/src/session/session-manager.ts`, rows numbered in file
 * order):
 * - M1 `#fileBody()` drops the `#foreignLines` loop (the pre-fix body): rows 1, 2,
 *   3, 8, 10 red.
 * - M2 `#refreshForeignLines()` returns before reading: rows 1, 2, 3, 6, 8, 10, 13
 *   red.
 * - M3 the refresh keeps every line instead of only ids that were never ours:
 *   rows 1, 2, 3, 4, 5, 7, 8, 9, 10 red.
 * - M4 `#recordEntry` stops claiming the appended id: rows 2, 5, 7, 9, 10 red.
 * - M5 the title-change push stops claiming its id: row 7 red.
 * - M6 `#forgetForeignWriter()` clears without reseeding from what we hold:
 *   rows 1, 2, 3, 4, 8 red.
 * - M7 `#forgetForeignWriter()` keeps the previous file's foreign tail: row 8 red.
 * - M8 the append path stops probing whether the file was replaced: rows 9, 10 red.
 * - M9 the probe compares size instead of identity: row 9 red. Row 10 stays green
 *   there because the other window also appended a line of its own before
 *   republishing, so the length changed and size was enough; row 9 is the case the
 *   product actually hits, a republish of exactly the history it loaded.
 * - M10 the deferred merge does not take the rewrite fence, so an append landing
 *   before it runs falls to the synchronous rewrite: row 10 red.
 * - M11 the title-change fast path stops probing for replacement (the pre-fix
 *   body): row 11 red. It is its own mutant because that path appends through the
 *   writer handle and patches the slot by path, so the title still changes and
 *   only the entry recording it is lost, which rows 9 and 10 cannot see.
 * - M12 `#refreshForeignLinesSync()` returns before reading: row 12 red.
 * - M13 `FileSessionStorage.readTextSync` answers nothing, which is what a backend
 *   that cannot read without yielding looks like: row 12 red. The manager degrades
 *   to the previous behaviour there rather than blocking, so this mutant proves the
 *   row is measuring the READ and not merely the call.
 * - M14 the draft-only drop deletes without asking whether the file holds a line
 *   that was never ours: row 13 red, and row 14 stays green under it, which is what
 *   says the guard narrows the delete rather than breaking it.
 * - M15 the `/move` cleanup deletes without asking: row 15 red.
 * - M16 `holdsForeignEntries()` answers from what it already knew instead of
 *   re-reading: rows 13 and 15 red. Both deletes run on the way out, after the last
 *   publish, so the only knowledge that can be current is a fresh read.
 *
 * WHAT THIS DOES NOT CATCH:
 * - A backend with no synchronous read. `#rewriteSynchronously` re-reads through
 *   `readTextSync`, which the file and memory backends implement and the indexed
 *   (Redis/SQL) one cannot: it awaits a per-path queue before it can answer. On
 *   that backend the synchronous publish still carries only the foreign lines the
 *   last atomic publish learned about. Row 12 runs on real files, which is where
 *   the product runs.
 * - Resurrection of an entry deliberately dropped from a file that keeps its
 *   name. `#idsEverSeen` holds ids we no longer carry for exactly that reason,
 *   but no product path drops an entry and republishes the same file today (a
 *   fork and a branch both write a new one), so no row can red on it.
 * - The one-warning latch. `OperatorNotices` collapses identical notices on its
 *   own, so row 6 proves the warning is raised and names the file, not that
 *   `#reportedForeignWriter` is what keeps it single.
 * - Interleaving at sub-write granularity. These rows sequence the two managers
 *   explicitly; a line torn between the read and the rename is a storage-level
 *   concern that `writeTextAtomic` owns.
 * - A memory or SQL backend appending a line the other writer already published.
 *   Those backends address by path, so nothing is stranded and nothing is lost,
 *   but they report no identity either, and the size fallback cannot see a
 *   same-length republish. Rows 9 and 10 run on real files, which is where the
 *   product runs and where the loss was.
 */

interface Persisted {
	lines: string[];
	ids: string[];
}

async function readFileState(file: string): Promise<Persisted> {
	const raw = await fs.readFile(file, "utf8");
	const lines = raw.split("\n").filter(line => line.trim().length > 0);
	const ids: string[] = [];
	for (const line of lines) {
		const parsed = JSON.parse(line) as { type?: string; id?: string };
		if (parsed.type === "session" || parsed.type === SESSION_TITLE_SLOT_ENTRY_TYPE) continue;
		if (parsed.id) ids.push(parsed.id);
	}
	return { lines, ids };
}

function messageTexts(manager: SessionManager): string[] {
	const texts: string[] = [];
	for (const entry of manager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user") continue;
		if (typeof message.content === "string") texts.push(message.content);
	}
	return texts;
}

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

describe("two managers on one transcript", () => {
	it("keeps the entries the other writer appended after this one loaded the file", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");

		const a = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("from A one"));
		a.appendMessage(userMessage("from A two"));
		await a.flush();

		const b = await SessionManager.open(file, dir);
		expect(messageTexts(b)).toEqual(["from A one", "from A two"]);

		a.appendMessage(userMessage("from A three"));
		await a.flush();

		await b.rewriteEntries();

		const after = await readFileState(file);
		expect(after.ids).toHaveLength(3);
		expect(new Set(after.ids).size).toBe(3);

		const reader = await SessionManager.open(file, dir);
		expect(messageTexts(reader)).toEqual(["from A one", "from A two", "from A three"]);

		await reader.close();
		await b.close();
		await a.close();
	});

	it("keeps both writers' entries when the other manager publishes next", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");

		const a = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("shared one"));
		await a.flush();

		const b = await SessionManager.open(file, dir);
		b.appendMessage(userMessage("from B"));
		await b.flush();

		a.appendMessage(userMessage("from A"));
		await a.flush();

		// A publishes: it has never seen B's entry, and B's entry must survive.
		await a.rewriteEntries();
		// B publishes next: it has never seen A's second entry, and both must survive.
		await b.rewriteEntries();

		const after = await readFileState(file);
		expect(after.ids).toHaveLength(3);
		expect(new Set(after.ids).size).toBe(3);

		// Both managers appended off the same parent, so the transcript is now a tree
		// and `getBranch()` walks ONE path through it. What must hold is that neither
		// publish deleted the other's line: read the file, not the active branch.
		const raw = await fs.readFile(file, "utf8");
		expect(raw).toContain("shared one");
		expect(raw).toContain("from A");
		expect(raw).toContain("from B");
		const reader = await SessionManager.open(file, dir);
		expect(messageTexts(reader)[0]).toBe("shared one");

		await reader.close();
		await b.close();
		await a.close();
	});

	it("publishes a foreign line once, however many rewrites follow", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");

		const a = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("from A one"));
		await a.flush();

		const b = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("from A two"));
		await a.flush();

		await b.rewriteEntries();
		const first = await fs.readFile(file, "utf8");
		await b.rewriteEntries();
		await b.rewriteEntries();
		const third = await fs.readFile(file, "utf8");

		// Nothing changed between the publishes, so the bytes must not change either:
		// a merge that re-collects its own output grows the file on every rewrite.
		expect(third).toBe(first);
		const after = await readFileState(file);
		expect(after.ids).toHaveLength(2);
		expect(new Set(after.ids).size).toBe(2);

		await b.close();
		await a.close();
	});

	it("treats nothing it loaded as foreign, so a rewrite does not double the file", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");

		const a = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("one"));
		a.appendMessage(userMessage("two"));
		a.appendMessage(userMessage("three"));
		await a.flush();
		await a.close();

		const b = await SessionManager.open(file, dir);
		await b.rewriteEntries();

		const after = await readFileState(file);
		// Title slot + header + three entries, each exactly once.
		expect(after.lines).toHaveLength(5);
		expect(new Set(after.ids).size).toBe(3);
		expect(messageTexts(b)).toEqual(["one", "two", "three"]);

		await b.close();
	});

	it("publishes an unchanged body for a session with no second writer", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");

		const a = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("solo one"));
		a.appendMessage(userMessage("solo two"));
		await a.flush();

		await a.rewriteEntries();
		const first = await fs.readFile(file, "utf8");
		a.appendMessage(userMessage("solo three"));
		await a.flush();
		await a.rewriteEntries();
		const second = await fs.readFile(file, "utf8");

		expect(second).not.toBe(first);
		const after = await readFileState(file);
		expect(after.lines).toHaveLength(5);
		expect(new Set(after.ids).size).toBe(3);

		await a.rewriteEntries();
		expect(await fs.readFile(file, "utf8")).toBe(second);

		await a.close();
	});

	it("warns the operator that a second session is writing the same file", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");

		const a = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("from A one"));
		await a.flush();

		const b = await SessionManager.open(file, dir);
		const raised: Array<{ severity: string; source: string; text: string }> = [];
		b.setOperatorNotices(new OperatorNotices(notice => raised.push(notice)));

		a.appendMessage(userMessage("from A two"));
		await a.flush();
		await b.rewriteEntries();

		expect(raised).toHaveLength(1);
		expect(raised[0]?.severity).toBe("warning");
		expect(raised[0]?.source).toBe("session");
		expect(raised[0]?.text).toContain(file);

		await b.close();
		await a.close();
	});

	it("publishes a title change once, though it never went through the append path", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");

		const a = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("solo one"));
		await a.flush();
		// A title change pushes its entry straight into the held list rather than
		// through the append path, so it is a second producer of ids this manager
		// owns and has to be claimed on its own.
		expect(await a.setSessionName("a titled session", "user")).toBe(true);

		await a.rewriteEntries();
		const first = await fs.readFile(file, "utf8");
		await a.rewriteEntries();
		const second = await fs.readFile(file, "utf8");

		expect(second).toBe(first);
		expect(first.split("\n").filter(line => line.includes(TITLE_CHANGE_ENTRY_TYPE))).toHaveLength(1);
		const after = await readFileState(file);
		expect(new Set(after.ids).size).toBe(after.ids.length);

		await a.close();
	});

	it("leaves the other writer's entries behind when it forks to its own file", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");

		const a = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("shared one"));
		a.appendMessage(userMessage("shared two"));
		await a.flush();

		const b = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("only A has this"));
		await a.flush();
		// B learns about A's line here, and must not take it along.
		await b.rewriteEntries();

		const forked = await b.fork();
		if (!forked) throw new Error("fork did not report its files");
		await b.rewriteEntries();

		const forkedRaw = await fs.readFile(forked.newSessionFile, "utf8");
		expect(forkedRaw).not.toContain("only A has this");
		const forkedState = await readFileState(forked.newSessionFile);
		expect(forkedState.ids).toHaveLength(2);
		expect(new Set(forkedState.ids).size).toBe(2);
		// The source keeps every line, including the one B never held.
		expect(await fs.readFile(file, "utf8")).toContain("only A has this");

		await b.close();
		await a.close();
	});

	it("keeps appending to the file that exists, not to the one the other writer replaced", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");

		const a = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("before the replace"));
		await a.flush();

		// A full-file publish is a temp write plus a rename, so the path now names a
		// different inode than the append handle A opened for its first entry.
		const b = await SessionManager.open(file, dir);
		await b.rewriteEntries();

		a.appendMessage(userMessage("after the replace"));
		await a.flush();

		// Writing into the unlinked inode is invisible to A: the append reports
		// success, the entry is in memory, and nothing that reads the path has it.
		expect(await fs.readFile(file, "utf8")).toContain("after the replace");

		const reader = await SessionManager.open(file, dir);
		expect(messageTexts(reader)).toEqual(["before the replace", "after the replace"]);

		await reader.close();
		await b.close();
		await a.close();
	});

	it("writes every entry of a burst that follows a replacement exactly once", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");

		const a = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("before the replace"));
		await a.flush();

		const b = await SessionManager.open(file, dir);
		b.appendMessage(userMessage("from the other window"));
		await b.flush();
		await b.rewriteEntries();

		// A whole turn's worth of entries, all landing before the deferred merge has
		// had a chance to run: each one has to reach the file, and none of them twice.
		a.appendMessage(userMessage("burst one"));
		a.appendMessage(userMessage("burst two"));
		a.appendMessage(userMessage("burst three"));
		await a.flush();

		const raw = await fs.readFile(file, "utf8");
		for (const text of ["burst one", "burst two", "burst three", "from the other window"]) {
			expect(raw.split(text)).toHaveLength(2);
		}
		const after = await readFileState(file);
		// Five entries: the shared first one, the other window's, and the burst of
		// three. Both windows appended off the same parent, so the transcript is a
		// tree and a reader walks one path through it; what matters is that every
		// entry is on disk exactly once.
		expect(after.ids).toHaveLength(5);
		expect(new Set(after.ids).size).toBe(5);

		const reader = await SessionManager.open(file, dir);
		expect(messageTexts(reader)[0]).toBe("before the replace");

		await reader.close();
		await b.close();
		await a.close();
	});

	it("keeps a title change on the file that exists after the other writer replaced it", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");

		const a = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("before the replace"));
		await a.flush();

		const b = await SessionManager.open(file, dir);
		await b.rewriteEntries();

		// A title change has its own write path: patch the fixed-width slot in place
		// and append the entry beside it. The slot patch addresses the path and lands
		// on the new file, so the title looks written while the entry recording it
		// goes into the inode nothing can reach.
		await a.setSessionName("named after the replace", "user");
		await a.flush();

		const raw = await fs.readFile(file, "utf8");
		expect(raw.split(TITLE_CHANGE_ENTRY_TYPE)).toHaveLength(2);
		expect(raw).toContain("before the replace");
		const after = await readFileState(file);
		expect(after.ids).toHaveLength(2);
		expect(new Set(after.ids).size).toBe(2);

		const reader = await SessionManager.open(file, dir);
		expect(reader.getSessionName()).toBe("named after the replace");
		expect(reader.getEntries().some(entry => entry.type === TITLE_CHANGE_ENTRY_TYPE)).toBe(true);

		await reader.close();
		await b.close();
		await a.close();
	});

	it("carries the other writer's entries through a synchronous publish on the way out", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");

		const a = await SessionManager.open(file, dir);
		a.appendMessage(userMessage("shared one"));
		await a.flush();

		const b = await SessionManager.open(file, dir);
		b.appendMessage(userMessage("from the other window"));
		await b.flush();
		await b.rewriteEntries();

		// The append detects the replacement and defers to the merging rewrite, and
		// then the process leaves before that rewrite can run: `flushSync` publishes
		// the whole file with no chance to await a read.
		a.appendMessage(userMessage("from this window"));
		a.flushSync();

		const raw = await fs.readFile(file, "utf8");
		for (const text of ["shared one", "from the other window", "from this window"]) {
			expect(raw.split(text)).toHaveLength(2);
		}
		const after = await readFileState(file);
		expect(after.ids).toHaveLength(3);
		expect(new Set(after.ids).size).toBe(3);

		await b.close();
		await a.close();
	});

	it("does not delete the transcript when the file it is dropping holds another writer's turns", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();

		// A fresh session has no file until something forces one, and saving a draft
		// is what forces it. That is the state whose close deletes the file again.
		const a = SessionManager.create(dir, dir);
		await a.saveDraft("half a thought");
		const file = a.getSessionFile();
		if (!file) throw new Error("the draft did not materialize a session file");

		// That file is the newest in the directory, so it is the one another window
		// resumes. Its turns are real conversation.
		const b = await SessionManager.open(file, dir);
		b.appendMessage(userMessage("a real turn from the other window"));
		await b.flush();

		// Clearing the composer removes the draft and leaves the cleanup armed, so
		// the close below is the delete.
		await a.saveDraft("");
		await a.close();

		expect(await fs.readFile(file, "utf8")).toContain("a real turn from the other window");
		const reader = await SessionManager.open(file, dir);
		expect(messageTexts(reader)).toEqual(["a real turn from the other window"]);

		await reader.close();
		await b.close();
	});

	it("still drops its own empty draft session when nothing else wrote the file", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();

		// The positive control for the row above: with no second writer the cleanup
		// must still delete the file, or the refusal is simply a broken drop.
		const a = SessionManager.create(dir, dir);
		await a.saveDraft("half a thought");
		const file = a.getSessionFile();
		if (!file) throw new Error("the draft did not materialize a session file");
		expect(await pathExists(file, "the draft-only session file")).toBe(true);

		await a.saveDraft("");
		await a.close();

		expect(await pathExists(file, "the draft-only session file")).toBe(false);
	});

	it("does not delete a moved-from session file another writer has taken over", async () => {
		using tempDir = TempDir.createSync("@veyyon-two-writers-");
		const dir = tempDir.path();

		// The other automatic delete in the product: a `/move` leaves behind a fresh
		// session file, and it is dropped on close when it never received a turn.
		const a = SessionManager.create(dir, dir);
		await a.ensureOnDisk();
		const file = a.getSessionFile();
		if (!file) throw new Error("the moved-from session has no file");

		const b = await SessionManager.open(file, dir);
		b.appendMessage(userMessage("a real turn from the other window"));
		await b.flush();

		await cleanupEmptyMoveSession(a, file);

		expect(await fs.readFile(file, "utf8")).toContain("a real turn from the other window");
		const reader = await SessionManager.open(file, dir);
		expect(messageTexts(reader)).toEqual(["a real turn from the other window"]);

		await reader.close();
		await b.close();
		await a.close();
	});
});
