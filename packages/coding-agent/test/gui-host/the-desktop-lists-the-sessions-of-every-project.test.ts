/**
 * WHY: the desktop sidebar groups threads by project, so the `Sessions`
 * section must list the sessions of every project directory of the profile,
 * not only the directory of the workspace the host started in. The defect this
 * closes is a listing scoped to the host's cwd: a thread from another project
 * vanishes from the window although `/resume --all` in the terminal finds it.
 *
 * Covered: sessions of two projects both listed, each with its own cwd, newest
 * first across projects.
 * Not caught: the order of two sessions with an identical modification time.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { type RequestFrame, TestSocketClient } from "./test-client";

interface Row {
	id: string;
	cwd: string;
}

let root: string;
let server: GuiHostServer | null = null;
let client: TestSocketClient | null = null;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-every-project-"));
});

afterEach(async () => {
	client?.destroy();
	client = null;
	await server?.close();
	server = null;
	await fs.rm(root, { recursive: true, force: true });
});

async function sessionIn(cwd: string, modifiedSeconds: number): Promise<string> {
	await fs.mkdir(cwd, { recursive: true });
	const storage = new FileSessionStorage();
	const dir = computeDefaultSessionDir(cwd, storage, path.join(root, "sessions"));
	const sm = SessionManager.create(cwd, dir, storage);
	sm.appendMessage({ role: "user", content: [{ type: "text", text: `work in ${cwd}` }], timestamp: Date.now() });
	// A session reaches disk with its first reply, not with the prompt alone.
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "done" }],
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
		timestamp: Date.now(),
	});
	await sm.flush();
	const file = sm.getSessionFile();
	if (!file) throw new Error("a file-backed session has a path");
	await fs.utimes(file, modifiedSeconds, modifiedSeconds);
	return sm.getSessionId();
}

function rows(frames: RequestFrame[]): Row[] {
	for (const frame of frames) {
		const sessions = frame.Snapshot?.Sessions as [{ value: Row[] }, unknown[]] | undefined;
		if (sessions) return sessions[0].value;
	}
	throw new Error("no Sessions snapshot in the reply");
}

test("the session list covers every project of the profile, newest first", async () => {
	const alpha = path.join(root, "alpha");
	const beta = path.join(root, "beta");
	const olderAlpha = await sessionIn(alpha, 1_700_000_000);
	const newestBeta = await sessionIn(beta, 1_700_000_300);
	const newerAlpha = await sessionIn(alpha, 1_700_000_200);

	server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: alpha, agentDir: root });
	client = await TestSocketClient.connect(server.endpoint);
	await client.nextFrame();
	await client.nextFrame();

	const listed = await client.request(1, "ListSessions");
	expect(rows(listed.frames).map(row => [row.id, row.cwd])).toEqual([
		[newestBeta, beta],
		[newerAlpha, alpha],
		[olderAlpha, alpha],
	]);
});
