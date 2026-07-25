import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listSessions } from "@veyyon/coding-agent/session/session-listing";
import { FileSessionStorage } from "@veyyon/coding-agent/session/session-storage";
import { removeWithRetries } from "@veyyon/utils";
import { guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";

/**
 * SESS-2: a process killed mid-write must leave every committed message intact.
 *
 * This is the failure the user actually experiences, and the one a unit test
 * cannot honestly reproduce. Laptop sleeps, OOM killer fires, terminal closes,
 * `kill -9` — in every case the process gets no chance to finish. What must
 * survive is everything already flushed, and the file must still be READABLE:
 * a half-written trailing line that made the whole session unparseable would
 * lose the entire conversation to protect the last sentence of it.
 *
 * So the child here is really killed. `SIGKILL` cannot be caught, so no
 * shutdown hook, no `finally`, and no flush-on-exit runs. Writing the debris we
 * imagine a dead process leaves would test our guess about the crash rather than
 * the crash, which is the mistake that makes recovery suites reassuring and
 * useless.
 *
 * The child announces `committed <n>` after each flush, so the assertions can
 * name an exact number of messages that MUST be present, rather than settling
 * for "some survived".
 */
describe("a session survives its process being killed mid-write", () => {
	const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
	const CHILD = path.resolve(import.meta.dir, "..", "support", "session-append-until-killed.ts");
	const storage = new FileSessionStorage();

	let root = "";
	let cwd = "";
	let sessionDir = "";
	let agentDir = "";

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-session-kill-"));
		cwd = path.join(root, "project");
		sessionDir = path.join(root, "sessions");
		agentDir = path.join(root, "agent");
		for (const dir of [cwd, sessionDir, agentDir]) fs.mkdirSync(dir, { recursive: true });
	});

	afterEach(async () => {
		if (root) {
			await removeWithRetries(guardDestructivePath(root, "session-kill-mid-write"));
			root = "";
		}
	});

	/**
	 * Run the child until it reports `commitsBeforeKill` flushed messages, then
	 * SIGKILL it. Returns the session file and the number of commits the child
	 * had confirmed at the moment it died.
	 */
	async function killAfterCommits(commitsBeforeKill: number): Promise<{ file: string; committed: number }> {
		const proc = Bun.spawn(["bun", CHILD, cwd, sessionDir, agentDir], {
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});

		let file = "";
		let committed = 0;
		let buffered = "";
		const decoder = new TextDecoder();

		for await (const chunk of proc.stdout) {
			buffered += decoder.decode(chunk, { stream: true });
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				if (line.startsWith("file ")) file = line.slice("file ".length);
				else if (line.startsWith("committed ")) committed = Number.parseInt(line.slice("committed ".length), 10);
			}
			if (committed >= commitsBeforeKill) break;
		}

		proc.kill("SIGKILL");
		await proc.exited;

		// If the child never got going, every assertion below would be vacuous.
		expect(file).not.toBe("");
		expect(committed).toBeGreaterThanOrEqual(commitsBeforeKill);
		return { file, committed };
	}

	test("the killed process really was killed, not shut down cleanly", async () => {
		// The premise the whole suite rests on. If the child exited normally, this
		// would be an orderly-close test wearing a crash-test name, and it would pass
		// while proving nothing about recovery.
		const proc = Bun.spawn(["bun", CHILD, cwd, sessionDir, agentDir], {
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		for await (const chunk of proc.stdout) {
			if (new TextDecoder().decode(chunk).includes("committed")) break;
		}
		proc.kill("SIGKILL");

		const exitCode = await proc.exited;
		expect(exitCode).not.toBe(0);
		expect(proc.signalCode).toBe("SIGKILL");
	});

	test("every message committed before the kill is still on disk", async () => {
		// The core promise, asserted by CONTENT and by exact count. "The file still
		// exists" or "it has some lines" would both pass on a file that lost the
		// conversation.
		const { file, committed } = await killAfterCommits(4);

		const body = fs.readFileSync(file, "utf8");
		for (let i = 0; i <= committed; i++) {
			expect(body).toContain(`message ${i}`);
		}
	});

	test("the file is still parseable, so the whole session is not lost to its last line", async () => {
		// The failure mode that matters more than the missing tail: if a torn final
		// line made the file unreadable, a crash would cost the entire conversation
		// rather than the sentence being written.
		const { file, committed } = await killAfterCommits(4);

		const sessions = await listSessions(sessionDir, storage);
		const listed = sessions.find(session => session.path === file);

		expect(listed).toBeDefined();
		expect(listed?.messageCount).toBeGreaterThanOrEqual(committed);
	});

	test("the session lists normally afterwards, with no repair step required", async () => {
		// A user's next launch must simply show the session. Recovery that needs a
		// manual step is recovery the user does not get.
		await killAfterCommits(3);

		const sessions = await listSessions(sessionDir, storage);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.firstMessage).toContain("message 0");
	});

	test("no orphaned backup or temp file is left in the session directory", async () => {
		// A crash may legitimately leave a `.bak` behind, but listing runs the
		// orphan-recovery pass first, so by the time the user sees the directory it
		// must be clean. Debris that accumulates every crash eventually looks like
		// corruption to anyone who opens the folder.
		const { file } = await killAfterCommits(3);
		await listSessions(sessionDir, storage);

		const leftovers = fs.readdirSync(sessionDir).filter(name => !name.endsWith(".jsonl"));
		expect(leftovers).toEqual([]);
		expect(fs.existsSync(file)).toBe(true);
	});

	test("a second run after the crash appends rather than truncating the recovered file", async () => {
		// Recovery is only real if the session is USABLE afterwards. A file that
		// loads but is clobbered by the next write has not been recovered, it has
		// been postponed.
		const { file, committed } = await killAfterCommits(3);
		const before = fs.readFileSync(file, "utf8");

		const { file: secondFile } = await killAfterCommits(2);

		// The second run makes its own session; the first one's content is untouched.
		expect(secondFile).not.toBe(file);
		expect(fs.readFileSync(file, "utf8")).toBe(before);
		expect(fs.readFileSync(file, "utf8")).toContain(`message ${committed}`);
	});
});
