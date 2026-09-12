/**
 * WHY: `BranchSession` accepts an `entry` and the desktop never sent one, so
 * every branch the window cut forked at whatever the host picked -- the last
 * user message on the active branch -- however far back the operator had
 * scrolled. The desktop now names the entry it forks at
 * (`a-branch-forks-at-the-prompt-it-hands-back.rs`), and this drives the real
 * handler to prove the host forks where it was told and that the words the
 * desktop hands back to the composer are the words that fork removed.
 *
 * CLASS CLOSED: a branch that keeps a transcript other than the prefix ending
 * at the named entry. The members are every user entry on the branch, swept
 * from the session file at run time rather than listed here, so a transcript
 * of any depth is covered and a deeper one is covered as it is written: each
 * fork must keep exactly the entries before the one it names, must leave the
 * source file whole, and must land under a session id of its own. Beside them
 * the entries a desktop must never name -- an assistant reply, an id that is
 * on no branch, an empty string -- each of which the host refuses rather than
 * forking somewhere arbitrary.
 *
 * NOT CAUGHT: the desktop's own choice of entry, which is the Rust suite
 * above; the composer the returned prompt lands in, which the branch scene's
 * Before/After pair shows; and an extension cancelling the branch, which no
 * extension in this fixture registers for.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

/** The prompts the seeded session holds, oldest first. */
const PROMPTS = ["what does this crate do", "read the file first", "now change it"];

/** A session header as the host states it. */
interface ActiveSessionSection {
	revision: number;
	value: { id: string; title: string | null };
}

/** A transcript entry, read for the text an operator would recognise. */
interface TranscriptSection {
	value: Array<{ role: string; content: Array<{ Text?: { text: string } }> }>;
}

/** The text of every user entry in the last transcript `frames` carries. */
function promptsIn(frames: RequestFrame[]): string[] | undefined {
	const transcript = snapshotSections<TranscriptSection>(frames, "Transcript").at(-1);
	return transcript?.value
		.filter(entry => entry.role === "User")
		.flatMap(entry => entry.content.map(block => block.Text?.text ?? ""))
		.filter(text => text.length > 0);
}

/** The session id the last header in `frames` names. */
function activeIn(frames: RequestFrame[]): string | undefined {
	return snapshotSections<ActiveSessionSection>(frames, "ActiveSession").at(-1)?.value.id;
}

describe("a branch forks at the entry the desktop named", () => {
	let tempDir: string;
	let sessionDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	/** The seeded session's id. */
	let source: string;
	/** The entry id of each prompt in `PROMPTS`, in the same order. */
	let promptEntries: string[];
	/** The entry id of an assistant reply, which is no branch point. */
	let replyEntry: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-branch-entry-"));
		const storage = new FileSessionStorage();
		sessionDir = computeDefaultSessionDir(tempDir, storage, path.join(tempDir, "sessions"));
		const sm = SessionManager.create(tempDir, sessionDir, storage);
		promptEntries = [];
		replyEntry = "";
		for (const prompt of PROMPTS) {
			promptEntries.push(
				sm.appendMessage({ role: "user", content: [{ type: "text", text: prompt }], timestamp: 1_700_000_000_000 }),
			);
			replyEntry = sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `answering: ${prompt}` }],
				api: "openai-chat",
				provider: "openai",
				model: "gpt-4o-mini",
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 1_700_000_000_001,
			});
		}
		await sm.ensureOnDisk();
		await sm.flush();
		source = sm.getSessionId();
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir });
		client = await TestSocketClient.connect(server.endpoint);
		// Greeting and capabilities.
		await client.nextFrame();
		await client.nextFrame();
	});

	afterEach(async () => {
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** The prompts the file holding `session` records, oldest first. */
	async function promptsOnDisk(session: string): Promise<string[]> {
		for (const file of await fs.readdir(sessionDir)) {
			if (!file.endsWith(".jsonl")) continue;
			const opened = await SessionManager.open(path.join(sessionDir, file), undefined, undefined, {
				suppressBreadcrumb: true,
			});
			if (opened.getSessionId() !== session) continue;
			return opened
				.getBranch()
				.flatMap(entry => {
					if (entry.type !== "message") return [];
					const message = entry.message;
					if (message.role !== "user" || !Array.isArray(message.content)) return [];
					return message.content.map(block => (block.type === "text" ? block.text : ""));
				})
				.filter(text => text.length > 0);
		}
		throw new Error(`no session file in ${sessionDir} holds ${session}`);
	}

	test("a fork keeps the prompts before the entry it was told to cut at", async () => {
		// Every prompt on the branch is a branch point the desktop could name,
		// swept from the seeded file rather than listed, so the deepest one is
		// covered on the same terms as the first.
		let id = 10;
		for (const [index, entry] of promptEntries.entries()) {
			id += 1;
			const opened = await client.request(id, { OpenSession: { session: source } });
			expect(opened.outcome.RequestFailed).toBeUndefined();
			id += 1;
			const branched = await client.request(id, { BranchSession: { session: source, entry } });
			expect(branched.outcome.RequestFailed).toBeUndefined();

			const forked = activeIn(branched.frames);
			expect(forked).toBeDefined();
			expect(forked).not.toBe(source);
			expect(promptsIn(branched.frames)).toEqual(PROMPTS.slice(0, index));
			expect(await promptsOnDisk(forked as string)).toEqual(PROMPTS.slice(0, index));
			// The source is a file of its own and keeps every prompt, so a second
			// fork of the same session reads the same transcript this one did.
			expect(await promptsOnDisk(source)).toEqual(PROMPTS);
		}
	}, 20_000);

	test("a fork that names no entry cuts at the last prompt, which is the one the desktop names", async () => {
		const opened = await client.request(20, { OpenSession: { session: source } });
		expect(opened.outcome.RequestFailed).toBeUndefined();
		const branched = await client.request(21, { BranchSession: { session: source } });
		expect(branched.outcome.RequestFailed).toBeUndefined();

		expect(promptsIn(branched.frames)).toEqual(PROMPTS.slice(0, -1));
		expect(activeIn(branched.frames)).not.toBe(source);
	});

	test("an entry that is no prompt of the operator's forks nothing", async () => {
		const opened = await client.request(30, { OpenSession: { session: source } });
		expect(opened.outcome.RequestFailed).toBeUndefined();

		for (const [entry, code] of [
			[replyEntry, "BRANCH_SESSION_FAILED"],
			["no-such-entry", "BRANCH_SESSION_FAILED"],
			["   ", "INVALID_ARGUMENTS"],
		] as const) {
			const refused = await client.request(31, { BranchSession: { session: source, entry } });
			expect(refused.outcome.RequestFailed?.error.code).toBe(code);
			// A refusal leaves the operator on the session they were reading, with
			// the transcript a fork would have cut still whole.
			expect(await promptsOnDisk(source)).toEqual(PROMPTS);
		}
	}, 20_000);
});
