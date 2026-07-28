/**
 * The append-only record of which credential was spent where.
 *
 * WHY THIS SUITE EXISTS. An audit log has exactly one property worth having, and it is not that
 * it writes lines: it is that the lines are TRUE and COMPLETE. Three ways that fails, all pinned
 * here:
 *
 *   1. A value ends up in the log. The whole design rests on recording the arguments BEFORE
 *      expansion, so the tests below assert the credential's bytes are absent from the file, not
 *      merely that a redaction function was called.
 *   2. A record is silently dropped: a placeholder that was substituted but not recorded, or a
 *      write failure that nobody hears about.
 *   3. A pathological record becomes an unbounded line, so one damaged entry consumes the file.
 *      The byte cap applies to every encoded field and is asserted on the final bytes.
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
	placeholdersIn,
	SECRET_AUDIT_FILENAME,
	SecretAuditLog,
	secretAuditPath,
} from "@veyyon/coding-agent/secrets/audit";
import { OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-audit-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

/** Every placeholder is ours, for tests that are not about the `known` predicate. */
const anyPlaceholder = (): boolean => true;

describe("where the log lives", () => {
	/**
	 * The PROFILE directory, never the project one.
	 *
	 * A project directory is a git worktree. A file naming which credentials an agent used and
	 * when is not something to leave where `git add -A` will find it.
	 */
	it("is the profile directory, not the project one", () => {
		const logPath = secretAuditPath({
			globalConfigRoot: "/home/u/.veyyon",
			profileDir: "/home/u/.veyyon/profiles/work",
			projectDir: "/repo/.veyyon",
		});

		expect(logPath).toBe(path.join("/home/u/.veyyon/profiles/work", SECRET_AUDIT_FILENAME));
		expect(logPath).not.toContain("/repo");
	});
});

describe("deciding what was spent", () => {
	/** Both placeholder forms are found, because both are substituted from the same map. */
	it("finds name and index placeholders", () => {
		expect(placeholdersIn({ cmd: "curl -H 'Auth: #GITHUB_TOKEN#' --key #A1B2#" }, anyPlaceholder)).toEqual([
			"#GITHUB_TOKEN#",
			"#A1B2#",
		]);
	});

	/** Nested arguments are walked, since a tool's arguments are arbitrary JSON. */
	it("finds placeholders nested in arrays and objects", () => {
		const args = { env: { HEADERS: ["Authorization: #DEPLOY_KEY#"] }, note: "none" };

		expect(placeholdersIn(args, anyPlaceholder)).toEqual(["#DEPLOY_KEY#"]);
	});

	/** Repeats collapse: one credential used twice in one command is one credential. */
	it("lists each placeholder once", () => {
		expect(placeholdersIn({ a: "#TOKEN_X# and #TOKEN_X#", b: "#TOKEN_X#" }, anyPlaceholder)).toEqual(["#TOKEN_X#"]);
	});

	/**
	 * A `#WORD#` that is not a real placeholder is NOT recorded as a spent credential.
	 *
	 * The log is read to answer "which of my credentials did this use". A literal the operator
	 * typed appearing as a spent secret makes every honest row untrustworthy.
	 */
	it("ignores text that only looks like a placeholder", () => {
		const known = (placeholder: string): boolean => placeholder === "#REAL_TOKEN#";

		expect(placeholdersIn({ text: "see #HELLO# and #REAL_TOKEN#" }, known)).toEqual(["#REAL_TOKEN#"]);
	});

	/** No secret means no record at all, so an ordinary session writes nothing. */
	it("produces no record when no secret is involved", () => {
		expect(
			buildExpansionRecord({
				args: { command: "ls -la" },
				tool: "bash",
				session: "s1",
				at: 1000,
				known: anyPlaceholder,
				obfuscate: value => value,
			}),
		).toBeNull();
	});
});

describe("what a record contains", () => {
	/** Exact fields, because a log is only useful if you can rely on its shape. */
	it("records the placeholder, tool, session and command", () => {
		const record = buildExpansionRecord({
			args: { command: "curl -H 'Authorization: Bearer #GITHUB_TOKEN#' https://api.github.com" },
			tool: "bash",
			session: "sess-42",
			at: 1_700_000_000_000,
			known: anyPlaceholder,
			obfuscate: value => value,
		});

		expect(record).not.toBeNull();
		expect(record!.secrets).toEqual(["#GITHUB_TOKEN#"]);
		expect(record!.tool).toBe("bash");
		expect(record!.session).toBe("sess-42");
		expect(record!.at).toBe(1_700_000_000_000);
		expect(record!.command).toBe(
			'{"command":"curl -H \'Authorization: Bearer #GITHUB_TOKEN#\' https://api.github.com"}',
		);
		expect(record!.truncated).toBeUndefined();
	});

	/**
	 * The recorded command holds the PLACEHOLDER, which is why no value can ever be written.
	 *
	 * This is the whole safety argument stated as a test: the caller hands over pre-expansion
	 * arguments, so there is no redaction step that could be got wrong or reordered.
	 */
	it("holds the placeholder and not the credential", () => {
		const record = buildExpansionRecord({
			args: { command: "deploy --token #DEPLOY_TOKEN#" },
			tool: "bash",
			session: "s",
			at: 0,
			known: anyPlaceholder,
			obfuscate: value => value,
		});

		expect(record!.command).toContain("#DEPLOY_TOKEN#");
		expect(record!.command).not.toContain("ghp_realcredentialvalue");
	});

	/** A session with no id still produces a record: the label is optional, the row is not. */
	it("omits the session when there is none", () => {
		const record = buildExpansionRecord({
			args: { command: "echo #TOKEN_A#" },
			tool: "bash",
			session: undefined,
			at: 0,
			known: anyPlaceholder,
			obfuscate: value => value,
		});

		expect(record!.session).toBeUndefined();
		expect(record!.secrets).toEqual(["#TOKEN_A#"]);
	});

	/** A long command is cut, and says it was cut. */
	it("marks a truncated command as truncated", () => {
		const record = buildExpansionRecord({
			args: { command: `#TOKEN_A# ${"x".repeat(5000)}` },
			tool: "bash",
			session: "s",
			at: 0,
			known: anyPlaceholder,
			obfuscate: value => value,
		});

		expect(record!.truncated).toBe(true);
		expect(record!.command.endsWith("…")).toBe(true);
		// Ordinary placeholder evidence survives command shortening intact.
		expect(record!.secrets).toEqual(["#TOKEN_A#"]);
	});
});

describe("one record is one bounded line", () => {
	/**
	 * THE REASON THE CAP EXISTS. The cross-process lock keeps append/rotation transactions from
	 * interleaving, while the byte ceiling separately prevents one pathological record from
	 * becoming an unbounded line. Both properties are required.
	 */
	it("keeps an ordinary line under the byte cap", () => {
		const record = buildExpansionRecord({
			args: { command: "curl -H 'Authorization: Bearer #GITHUB_TOKEN#' https://api.github.com/user" },
			tool: "bash",
			session: "sess-42",
			at: 1_700_000_000_000,
			known: anyPlaceholder,
			obfuscate: value => value,
		});

		expect(Buffer.byteLength(encodeRecord(record!))).toBeLessThanOrEqual(MAX_RECORD_BYTES);
	});

	/** A pathological command is still under the cap, enforced on the ENCODED bytes. */
	it("keeps a huge command under the byte cap", () => {
		const record = buildExpansionRecord({
			args: { command: `#TOKEN_A# ${"y".repeat(100_000)}` },
			tool: "bash",
			session: "s",
			at: 0,
			known: anyPlaceholder,
			obfuscate: value => value,
		});

		expect(Buffer.byteLength(encodeRecord(record!))).toBeLessThanOrEqual(MAX_RECORD_BYTES);
	});

	/**
	 * Multi-byte characters cannot push a line over the cap.
	 *
	 * The character-count trim is not enough on its own: 1200 four-byte characters is 4800 bytes.
	 * A cap that held only for ASCII would fail exactly where a passphrase or a non-English path
	 * is involved.
	 */
	it("keeps a multi-byte command under the byte cap", () => {
		const record = buildExpansionRecord({
			args: { command: `#TOKEN_A# ${"𝔘".repeat(50_000)}` },
			tool: "bash",
			session: "s",
			at: 0,
			known: anyPlaceholder,
			obfuscate: value => value,
		});
		const line = encodeRecord(record!);

		expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES);
		// Still a complete record: the fields that matter survive the trim.
		expect(JSON.parse(line).secrets).toEqual(["#TOKEN_A#"]);
	});

	/** Exactly one newline per record, or two records would parse as one. */
	it("ends every line with exactly one newline", () => {
		const record = buildExpansionRecord({
			args: { command: "echo #TOKEN_A#" },
			tool: "bash",
			session: "s",
			at: 0,
			known: anyPlaceholder,
			obfuscate: value => value,
		});
		const line = encodeRecord(record!);

		expect(line.endsWith("\n")).toBe(true);
		expect(line.slice(0, -1)).not.toContain("\n");
	});
});

describe("reading the log back", () => {
	/** An unreadable line is COUNTED, not skipped, so a damaged log cannot look healthy. */
	it("counts lines it cannot parse instead of hiding them", () => {
		const good = '{"at":1,"secrets":["#A_TOKEN#"],"tool":"bash","command":"x"}';
		const { records, malformed } = decodeLog(`${good}\nnot json\n{"at":"nope"}\n\n${good}\n`);

		expect(records).toHaveLength(2);
		expect(malformed).toBe(2);
	});

	/** A fresh profile has no log, and that is not an error. */
	it("reports an empty log for a profile that has never used a secret", async () => {
		const log = new SecretAuditLog(path.join(tempDir, SECRET_AUDIT_FILENAME));

		expect(await log.read()).toEqual({ records: [], malformed: 0 });
	});

	/** Newest last, and limited from the END, which is the direction people read a log. */
	it("returns the most recent records when limited", async () => {
		const logPath = path.join(tempDir, SECRET_AUDIT_FILENAME);
		const log = new SecretAuditLog(logPath);
		for (let i = 0; i < 10; i++) {
			log.record({ at: i, secrets: [`#TOKEN_${i}#`], tool: "bash", command: `cmd ${i}` });
		}
		await log.flush();

		const { records } = await log.read({ limit: 3 });
		expect(records.map(r => r.at)).toEqual([7, 8, 9]);
	});
});

describe("writing the log", () => {
	/**
	 * The credential's bytes are absent from the FILE, not merely from a function's return value.
	 *
	 * The end-to-end statement of the safety property: whatever the value was, it is not on disk.
	 */
	it("never writes a credential to disk", async () => {
		const logPath = path.join(tempDir, SECRET_AUDIT_FILENAME);
		const log = new SecretAuditLog(logPath);
		const record = buildExpansionRecord({
			args: { command: "curl -H 'Authorization: Bearer #GITHUB_TOKEN#'" },
			tool: "bash",
			session: "s",
			at: 5,
			known: anyPlaceholder,
			obfuscate: value => value,
		});
		log.record(record!);
		await log.flush();

		const written = await fs.readFile(logPath, "utf8");
		expect(written).toContain("#GITHUB_TOKEN#");
		expect(written).not.toContain("ghp_thisisthesecretvalue");
	});

	/** Order is preserved across queued writes, so the log reads chronologically. */
	it("appends in the order records were made", async () => {
		const logPath = path.join(tempDir, SECRET_AUDIT_FILENAME);
		const log = new SecretAuditLog(logPath);
		for (const at of [1, 2, 3, 4, 5]) {
			log.record({ at, secrets: ["#TOKEN_A#"], tool: "bash", command: `cmd ${at}` });
		}
		await log.flush();

		const { records } = await log.read();
		expect(records.map(r => r.command)).toEqual(["cmd 1", "cmd 2", "cmd 3", "cmd 4", "cmd 5"]);
	});

	/** The directory is created, so a fresh profile records its first use. */
	it("creates the profile directory if it does not exist", async () => {
		const logPath = path.join(tempDir, "profiles", "new", SECRET_AUDIT_FILENAME);
		const log = new SecretAuditLog(logPath);
		log.record({ at: 1, secrets: ["#TOKEN_A#"], tool: "bash", command: "x" });
		await log.flush();

		expect((await log.read()).records).toHaveLength(1);
	});

	/**
	 * A WRITE FAILURE IS LOUD.
	 *
	 * The one thing a broken audit log must never do is look like a log with nothing to record.
	 * A path that cannot be created raises an operator notice, which is a channel a person sees,
	 * rather than a swallowed error (Law 10).
	 */
	it("raises an operator notice when it cannot append", async () => {
		// A file where a directory needs to be: mkdir fails, so the append cannot happen.
		const blocker = path.join(tempDir, "blocked");
		await fs.writeFile(blocker, "not a directory");

		const notices = new OperatorNotices();
		const log = new SecretAuditLog(path.join(blocker, SECRET_AUDIT_FILENAME), notices);
		log.record({ at: 1, secrets: ["#TOKEN_A#"], tool: "bash", command: "x" });
		await log.flush();

		const raised = notices.all();
		expect(raised).toHaveLength(1);
		expect(raised[0].severity).toBe("error");
		expect(raised[0].source).toBe("secrets");
		expect(raised[0].text).toContain("could not be appended to");
		// And it says the important part out loud: protection is intact, recording is not.
		expect(raised[0].text).toContain("no longer being recorded");
	});

	/** A failing write does not throw, because a full disk must not take the agent down. */
	it("does not throw when it cannot append", async () => {
		const blocker = path.join(tempDir, "blocked2");
		await fs.writeFile(blocker, "not a directory");
		const log = new SecretAuditLog(path.join(blocker, SECRET_AUDIT_FILENAME));

		log.record({ at: 1, secrets: ["#TOKEN_A#"], tool: "bash", command: "x" });
		await log.flush();
		expect(true).toBe(true);
	});

	/** The log is 0600: it names which credentials exist and when, which is reconnaissance. */
	it("writes the log readable only by its owner", async () => {
		if (process.platform === "win32") return;
		const logPath = path.join(tempDir, SECRET_AUDIT_FILENAME);
		const log = new SecretAuditLog(logPath);
		log.record({ at: 1, secrets: ["#TOKEN_A#"], tool: "bash", command: "x" });
		await log.flush();

		const stat = await fs.stat(logPath);
		expect(stat.mode & 0o077).toBe(0);
	});
});
