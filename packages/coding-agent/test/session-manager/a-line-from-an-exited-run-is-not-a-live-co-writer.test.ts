/**
 * A session file that grows an exit record from another run has not grown a
 * co-writer: that record is the other run reporting that it is gone.
 *
 * WHY THIS SUITE EXISTS, from a real transcript. A long-running session reported
 * `Another veyyon session is writing <path>; ... Close one of them` with one operator
 * and one window open. The file held exactly one line the running process had not
 * written, and that line was
 * `{"type":"custom","customType":"session_exit","data":{"reason":"sighup","kind":"signal"},...}`,
 * appended about a minute before the warning. A second window had the same session
 * open, took SIGHUP, wrote its exit record with the leaf id it had been holding — so
 * the record lands out of file order and forks the parent chain — and died. The
 * surviving session read back an id it had never written and told the operator to
 * close a session that had just closed itself. The same shape appears twice in that
 * file, both `sighup`.
 *
 * The class this closes is reading a terminal record as evidence of liveness. An
 * unrecognized id proves only that this process did not write the line; whether the
 * writer still exists is a different question, and an exit record answers it. So the
 * count that raises the warning excludes exit records, and both sides are asserted
 * below — suppressing the exit case is worthless if it also suppresses an ordinary
 * foreign entry, which says nothing about the writer having stopped.
 *
 * WHAT IT DOES NOT CATCH: a window that writes ordinary entries and then exits still
 * warns, because those entries are a real interleaving and the operator is told about
 * it while it is stale by a moment. Nothing here proves the foreign lines are
 * preserved through a publish either; that is the foreign-line merge, which the
 * file-operations suites assert.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { logger, removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { makeAssistantMessage } from "./helpers";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) removeSyncWithRetries(dir);
});

async function workspace(): Promise<string> {
	const dir = path.join(os.tmpdir(), `session-cowriter-${Snowflake.next()}`);
	await mkdir(dir, { recursive: true });
	dirs.push(dir);
	return dir;
}

/** Notices raised with `source: "session"`, which is the channel the operator reads. */
function sessionWarnings(notices: OperatorNotices): string[] {
	const seen: string[] = [];
	notices.setSink(notice => {
		if (notice.source === "session") seen.push(notice.text);
	});
	return seen;
}

/** An answered turn: a transcript holding only a draft is never written to disk. */
async function seedTranscript(dir: string): Promise<string> {
	const first = SessionManager.create(dir, dir, undefined, { operatorNotices: new OperatorNotices(() => {}) });
	first.appendMessage({ role: "user", content: "first question", timestamp: 1 });
	first.appendMessage(makeAssistantMessage());
	await first.flush();
	const file = first.getSessionFile();
	if (!file) throw new Error("the seeded session has no file");
	return file;
}

/**
 * Append entries the way a second veyyon process does: publish the whole file to a
 * temporary path and rename it over this one, chaining each new entry to an earlier
 * parent rather than the tail, which is the out-of-order shape the recorded file has.
 * The rename matters — an in-place write keeps the inode, and the divergence check
 * reads identity where the backend reports it, so writing in place would simulate a
 * co-writer the product cannot see and would prove nothing.
 */
async function publishOutOfBand(file: string, entries: readonly Record<string, unknown>[]): Promise<void> {
	const parentId = await firstEntryId(file);
	const lines = entries.map(entry => JSON.stringify({ parentId, timestamp: new Date().toISOString(), ...entry }));
	const existing = await readFile(file, "utf8");
	const staged = `${file}.other-writer`;
	await writeFile(staged, `${existing.endsWith("\n") ? existing : `${existing}\n`}${lines.join("\n")}\n`);
	await rename(staged, file);
}

/** The exit record a run appends on the way out, as the recorded file carries it. */
function exitRecord(id: string): Record<string, unknown> {
	return {
		type: "custom",
		customType: "session_exit",
		data: { reason: "sighup", kind: "signal", recordedAt: new Date().toISOString() },
		id,
	};
}

/** An ordinary entry: nothing about it says the writer has stopped. */
function ordinaryRecord(id: string): Record<string, unknown> {
	return { type: "custom", customType: "note", data: { text: "written by another window" }, id };
}

/** The id an out-of-band writer chains onto: the first real entry, not the tail. */
async function firstEntryId(file: string): Promise<string> {
	for (const raw of (await readFile(file, "utf8")).split("\n")) {
		if (!raw.trim()) continue;
		const parsed = JSON.parse(raw) as { type?: unknown; id?: unknown };
		if (parsed.type === "session" || parsed.type === "title") continue;
		if (typeof parsed.id === "string") return parsed.id;
	}
	throw new Error("the seeded transcript has no entries");
}

describe("a session file that another run wrote to", () => {
	/**
	 * THE BACKTEST: the recorded shape, replayed. The read finds the line — asserted,
	 * so the case cannot pass by never looking — and says nothing about it.
	 */
	it("stays quiet when the only foreign line is another run's exit record", async () => {
		const dir = await workspace();
		const file = await seedTranscript(dir);

		const notices = new OperatorNotices();
		const warnings = sessionWarnings(notices);
		const resumed = await SessionManager.open(file, dir, undefined, { operatorNotices: notices });
		await publishOutOfBand(file, [exitRecord("0000aaaa")]);

		expect(await resumed.holdsForeignEntries()).toBe(true);
		expect(warnings).toEqual([]);
	});

	/**
	 * NON-VACUITY, and the other half of the class: an ordinary entry from another
	 * window is a real interleaving and nothing in it says that window stopped.
	 * Suppressing this case would be the same defect facing the other way.
	 */
	it("still reports an ordinary entry from another window", async () => {
		const dir = await workspace();
		const file = await seedTranscript(dir);

		const notices = new OperatorNotices();
		const warnings = sessionWarnings(notices);
		const resumed = await SessionManager.open(file, dir, undefined, { operatorNotices: notices });
		await publishOutOfBand(file, [ordinaryRecord("0000bbbb")]);

		expect(await resumed.holdsForeignEntries()).toBe(true);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Another veyyon session is writing");
	});

	/** An exit record alongside real entries does not buy the writer its silence. */
	it("reports a window that wrote entries before its exit record", async () => {
		const dir = await workspace();
		const file = await seedTranscript(dir);

		const notices = new OperatorNotices();
		const warnings = sessionWarnings(notices);
		const resumed = await SessionManager.open(file, dir, undefined, { operatorNotices: notices });
		await publishOutOfBand(file, [ordinaryRecord("0000cccc"), exitRecord("0000dddd")]);

		await resumed.holdsForeignEntries();
		expect(warnings).toHaveLength(1);
	});

	/**
	 * The claim is made once per session, not once per read. Asserted on the log,
	 * because the operator channel collapses identical notices on its own and would
	 * read as one however many times the manager raised it.
	 */
	it("reports a live co-writer once, however many entries it goes on to see", async () => {
		const dir = await workspace();
		const file = await seedTranscript(dir);
		const logged: string[] = [];
		const warnSpy = spyOn(logger, "warn").mockImplementation((message: string) => {
			logged.push(message);
		});

		try {
			const notices = new OperatorNotices();
			const warnings = sessionWarnings(notices);
			const resumed = await SessionManager.open(file, dir, undefined, { operatorNotices: notices });

			for (const id of ["0000eeee", "0000ffff", "00001111"]) {
				await publishOutOfBand(file, [ordinaryRecord(id)]);
				await resumed.holdsForeignEntries();
			}

			expect(warnings).toHaveLength(1);
			expect(logged.filter(message => message === "session file has a second writer")).toHaveLength(1);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
