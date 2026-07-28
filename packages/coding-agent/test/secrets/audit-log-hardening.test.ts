/**
 * Cross-process and adversarial boundaries of the secret expansion audit log.
 *
 * Rotation is a read-modify-write transaction shared by every process using a profile, not a
 * per-instance queue operation. Records also originate at a security boundary: a typed caller can
 * still supply pathological metadata at runtime, and an existing log can carry permissions or a
 * file type that append mode alone does not fix. These cases pin the complete contract: bounded
 * evidence, atomic rotation decisions, owner-only regular files, loud degradation, and flush as
 * the point at which ordered writes are observable.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildExpansionRecord,
	decodeLog,
	encodeRecord,
	MAX_RECORD_BYTES,
	ROTATE_AT_BYTES,
	ROTATED_SUFFIX,
	SECRET_AUDIT_FILENAME,
	SecretAuditLog,
	type SecretExpansionRecord,
} from "@veyyon/coding-agent/secrets/audit";
import { renderLog } from "@veyyon/coding-agent/secrets/secret-command";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";

let dir: string;
let logPath: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-audit-hardening-"));
	logPath = path.join(dir, SECRET_AUDIT_FILENAME);
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

function record(index: number, command = `run ${index}`): SecretExpansionRecord {
	return {
		at: 1_700_000_000_000 + index,
		secrets: [`#TOKEN_${String(index).padStart(5, "0")}#`],
		tool: "bash",
		command,
	};
}

/** Seed one valid record plus a blank JSONL line to an exact file size. */
async function seedToSize(size: number): Promise<void> {
	const line = Buffer.from(`${JSON.stringify(record(0, "seed"))}\n`);
	if (line.length + 1 > size) throw new Error("The requested audit seed is too small.");
	const bytes = Buffer.concat([line, Buffer.alloc(size - line.length - 1, 0x20), Buffer.from("\n")]);
	await fs.writeFile(logPath, bytes, { mode: 0o600 });
}

describe("expansion parity", () => {
	/**
	 * Tool-argument expansion walks object keys as strings. The audit scanner must do the same or
	 * a credential can reach a tool as a key while the detective record says nothing was used.
	 */
	it("records placeholders nested in JSON object keys", () => {
		const args = { nested: { "#TOKEN_KEY#": "value" } };
		const expansion = buildExpansionRecord({
			args,
			tool: "bash",
			session: "session",
			at: 1,
			known: placeholder => placeholder === "#TOKEN_KEY#",
		});

		expect(expansion?.secrets).toEqual(["#TOKEN_KEY#"]);
	});
});

describe("cross-process rotation", () => {
	/**
	 * Both instances individually see enough room for one line. Only a lock spanning stat, rename,
	 * and append can make the second instance observe the first append and rotate before writing.
	 */
	it("serialises two instances at the rotation boundary without losing either record", async () => {
		const firstRecord = record(1, "process-a");
		const secondRecord = record(2, "process-b");
		const lineBytes = Buffer.byteLength(encodeRecord(firstRecord));
		expect(Buffer.byteLength(encodeRecord(secondRecord))).toBe(lineBytes);
		await seedToSize(ROTATE_AT_BYTES - lineBytes);

		const first = new SecretAuditLog(logPath);
		const second = new SecretAuditLog(logPath);
		first.record(firstRecord);
		second.record(secondRecord);
		await Promise.all([first.flush(), second.flush()]);

		expect((await fs.stat(logPath)).size).toBeLessThanOrEqual(ROTATE_AT_BYTES);
		expect((await fs.stat(`${logPath}${ROTATED_SUFFIX}`)).size).toBeLessThanOrEqual(ROTATE_AT_BYTES);
		const { records, malformed } = await new SecretAuditLog(logPath).read();
		expect(malformed).toBe(0);
		expect(records[0].command).toBe("seed");
		expect(
			records
				.slice(1)
				.map(entry => entry.command)
				.sort(),
		).toEqual(["process-a", "process-b"]);
		expect((await fs.readdir(dir)).some(name => name.endsWith(".lock"))).toBe(false);
	});
});

describe("bounded record evidence", () => {
	/**
	 * The placeholder list used to survive command truncation unchanged, so enough placeholders
	 * alone produced an over-cap line. Keep an ordered useful prefix and make the loss explicit.
	 */
	it("caps oversized placeholder arrays and records the exact omitted count", () => {
		const total = 10_000;
		const line = encodeRecord({
			at: 1,
			secrets: Array.from({ length: total }, (_, index) => `#TOKEN_${String(index).padStart(5, "0")}#`),
			tool: "bash",
			command: "deploy with the listed credentials",
		});
		const parsed = JSON.parse(line) as SecretExpansionRecord;

		expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES);
		expect(parsed.secrets).toEqual(
			Array.from({ length: parsed.secrets.length }, (_, index) => `#TOKEN_${String(index).padStart(5, "0")}#`),
		);
		expect(parsed.secrets.length).toBeGreaterThan(0);
		expect(parsed.secrets.length).toBeLessThan(total);
		expect(parsed.omittedSecrets).toBe(total - parsed.secrets.length);
		expect(parsed.command).toBe("deploy with the listed credentials");
		expect(parsed.truncated).toBe(true);
		expect(decodeLog(line)).toEqual({ records: [parsed], malformed: 0 });
	});

	/** Exactly MAX_RECORD_BYTES is legal; the first byte beyond it must trigger marked truncation. */
	it("accepts the exact byte cap and truncates the next byte", () => {
		const secrets = Array.from({ length: 15 }, (_, index) => {
			const suffix = String(index).padStart(2, "0");
			return `#A${suffix}${"B".repeat(61)}#`;
		});
		const boundary: SecretExpansionRecord = { at: 1, secrets, tool: "bash", command: "" };
		const emptyBytes = Buffer.byteLength(`${JSON.stringify(boundary)}\n`);
		boundary.command = "x".repeat(MAX_RECORD_BYTES - emptyBytes);

		const exact = encodeRecord(boundary);
		expect(Buffer.byteLength(exact)).toBe(MAX_RECORD_BYTES);
		expect((JSON.parse(exact) as SecretExpansionRecord).truncated).toBeUndefined();

		const over = encodeRecord({ ...boundary, command: `${boundary.command}x` });
		expect(Buffer.byteLength(over)).toBeLessThanOrEqual(MAX_RECORD_BYTES);
		expect((JSON.parse(over) as SecretExpansionRecord).truncated).toBe(true);
	});
});

describe("existing audit paths", () => {
	/** Append's create mode is ignored for an existing file; the implementation must chmod it. */
	it("corrects a permissive owned log before appending", async () => {
		if (process.platform === "win32") return;
		await fs.writeFile(logPath, encodeRecord(record(1)), { mode: 0o600 });
		await fs.chmod(logPath, 0o666);
		const log = new SecretAuditLog(logPath);

		log.record(record(2));
		await log.flush();

		expect((await fs.stat(logPath)).mode & 0o777).toBe(0o600);
		expect((await log.read()).records.map(entry => entry.at)).toEqual([1_700_000_000_001, 1_700_000_000_002]);
	});

	/** A previous generation is secured even when the live append does not need to rotate it. */
	it("corrects a permissive owned rotated generation before appending", async () => {
		if (process.platform === "win32") return;
		const rotatedPath = `${logPath}${ROTATED_SUFFIX}`;
		await fs.writeFile(rotatedPath, encodeRecord(record(1)), { mode: 0o600 });
		await fs.chmod(rotatedPath, 0o644);
		const log = new SecretAuditLog(logPath);

		log.record(record(2));
		await log.flush();

		expect((await fs.stat(rotatedPath)).mode & 0o777).toBe(0o600);
		expect((await fs.stat(logPath)).mode & 0o777).toBe(0o600);
		expect((await log.read()).records.map(entry => entry.command)).toEqual(["run 1", "run 2"]);
	});

	/** A symlink is never followed, even when its target happens to be an owned regular file. */
	it("refuses a symlink and raises an operator error without changing its target", async () => {
		if (process.platform === "win32") return;
		const target = path.join(dir, "outside.jsonl");
		await fs.writeFile(target, "unchanged\n", { mode: 0o600 });
		await fs.symlink(target, logPath);
		const notices = new OperatorNotices();
		const log = new SecretAuditLog(logPath, notices);

		log.record(record(1));
		await log.flush();

		expect(await fs.readFile(target, "utf8")).toBe("unchanged\n");
		expect(notices.all()).toHaveLength(1);
		expect(notices.all()[0].severity).toBe("error");
		expect(notices.all()[0].text).toContain("not a regular file");
	});
});
	/** A hard link must not turn an unrelated owned inode into the audit append target. */
	it("refuses a multiply linked owned file without chmodding or appending to it", async () => {
		const unrelated = path.join(dir, "unrelated.txt");
		await fs.writeFile(unrelated, "unchanged\n", { mode: 0o600 });
		if (process.platform !== "win32") await fs.chmod(unrelated, 0o644);
		await fs.link(unrelated, logPath);
		const notices = new OperatorNotices();
		const log = new SecretAuditLog(logPath, notices);

		log.record(record(1));
		await log.flush();

		expect(await fs.readFile(unrelated, "utf8")).toBe("unchanged\n");
		if (process.platform !== "win32") expect((await fs.stat(unrelated)).mode & 0o777).toBe(0o644);
		expect(notices.all()[0]?.text).toContain("exactly one hard link");
	});


describe("malformed evidence", () => {
	/** Truncation metadata is security evidence too: zero, fractional, or unmarked counts are invalid. */
	it("counts malformed JSON and invalid omitted-placeholder metadata", () => {
		const good = JSON.stringify({
			at: 1,
			secrets: ["#TOKEN_A#"],
			tool: "bash",
			command: "x",
			truncated: true,
			omittedSecrets: 4,
		});
		const badZero = JSON.stringify({
			at: 2,
			secrets: ["#TOKEN_B#"],
			tool: "bash",
			command: "x",
			truncated: true,
			omittedSecrets: 0,
		});
		const badFraction = JSON.stringify({
			at: 3,
			secrets: ["#TOKEN_C#"],
			tool: "bash",
			command: "x",
			truncated: true,
			omittedSecrets: 1.5,
		});
		const badUnmarked = JSON.stringify({
			at: 4,
			secrets: ["#TOKEN_D#"],
			tool: "bash",
			command: "x",
			omittedSecrets: 2,
		});

		const decoded = decodeLog(`${good}\nnot json\n${badZero}\n${badFraction}\n${badUnmarked}\n`);
		expect(decoded.records).toHaveLength(1);
		expect(decoded.records[0].omittedSecrets).toBe(4);
		expect(decoded.malformed).toBe(4);
	});
});

describe("crash recovery and read bounds", () => {
	/**
	 * A crash or short write can leave a JSON fragment at EOF. The next complete record needs its
	 * own line or it is swallowed into the fragment and both pieces become one malformed record.
	 */
	it("separates the first post-crash record from an incomplete tail", async () => {
		await fs.writeFile(logPath, '{"at":1,"secrets":["#TOKEN_OLD#"]', { mode: 0o600 });
		const log = new SecretAuditLog(logPath);

		log.record(record(2, "survives the partial tail"));
		await log.flush();

		const result = await log.read();
		expect(result.records.map(entry => entry.command)).toEqual(["survives the partial tail"]);
		expect(result.malformed).toBe(1);
		expect(await fs.readFile(logPath, "utf8")).toContain(']\n{"at":');
	});

	/**
	 * `--limit` is applied after decoding, so the generation itself needs a hard byte ceiling before
	 * readFile allocates it. Writer-degraded or hand-edited oversized evidence must fail loudly.
	 */
	it("refuses to allocate and parse an oversized generation", async () => {
		await fs.writeFile(logPath, Buffer.alloc(ROTATE_AT_BYTES + 1, 0x20), { mode: 0o600 });
		const log = new SecretAuditLog(logPath);

		await expect(log.read({ limit: 1 })).rejects.toThrow(/above the .*read limit/);
	});
});

describe("loud rotation degradation", () => {
	/** Rotation failure is housekeeping failure: warn, retain the live file, and append the record. */
	it("keeps appending when the rotation target is non-regular", async () => {
		const appended = record(9, "landed after failed rotation");
		const line = encodeRecord(appended);
		await seedToSize(ROTATE_AT_BYTES - Buffer.byteLength(line) + 1);
		await fs.mkdir(`${logPath}${ROTATED_SUFFIX}`);
		const notices = new OperatorNotices();
		const log = new SecretAuditLog(logPath, notices);

		log.record(appended);
		await log.flush();

		const written = await fs.readFile(logPath, "utf8");
		expect(written.endsWith(line)).toBe(true);
		const warning = notices.all().find(notice => notice.severity === "warning");
		expect(warning?.text).toContain("could not be rotated");
		expect(warning?.text).toContain("still being recorded");
	});
});

describe("terminal-safe decoded evidence", () => {
	/**
	 * JSON escapes keep control bytes out of the JSONL syntax, but JSON.parse restores them. Every
	 * string read from evidence is made visible before `/secret log` hands it to a terminal.
	 */
	it("renders control bytes visibly instead of emitting terminal instructions", () => {
		const control = "\u001b[2J\u001b[H";
		const decoded = decodeLog(
			encodeRecord({
				at: 1,
				secrets: ["#TOKEN_SAFE#"],
				tool: `bash${control}spoofed`,
				session: `session${control}`,
				command: `command${control}`,
			}),
		);
		const displayPath = new SecretAuditLog(path.join(dir, `audit${control}.jsonl`)).path;
		const rendered = renderLog(decoded.records, { malformed: decoded.malformed, path: displayPath, now: 1 });

		expect(rendered).not.toContain("\u001b");
		expect(rendered).toContain("\\u001B[2J\\u001B[H");
	});
});

describe("ordinary queue semantics", () => {
	/** Flush resolves only after every prior append is readable, in record-call order. */
	it("appends, flushes, and reads ordinary records in order", async () => {
		const log = new SecretAuditLog(logPath);
		log.record(record(1));
		log.record(record(2));
		log.record(record(3));

		await log.flush();

		const text = await fs.readFile(logPath, "utf8");
		expect(text.endsWith("\n")).toBe(true);
		const result = await log.read();
		expect(result.malformed).toBe(0);
		expect(result.records.map(entry => entry.command)).toEqual(["run 1", "run 2", "run 3"]);
	});
});
