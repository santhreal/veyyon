/**
 * Third-pass audit boundary contract: arbitrary pre-expansion JavaScript becomes a bounded inert
 * snapshot, and filesystem evidence never crosses an identity or durability barrier silently.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildExpansionRecord,
	decodeLog,
	encodeRecord,
	MAX_RECORD_BYTES,
	ROTATE_AT_BYTES,
	placeholdersIn,
	SECRET_AUDIT_FILENAME,
	SecretAuditLog,
	type SecretExpansionRecord,
} from "@veyyon/coding-agent/secrets/audit";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";

const PLACEHOLDER = "#TOKEN_A#";
const RAW_SECRET = "audit_raw_credential_7F2A";
let dir: string;
let logPath: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-audit-third-pass-"));
	logPath = path.join(dir, SECRET_AUDIT_FILENAME);
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

function auditOptions(args: Record<string, unknown>) {
	return {
		args,
		tool: `tool-${RAW_SECRET}`,
		session: `session-${RAW_SECRET}`,
		at: 1,
		known: (value: string) => value === PLACEHOLDER,
		obfuscate: (value: string) => value.replaceAll(RAW_SECRET, "#RAW_SECRET#"),
	};
}

function record(index: number): SecretExpansionRecord {
	return { at: index, secrets: [PLACEHOLDER], tool: "bash", command: `run ${index}` };
}

describe("bounded inert pre-expansion snapshots", () => {
	/** One unsanitized label, key, or getter result would put a configured credential in JSONL. */
	it("obfuscates raw keys, getter values, tool, and session without invoking toJSON", () => {
		let getterReads = 0;
		let toJsonCalls = 0;
		const args = {
			[RAW_SECRET]: "ordinary",
			get credential() {
				getterReads++;
				return `${RAW_SECRET} ${PLACEHOLDER}`;
			},
			toJSON() {
				toJsonCalls++;
				throw new Error("must not run");
			},
		};

		const expansion = buildExpansionRecord(auditOptions(args));
		const encoded = encodeRecord(expansion!);

		expect(getterReads).toBe(1);
		expect(toJsonCalls).toBe(0);
		expect(encoded).not.toContain(RAW_SECRET);
		expect(expansion?.command).toContain("#RAW_SECRET#");
		expect(expansion?.tool).toBe("tool-#RAW_SECRET#");
		expect(expansion?.session).toBe("session-#RAW_SECRET#");
	});

	/** Shared global regex state must not let reentrant predicates skip later placeholders. */
	it("keeps a streaming placeholder scan stable across a reentrant known predicate", () => {
		const second = "#TOKEN_B#";
		let reentered = false;
		const found = placeholdersIn(`${PLACEHOLDER} ${second}`, candidate => {
			if (!reentered) {
				reentered = true;
				expect(placeholdersIn("#TOKEN_C#", () => true)).toEqual(["#TOKEN_C#"]);
			}
			return candidate === PLACEHOLDER || candidate === second;
		});

		expect(found).toEqual([PLACEHOLDER, second]);
	});

	/** Cycles are ordinary evidence loss; proxy traps are unknowable evidence and therefore fail closed. */
	it("handles cycles and materializing proxies, but fails closed on hostile traps without leaking trap text", () => {
		const cyclic: Record<string, unknown> = { command: PLACEHOLDER };
		cyclic.self = cyclic;
		const cycleRecord = buildExpansionRecord(auditOptions(cyclic));
		expect(cycleRecord?.command).toContain("circular reference");

		const materialized = new Proxy(
			{ command: PLACEHOLDER, raw: RAW_SECRET },
			{
				ownKeys: target => Reflect.ownKeys(target),
				getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(target, key),
				get: (target, key, receiver) => Reflect.get(target, key, receiver),
			},
		);
		expect(encodeRecord(buildExpansionRecord(auditOptions(materialized))!)).not.toContain(RAW_SECRET);

		const hostile = new Proxy({}, { ownKeys: () => { throw new Error(RAW_SECRET); } });
		let failure = "";
		try {
			buildExpansionRecord(auditOptions({ command: PLACEHOLDER, hostile }));
		} catch (error) {
			failure = String(error);
		}
		expect(failure).toContain("Refusing secret expansion");
		expect(failure).not.toContain(RAW_SECRET);
	});

	/** Exact work limits distinguish a bounded omission from an unbounded pre-expansion scan. */
	it("enforces depth and exact large-string scan boundaries before expansion", () => {
		const exactlyAtStringCap = `${PLACEHOLDER}${"x".repeat(256 * 1024 - PLACEHOLDER.length)}`;
		const boundary = buildExpansionRecord(auditOptions({ command: exactlyAtStringCap }));
		expect(boundary?.truncated).toBe(true);
		expect(boundary?.command).not.toContain("x".repeat(100));
		expect(() =>
			buildExpansionRecord(auditOptions({ command: `${exactlyAtStringCap}x` })),
		).toThrow(/string exceeds the byte limit/);

		let deep: Record<string, unknown> = { command: PLACEHOLDER };
		for (let depth = 0; depth < 30; depth++) deep = { nested: deep };
		expect(() => buildExpansionRecord(auditOptions(deep))).toThrow(/depth limit/);
	});

	/** A sanitizer outage must retain only fixed credential-free evidence, never fall back to raw text. */
	it("keeps a credential-free fallback when protection itself fails", () => {
		const expansion = buildExpansionRecord({
			...auditOptions({ command: `${RAW_SECRET} ${PLACEHOLDER}` }),
			obfuscate: () => { throw new Error(RAW_SECRET); },
		});
		const encoded = encodeRecord(expansion!);

		expect(encoded).not.toContain(RAW_SECRET);
		expect(expansion?.command).toContain("protected string unavailable");
		expect(expansion?.tool).toBe("[metadata unavailable]");
	});
});

describe("untrusted decode bounds and terminal visibility", () => {
	/** JSON decoding restores terminal controls, so the read boundary must inert every hostile category. */
	it("escapes C0/C1/DEL, format controls, separators, astral formats, and lone surrogates after decode", () => {
		const hostile = "\u0000\u001b\u007f\u0085\u00ad\u202e\u2066\u2028\u2029\u{E0001}\ud800X\udc00";
		const decoded = decodeLog(encodeRecord({ ...record(1), tool: hostile, command: hostile }));
		const rendered = `${decoded.records[0].tool}${decoded.records[0].command}`;

		expect(rendered).not.toContain("\u001b");
		expect(rendered).not.toMatch(/\p{Cf}/u);
		expect(rendered).toContain("\\u202E");
		expect(rendered).toContain("\\u{E0001}");
		expect(rendered).toContain("\\uD800X\\uDC00");
	});

	/** Malformed logs otherwise amplify split, regex, allocation, and JSON parse work before rendering. */
	it("caps overlong lines, line-count floods, and total malformed input before parse amplification", () => {
		expect(decodeLog(`${"x".repeat(MAX_RECORD_BYTES + 1)}\n`)).toEqual({ records: [], malformed: 1 });
		expect(() => decodeLog("x\n".repeat(32_769))).toThrow(/line decode limit/);
		expect(() => decodeLog(" ".repeat(ROTATE_AT_BYTES + 1))).toThrow(/byte decode limit/);
	});
});

describe("bounded queue and pinned filesystem identities", () => {
	/** A synchronous capacity boundary prevents both unbounded retention and one lock wait per flood item. */
	it("fails closed before expansion when the retained queue reaches its exact record boundary", async () => {
		const notices = new OperatorNotices();
		const log = new SecretAuditLog(logPath, notices);
		for (let index = 0; index < 128; index++) log.record(record(index));

		for (let index = 0; index < 10; index++) {
			expect(() => log.record(record(128 + index))).toThrow(/queue is full/);
		}
		expect(notices.all().filter(notice => notice.text.includes("expansion was refused"))).toHaveLength(1);
		await log.flush();
		expect((await log.read()).records).toHaveLength(128);
	});

	/** A symlinked profile parent could redirect evidence and terminal controls could conceal the refusal. */
	it("refuses a symlinked parent and emits no raw terminal controls", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-audit-outside-"));
		const link = path.join(dir, "parent\u001b\u202E");
		await fs.symlink(outside, link, "dir");
		const notices = new OperatorNotices();
		const log = new SecretAuditLog(path.join(link, SECRET_AUDIT_FILENAME), notices);
		try {
			log.record(record(1));
			await log.flush();
			expect(await fs.readdir(outside)).toEqual([]);
			const notice = notices.all()[0]?.text ?? "";
			expect(notice).not.toContain("\u001b");
			expect(notice).not.toMatch(/\p{Cf}/u);
			expect(notice).toContain("\\u001B");
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	/** Swapping the pathname after fstat must neither chmod nor append to either substituted inode. */
	it("detects a pathname inode swap before descriptor chmod or append", async () => {
		const moved = path.join(dir, "original.jsonl");
		await fs.writeFile(logPath, encodeRecord(record(0)), { mode: 0o600 });
		if (process.platform !== "win32") await fs.chmod(logPath, 0o644);
		const originalStats = await fs.stat(logPath);
		const probe = await fs.open(logPath, fsConstants.O_RDONLY);
		const prototype = Object.getPrototypeOf(probe) as { stat: () => Promise<Stats> };
		await probe.close();
		const originalStat = prototype.stat;
		let swapped = false;
		prototype.stat = async function (this: FileHandle): Promise<Stats> {
			const stats = await originalStat.call(this);
			if (!swapped && stats.dev === originalStats.dev && stats.ino === originalStats.ino) {
				swapped = true;
				await fs.rename(logPath, moved);
				await fs.writeFile(logPath, "replacement\n", { mode: 0o600 });
			}
			return stats;
		};
		try {
			const notices = new OperatorNotices();
			const log = new SecretAuditLog(logPath, notices);
			log.record(record(1));
			await log.flush();

			expect(await fs.readFile(moved, "utf8")).toBe(encodeRecord(record(0)));
			expect(await fs.readFile(logPath, "utf8")).toBe("replacement\n");
			if (process.platform !== "win32") expect((await fs.stat(moved)).mode & 0o777).toBe(0o644);
			expect(notices.all()[0]?.text).toContain("replaced");
		} finally {
			prototype.stat = originalStat;
		}
	});

	/** A cap-sized positional read must detect bytes appended after the initial descriptor stat. */
	it("rejects a generation that grows after its first positional read", async () => {
		await fs.writeFile(logPath, encodeRecord(record(0)), { mode: 0o600 });
		const originalStats = await fs.stat(logPath);
		const probe = await fs.open(logPath, fsConstants.O_RDONLY);
		const prototype = Object.getPrototypeOf(probe) as {
			read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
			stat: () => Promise<Stats>;
		};
		await probe.close();
		const originalRead = prototype.read;
		const originalStat = prototype.stat;
		let grown = false;
		prototype.read = async function (this: FileHandle, buffer, offset, length, position) {
			const result = await originalRead.call(this, buffer, offset, length, position);
			const stats = await originalStat.call(this);
			if (!grown && stats.dev === originalStats.dev && stats.ino === originalStats.ino) {
				grown = true;
				await fs.appendFile(logPath, " ");
			}
			return result;
		};
		try {
			await expect(new SecretAuditLog(logPath).read()).rejects.toThrow(/changed or grew/);
		} finally {
			prototype.read = originalRead;
		}
	});

	/** Crash consistency requires record data durability before acknowledging its created directory entry. */
	it("orders appended data before datasync and the created namespace before parent fsync", async () => {
		const probe = await fs.open(path.join(dir, "probe"), fsConstants.O_CREAT | fsConstants.O_RDWR, 0o600);
		const prototype = Object.getPrototypeOf(probe) as {
			write: (buffer: Uint8Array, offset?: number, length?: number, position?: number | null) => Promise<unknown>;
			datasync: () => Promise<void>;
			sync: () => Promise<void>;
		};
		await probe.close();
		await fs.rm(path.join(dir, "probe"));
		const originalWrite = prototype.write;
		const originalDatasync = prototype.datasync;
		const originalSync = prototype.sync;
		const events: string[] = [];
		prototype.write = async function (this: FileHandle, ...args) {
			events.push("write");
			return await originalWrite.apply(this, args);
		};
		prototype.datasync = async function (this: FileHandle) {
			events.push("datasync");
			return await originalDatasync.call(this);
		};
		prototype.sync = async function (this: FileHandle) {
			events.push("sync");
			return await originalSync.call(this);
		};
		try {
			const log = new SecretAuditLog(logPath);
			log.record(record(1));
			await log.flush();
			const dataBarrier = events.lastIndexOf("datasync");
			expect(events.lastIndexOf("write", dataBarrier)).toBeGreaterThanOrEqual(0);
			expect(events.indexOf("sync", dataBarrier + 1)).toBeGreaterThan(dataBarrier);
		} finally {
			prototype.write = originalWrite;
			prototype.datasync = originalDatasync;
			prototype.sync = originalSync;
		}
	});
});
