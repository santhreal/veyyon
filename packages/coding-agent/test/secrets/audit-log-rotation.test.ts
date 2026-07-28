/**
 * The expansion log has a ceiling, and reaching it does not lose history.
 *
 * WHY THIS SUITE EXISTS. `secret-audit.jsonl` is append-only and was unbounded, which is two
 * defects wearing one coat. The obvious one is disk: a profile left running accumulates a record
 * per tool call that mentions a credential, forever. The one that actually bites sooner is speed,
 * because `read` parses the WHOLE file to render the last twenty lines, so `/secret log` gets
 * slower every day the profile is used and never gets faster (Law 7).
 *
 * The fix has to keep a property the naive fix breaks. Truncating the file at the ceiling would
 * discard the oldest records, which are exactly the ones an incident asks about, and a reader that
 * only looked at the live file would answer a `--limit 20` with one record straight after a
 * rotation, which reads as "that is all this agent ever did" rather than "that is all since the
 * file was moved aside". So what is pinned here is: the ceiling holds, the previous generation
 * survives, reads span both in order, and only two generations are ever kept.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	encodeRecord,
	MAX_RECORD_BYTES,
	ROTATE_AT_BYTES,
	ROTATED_SUFFIX,
	SecretAuditLog,
	type SecretExpansionRecord,
} from "@veyyon/coding-agent/secrets/audit";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";

let dir: string;
let logPath: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-audit-rotate-"));
	logPath = path.join(dir, "secret-audit.jsonl");
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/** Put the live file one byte beyond the point at which `entry` must trigger rotation. */
async function seedForRotation(entry: SecretExpansionRecord): Promise<void> {
	const incomingBytes = Buffer.byteLength(encodeRecord(entry));
	await fs.writeFile(logPath, Buffer.alloc(ROTATE_AT_BYTES - incomingBytes + 1, 0x20), { mode: 0o600 });
}

/** One small record, for the ordering assertions where size is irrelevant. */
function record(index: number, tool = "bash"): SecretExpansionRecord {
	return { at: 1_700_000_000_000 + index, secrets: [`#SECRET_${index}#`], tool, command: `run ${index}` };
}

/** Append every record and wait for the queue to drain. */
async function writeAll(log: SecretAuditLog, records: SecretExpansionRecord[]): Promise<void> {
	for (const entry of records) log.record(entry);
	await log.flush();
}

describe("the file size ceiling", () => {
	/**
	 * The live log never exceeds ROTATE_AT_BYTES.
	 *
	 * Checked BEFORE the append rather than after, which is the difference between a ceiling and a
	 * threshold the file is permitted to sit above until the next write happens to arrive. With the
	 * check after, a log could rest indefinitely at the ceiling plus one record.
	 */
	it("keeps the live log at or under the ceiling", async () => {
		const log = new SecretAuditLog(logPath);
		const entry = record(1);
		await seedForRotation(entry);
		await writeAll(log, [entry]);

		const size = (await fs.stat(logPath)).size;
		expect(size).toBeLessThanOrEqual(ROTATE_AT_BYTES);
		expect(size).toBeGreaterThan(0);
	});

	/**
	 * Only two generations exist afterwards, however many times the ceiling was crossed.
	 *
	 * `rename` onto the same target is what bounds this. A scheme that numbered generations upward
	 * would trade an unbounded file for an unbounded number of files, which is the same leak with
	 * more inodes.
	 */
	it("keeps exactly two generations, never more", async () => {
		const log = new SecretAuditLog(logPath);
		for (let index = 1; index <= 4; index++) {
			const entry = record(index);
			await seedForRotation(entry);
			await writeAll(log, [entry]);
		}

		const files = (await fs.readdir(dir)).sort();
		expect(files).toEqual(["secret-audit.jsonl", `secret-audit.jsonl${ROTATED_SUFFIX}`]);
	});

	/** No rotation happens while the log is small, so an ordinary profile has one file. */
	it("does not rotate a log under the ceiling", async () => {
		const log = new SecretAuditLog(logPath);
		await writeAll(log, [record(1), record(2), record(3)]);

		expect(await fs.readdir(dir)).toEqual(["secret-audit.jsonl"]);
	});
});

describe("reading across a rotation", () => {
	/**
	 * THE BUG A LIVE-FILE-ONLY READER WOULD HAVE.
	 *
	 * The rotated generation is written by hand here so the assertion is about the reader rather
	 * than about how many fat records it takes to trigger a rotation. A reader that opened only the
	 * live file would return one record and the operator would conclude the agent had used one
	 * credential.
	 */
	it("returns records from the previous generation as well as the live one", async () => {
		await fs.writeFile(
			`${logPath}${ROTATED_SUFFIX}`,
			`${[record(1), record(2)].map(r => JSON.stringify(r)).join("\n")}\n`,
		);
		await fs.writeFile(logPath, `${JSON.stringify(record(3))}\n`);

		const { records } = await new SecretAuditLog(logPath).read();

		expect(records.map(r => r.command)).toEqual(["run 1", "run 2", "run 3"]);
	});

	/**
	 * Order is oldest-first ACROSS the boundary, not per file.
	 *
	 * `/secret log` prints oldest first and says so, so a reader that appended the rotated
	 * generation after the live one would present a history that runs backwards in the middle.
	 */
	it("keeps the rotated generation before the live one", async () => {
		await fs.writeFile(`${logPath}${ROTATED_SUFFIX}`, `${JSON.stringify(record(1, "read"))}\n`);
		await fs.writeFile(logPath, `${JSON.stringify(record(2, "write"))}\n`);

		const { records } = await new SecretAuditLog(logPath).read();

		expect(records.map(r => r.tool)).toEqual(["read", "write"]);
	});

	/**
	 * A limit is applied to the combined history, which is the reason to read both at all.
	 *
	 * Four records exist, one of them in the live file. Asking for the last three has to reach back
	 * into the rotated generation for two of them.
	 */
	it("fills a limit from the previous generation when the live log is short", async () => {
		await fs.writeFile(
			`${logPath}${ROTATED_SUFFIX}`,
			`${[record(1), record(2), record(3)].map(r => JSON.stringify(r)).join("\n")}\n`,
		);
		await fs.writeFile(logPath, `${JSON.stringify(record(4))}\n`);

		const { records } = await new SecretAuditLog(logPath).read({ limit: 3 });

		expect(records.map(r => r.command)).toEqual(["run 2", "run 3", "run 4"]);
	});

	/** Malformed lines are counted across both generations, so neither hides a broken file. */
	it("counts malformed lines in both generations", async () => {
		await fs.writeFile(`${logPath}${ROTATED_SUFFIX}`, `not json\n${JSON.stringify(record(1))}\n`);
		await fs.writeFile(logPath, `{"at":1}\n${JSON.stringify(record(2))}\n`);

		const { records, malformed } = await new SecretAuditLog(logPath).read();

		expect(records.map(r => r.command)).toEqual(["run 1", "run 2"]);
		expect(malformed).toBe(2);
	});

	/** A profile with neither file is empty, not an error: nothing has been used yet. */
	it("reads an absent pair as empty", async () => {
		const { records, malformed } = await new SecretAuditLog(logPath).read();

		expect(records).toEqual([]);
		expect(malformed).toBe(0);
	});

	/** An absent rotated generation is normal and must not shadow a readable live log. */
	it("reads the live log when no rotation has happened", async () => {
		await fs.writeFile(logPath, `${JSON.stringify(record(7))}\n`);

		const { records } = await new SecretAuditLog(logPath).read();

		expect(records.map(r => r.command)).toEqual(["run 7"]);
	});
});

describe("a rotation that cannot happen", () => {
	/**
	 * A blocked rotation is a failed evidence write, not permission to exceed the cap. The live
	 * generation remains byte-identical and the operator is told that the bounded record was lost.
	 */
	it("stops before the cap and raises an error notice", async () => {
		await fs.mkdir(`${logPath}${ROTATED_SUFFIX}`, { recursive: true });
		const notices = new OperatorNotices(() => {});
		const log = new SecretAuditLog(logPath, notices);
		const entry = record(999);
		await seedForRotation(entry);
		const before = await fs.readFile(logPath);

		await writeAll(log, [entry]);

		const failure = notices.all().find(notice => notice.text.includes("could not be"));
		expect(failure?.severity).toBe("error");
		expect(failure?.text).toContain("not written");
		expect(await fs.readFile(logPath)).toEqual(before);
		expect((await fs.stat(logPath)).size).toBeLessThanOrEqual(ROTATE_AT_BYTES);
	});
});

describe("the rotated path", () => {
	/** Exposed, so `/secret log` and a support request can name the second file. */
	it("is the log path with the generation suffix", () => {
		expect(new SecretAuditLog(logPath).rotatedPath).toBe(`${logPath}${ROTATED_SUFFIX}`);
	});

	/**
	 * The ceiling stays a whole multiple of the per-line cap, by a wide margin.
	 *
	 * Not arithmetic for its own sake: a ceiling below one line's worth of bytes would rotate on
	 * every single append, turning the log into a two-record ring buffer while still looking like a
	 * log. This pins the relationship rather than the numbers.
	 */
	it("is far larger than a single record", () => {
		expect(ROTATE_AT_BYTES).toBeGreaterThan(MAX_RECORD_BYTES * 100);
	});
});
