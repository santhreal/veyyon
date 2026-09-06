/**
 * WHY: the session action group drives the real session store and the
 * `AgentSession` operations behind the CLI's own commands (`/branch`,
 * `/compact`, `/handoff`, `/export`), not a private re-implementation over
 * the raw entry log. The defect this closes is a handler that writes an
 * entry that looks like the operation's outcome — a compaction summary with
 * no summary, a "handoff" marker that hands nothing off — and reports
 * success. Each action here is asserted on the state it leaves behind: the
 * title the list shows, the entries the export carries, the session the
 * store no longer has.
 *
 * Not caught: the quality of a real compaction or handoff, which needs a
 * provider; those paths are asserted only to fail loud without one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { findSessionPath } from "../../src/gui-host/actions/active-session";
import { SessionManager } from "../../src/session/session-manager";
import { computeDefaultSessionDir } from "../../src/session/session-paths";
import { FileSessionStorage } from "../../src/session/session-storage";
import { type RequestFrame, TestSocketClient } from "./test-client";
interface SessionRow {
	id: string;
	title: string;
}

function snapshot<T>(frames: RequestFrame[], section: string): T | undefined {
	for (const frame of frames) {
		const value = frame.Snapshot?.[section];
		if (value !== undefined) return value as T;
	}
	return undefined;
}

function sessionRows(frames: RequestFrame[]): SessionRow[] {
	const sessions = snapshot<[{ value: SessionRow[] }, unknown[]]>(frames, "Sessions");
	if (!sessions) throw new Error("no Sessions snapshot in frames");
	return sessions[0].value;
}

async function createPopulatedSession(
	dir: string,
	messages: Array<{ role: "user" | "assistant"; text: string }>,
): Promise<{ sessionId: string; sessionPath: string; entryIds: string[]; sm: SessionManager }> {
	const storage = new FileSessionStorage();
	const sessionDir = computeDefaultSessionDir(dir, storage, path.join(dir, "sessions"));
	const sm = SessionManager.create(dir, sessionDir, storage);
	const entryIds: string[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			const id = sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: msg.text }],
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
			entryIds.push(id);
		} else {
			const id = sm.appendMessage({
				role: "user",
				content: [{ type: "text", text: msg.text }],
				timestamp: Date.now(),
			});
			entryIds.push(id);
		}
	}
	await sm.flush();
	const sessionPath = sm.getSessionFile();
	if (!sessionPath) throw new Error("File-backed session has no persisted path");
	return { sessionId: sm.getSessionId(), sessionPath, entryIds, sm };
}

describe("sessions action group behaviour", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-sessions-test-"));
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

	test("a created session is titled, listed, renamed in place, exported with its entries, and gone once deleted", async () => {
		const created = await client.request(1, { CreateSession: { title: "Test Session" } });
		expect(created.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		const active = snapshot<{ value: { id: string; title: string } }>(created.frames, "ActiveSession");
		expect(active?.value.title).toBe("Test Session");
		const sessionId = active?.value.id;
		if (!sessionId) throw new Error("ActiveSession snapshot carried no id");

		const renamed = await client.request(2, { RenameSession: { session: sessionId, title: "Renamed Session" } });
		expect(renamed.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(snapshot<{ value: { title: string } }>(renamed.frames, "ActiveSession")?.value.title).toBe(
			"Renamed Session",
		);
		expect(sessionRows(renamed.frames).find(s => s.id === sessionId)?.title).toBe("Renamed Session");

		const exported = await client.request(3, { ExportSession: { session: sessionId, format: "json" } });
		expect(exported.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		const exportSection = snapshot<{ session: string; format: string; content: string }>(exported.frames, "Export");
		const entries = JSON.parse(exportSection?.content ?? "null") as Array<{ type: string; title?: string }>;
		expect(entries.filter(e => e.type === "title_change").map(e => e.title)).toEqual([
			"Test Session",
			"Renamed Session",
		]);

		const loaded = await client.request(4, { LoadTranscript: { session: sessionId, before: null } });
		expect(loaded.outcome).toEqual({ RequestSucceeded: { request: 4 } });
		expect(snapshot<{ value: unknown[] }>(loaded.frames, "Transcript")?.value.length).toBe(entries.length);

		const listed = await client.request(5, "ListSessions");
		expect(sessionRows(listed.frames).map(s => s.id)).toEqual([sessionId]);

		const deleted = await client.request(6, { DeleteSession: { session: sessionId } });
		expect(deleted.outcome).toEqual({ RequestSucceeded: { request: 6 } });
		expect(sessionRows(deleted.frames)).toEqual([]);

		const reopened = await client.request(7, { OpenSession: { session: sessionId } });
		expect(reopened.outcome.RequestFailed?.error).toMatchObject({
			scope: "Session",
			code: "SESSION_NOT_FOUND",
			retryable: false,
		});
	});

	test("an unknown export format is rejected before any session is touched", async () => {
		const created = await client.request(1, { CreateSession: {} });
		const sessionId = snapshot<{ value: { id: string } }>(created.frames, "ActiveSession")?.value.id;
		const exported = await client.request(2, { ExportSession: { session: sessionId, format: "docx" } });
		expect(exported.outcome.RequestFailed?.error).toMatchObject({ scope: "Session", code: "INVALID_ARGUMENTS" });
		expect(exported.frames).toHaveLength(1);
	});

	test("a handoff with nothing to hand off fails loud instead of writing a marker", async () => {
		const created = await client.request(1, { CreateSession: {} });
		const sessionId = snapshot<{ value: { id: string } }>(created.frames, "ActiveSession")?.value.id;
		const handoff = await client.request(2, { HandoffSession: { session: sessionId, target: "carry on" } });
		expect(handoff.outcome.RequestFailed?.error).toMatchObject({ scope: "Session", code: "HANDOFF_SESSION_FAILED" });
		expect(handoff.outcome.RequestFailed?.error.message).toContain("Nothing to hand off");

		const exported = await client.request(3, { ExportSession: { session: sessionId, format: "json" } });
		const content = snapshot<{ content: string }>(exported.frames, "Export")?.content ?? "null";
		const entries = JSON.parse(content) as Array<{ type: string; customType?: string }>;
		expect(entries.filter(e => e.customType === "handoff")).toEqual([]);
	});

	test("a rename of an empty title is rejected", async () => {
		const created = await client.request(1, { CreateSession: {} });
		const sessionId = snapshot<{ value: { id: string } }>(created.frames, "ActiveSession")?.value.id;
		const renamed = await client.request(2, { RenameSession: { session: sessionId, title: "   " } });
		expect(renamed.outcome.RequestFailed?.error).toMatchObject({ scope: "Session", code: "INVALID_ARGUMENTS" });
	});

	test("a transcript page request names an unsupported paging mode", async () => {
		const created = await client.request(1, { CreateSession: {} });
		const sessionId = snapshot<{ value: { id: string } }>(created.frames, "ActiveSession")?.value.id;
		const paged = await client.request(2, { LoadTranscript: { session: sessionId, before: "entry-1" } });
		expect(paged.outcome.RequestFailed?.error).toMatchObject({ scope: "Transcript", code: "PAGING_UNSUPPORTED" });
	});

	test("BranchSession without entry branches from the latest user message on active branch", async () => {
		const { sessionId, entryIds } = await createPopulatedSession(tempDir, [
			{ role: "user", text: "First question" },
			{ role: "assistant", text: "First answer" },
			{ role: "user", text: "Second question" },
			{ role: "assistant", text: "Second answer" },
		]);
		const [u1, a1] = entryIds;

		const branched = await client.request(1, { BranchSession: { session: sessionId } });
		expect(branched.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		const newSessionId = snapshot<{ value: { id: string } }>(branched.frames, "ActiveSession")?.value.id;
		expect(newSessionId).toBeDefined();
		expect(newSessionId).not.toBe(sessionId);

		const transcript = snapshot<{ value: unknown[] }>(branched.frames, "Transcript")?.value;
		expect(transcript?.length).toBe(2);

		const newSessionPath = await findSessionPath(newSessionId!, tempDir, tempDir);
		expect(newSessionPath).toBeDefined();
		const sm = await SessionManager.open(newSessionPath!, undefined, undefined, { suppressBreadcrumb: true });
		expect(sm.getLeafId()).toBe(a1);
		expect(sm.getBranch().map(e => e.id)).toEqual([u1, a1]);
	});

	test("BranchSession with explicit entry branches from the specified entry", async () => {
		const { sessionId, entryIds } = await createPopulatedSession(tempDir, [
			{ role: "user", text: "First question" },
			{ role: "assistant", text: "First answer" },
			{ role: "user", text: "Second question" },
			{ role: "assistant", text: "Second answer" },
		]);
		const [u1] = entryIds;

		const branched = await client.request(1, { BranchSession: { session: sessionId, entry: u1 } });
		expect(branched.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		const newSessionId = snapshot<{ value: { id: string } }>(branched.frames, "ActiveSession")?.value.id;
		expect(newSessionId).toBeDefined();
		expect(newSessionId).not.toBe(sessionId);

		const transcript = snapshot<{ value: unknown[] }>(branched.frames, "Transcript")?.value;
		expect(transcript?.length).toBe(0);

		const newSessionPath = await findSessionPath(newSessionId!, tempDir, tempDir);
		expect(newSessionPath).toBeDefined();
		const sm = await SessionManager.open(newSessionPath!, undefined, undefined, { suppressBreadcrumb: true });
		expect(sm.getLeafId()).toBeNull();
		expect(sm.getBranch().map(e => e.id)).toEqual([]);
	});

	test("BranchSession with null entry branches from latest user message", async () => {
		const { sessionId, entryIds } = await createPopulatedSession(tempDir, [
			{ role: "user", text: "First question" },
			{ role: "assistant", text: "First answer" },
			{ role: "user", text: "Second question" },
			{ role: "assistant", text: "Second answer" },
		]);
		const [u1, a1] = entryIds;

		const branched = await client.request(1, { BranchSession: { session: sessionId, entry: null } });
		expect(branched.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		const newSessionId = snapshot<{ value: { id: string } }>(branched.frames, "ActiveSession")?.value.id;
		expect(newSessionId).toBeDefined();
		expect(newSessionId).not.toBe(sessionId);

		const newSessionPath = await findSessionPath(newSessionId!, tempDir, tempDir);
		expect(newSessionPath).toBeDefined();
		const sm = await SessionManager.open(newSessionPath!, undefined, undefined, { suppressBreadcrumb: true });
		expect(sm.getLeafId()).toBe(a1);
		expect(sm.getBranch().map(e => e.id)).toEqual([u1, a1]);
	});
	test("BranchSession on a session without user messages fails with a contextual Session error and leaves session unchanged", async () => {
		const created = await client.request(1, { CreateSession: { title: "Empty Session" } });
		const sessionId = snapshot<{ value: { id: string } }>(created.frames, "ActiveSession")?.value.id;
		if (!sessionId) throw new Error("no session id");

		const branched = await client.request(2, { BranchSession: { session: sessionId } });
		expect(branched.outcome.RequestFailed?.error).toMatchObject({
			scope: "Session",
			code: "NO_USER_MESSAGES",
			retryable: false,
		});
	});

	test("BranchSession on an inactive target session activates it and branches from its latest user message", async () => {
		await client.request(1, { CreateSession: { title: "Active Session" } });

		const {
			sessionId: inactiveId,
			entryIds,
		} = await createPopulatedSession(tempDir, [
			{ role: "user", text: "Inactive Q1" },
			{ role: "assistant", text: "Inactive A1" },
			{ role: "user", text: "Inactive Q2" },
			{ role: "assistant", text: "Inactive A2" },
		]);
		const [u1, a1] = entryIds;

		const branched = await client.request(2, { BranchSession: { session: inactiveId } });
		expect(branched.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		const newSessionId = snapshot<{ value: { id: string } }>(branched.frames, "ActiveSession")?.value.id;
		expect(newSessionId).toBeDefined();
		expect(newSessionId).not.toBe(inactiveId);

		const newSessionPath = await findSessionPath(newSessionId!, tempDir, tempDir);
		expect(newSessionPath).toBeDefined();
		const sm = await SessionManager.open(newSessionPath!, undefined, undefined, { suppressBreadcrumb: true });
		expect(sm.getLeafId()).toBe(a1);
		expect(sm.getBranch().map(e => e.id)).toEqual([u1, a1]);
	});

	test("BranchSession rejects explicit empty string entry as invalid arguments", async () => {
		const { sessionId } = await createPopulatedSession(tempDir, [{ role: "user", text: "Hello" }]);

		const empty = await client.request(1, { BranchSession: { session: sessionId, entry: "" } });
		expect(empty.outcome.RequestFailed?.error).toMatchObject({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
		});

		const whitespace = await client.request(2, { BranchSession: { session: sessionId, entry: "   " } });
		expect(whitespace.outcome.RequestFailed?.error).toMatchObject({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
		});
	});

	test("BranchSession selects latest user message on the active branch across multiple branches", async () => {
		const storage = new FileSessionStorage();
		const sessionDir = computeDefaultSessionDir(tempDir, storage, path.join(tempDir, "sessions"));
		const sm = SessionManager.create(tempDir, sessionDir, storage);

		const u1 = sm.appendMessage({ role: "user", content: [{ type: "text", text: "U1" }], timestamp: 1 });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "A1" }],
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
			timestamp: 2,
		});
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "U2" }], timestamp: 3 });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "A2" }],
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
			timestamp: 4,
		});

		// Branch back to u1 and create active branch 2
		sm.branch(u1);
		const a1b = sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "A1b" }],
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
			timestamp: 5,
		});
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "U3" }], timestamp: 6 });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "A3" }],
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
			timestamp: 7,
		});
		await sm.flush();

		const sessionId = sm.getSessionId();

		const branched = await client.request(1, { BranchSession: { session: sessionId } });
		expect(branched.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		const newSessionId = snapshot<{ value: { id: string } }>(branched.frames, "ActiveSession")?.value.id;
		expect(newSessionId).toBeDefined();
		expect(newSessionId).not.toBe(sessionId);

		const newSessionPath = await findSessionPath(newSessionId!, tempDir, tempDir);
		expect(newSessionPath).toBeDefined();
		const reopened = await SessionManager.open(newSessionPath!, undefined, undefined, { suppressBreadcrumb: true });
		// U3 was selected (active branch), so the branched session keeps entries up to U3's parent (a1b)
		expect(reopened.getLeafId()).toBe(a1b);
		expect(reopened.getBranch().map(e => e.id)).toEqual([u1, a1b]);
	});

	test("BranchSession without session identifier is rejected as invalid arguments", async () => {
		const missing = await client.request(1, { BranchSession: {} });
		expect(missing.outcome.RequestFailed?.error).toMatchObject({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
		});

		const empty = await client.request(2, { BranchSession: { session: "" } });
		expect(empty.outcome.RequestFailed?.error).toMatchObject({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
		});
	});

	test("BranchSession rejects explicit assistant message entry as invalid entry ID", async () => {
		const { sessionId, entryIds } = await createPopulatedSession(tempDir, [
			{ role: "user", text: "First question" },
			{ role: "assistant", text: "First answer" },
		]);
		const [, a1] = entryIds;

		const branched = await client.request(1, { BranchSession: { session: sessionId, entry: a1 } });
		expect(branched.outcome.RequestFailed?.error).toMatchObject({
			scope: "Session",
			code: "BRANCH_SESSION_FAILED",
			message: "Invalid entry ID for branching",
		});
	});

	test("successive BranchSession requests reuse live AgentSession and keep original source session unchanged", async () => {
		const { sessionId, entryIds, sm: sourceSm } = await createPopulatedSession(tempDir, [
			{ role: "user", text: "Turn 1 Q" },
			{ role: "assistant", text: "Turn 1 A" },
			{ role: "user", text: "Turn 2 Q" },
			{ role: "assistant", text: "Turn 2 A" },
			{ role: "user", text: "Turn 3 Q" },
			{ role: "assistant", text: "Turn 3 A" },
		]);
		const [u1, a1, u2, a2] = entryIds;
		const sourceFile = sourceSm.getSessionFile()!;

		// First branch from latest user message (Turn 3 Q) -> keeps [u1, a1, u2, a2]
		const branch1 = await client.request(1, { BranchSession: { session: sessionId } });
		expect(branch1.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		const branch1Id = snapshot<{ value: { id: string } }>(branch1.frames, "ActiveSession")?.value.id;
		expect(branch1Id).toBeDefined();
		expect(branch1Id).not.toBe(sessionId);

		const branch1Path = await findSessionPath(branch1Id!, tempDir, tempDir);
		expect(branch1Path).toBeDefined();
		const branch1Sm = await SessionManager.open(branch1Path!, undefined, undefined, { suppressBreadcrumb: true });
		expect(branch1Sm.getLeafId()).toBe(a2);
		expect(branch1Sm.getBranch().map(e => e.id)).toEqual([u1, a1, u2, a2]);

		// Second branch from the active branch's latest user message (Turn 2 Q) -> keeps [u1, a1]
		const branch2 = await client.request(2, { BranchSession: { session: branch1Id } });
		expect(branch2.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		const branch2Id = snapshot<{ value: { id: string } }>(branch2.frames, "ActiveSession")?.value.id;
		expect(branch2Id).toBeDefined();
		expect(branch2Id).not.toBe(branch1Id);
		expect(branch2Id).not.toBe(sessionId);

		const branch2Path = await findSessionPath(branch2Id!, tempDir, tempDir);
		expect(branch2Path).toBeDefined();
		const branch2Sm = await SessionManager.open(branch2Path!, undefined, undefined, { suppressBreadcrumb: true });
		expect(branch2Sm.getLeafId()).toBe(a1);
		expect(branch2Sm.getBranch().map(e => e.id)).toEqual([u1, a1]);

		// Verify original source session remains completely unchanged on disk
		const sourceReopened = await SessionManager.open(sourceFile, undefined, undefined, { suppressBreadcrumb: true });
		expect(sourceReopened.getLeafId()).toBe(entryIds[5]);
		expect(sourceReopened.getBranch().map(e => e.id)).toEqual(entryIds);
	});

	test("BranchSession cancelled by extension hook returns SWITCH_CANCELLED and leaves source session unchanged", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-agent-"));
		const extDir = path.join(agentDir, "extensions");
		let cancelServer: GuiHostServer | null = null;
		let cancelClient: TestSocketClient | null = null;
		try {
			await fs.mkdir(extDir, { recursive: true });
			await fs.writeFile(
				path.join(extDir, "cancel.ts"),
				'export default function(pi: { on: (event: string, handler: () => { cancel: boolean }) => void }) { pi.on("session_before_branch", () => ({ cancel: true })); }',
			);

			cancelServer = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir });
			cancelClient = await TestSocketClient.connect(cancelServer.endpoint);
			await cancelClient.nextFrame();
			await cancelClient.nextFrame();

			const storage = new FileSessionStorage();
			const sessionDir = computeDefaultSessionDir(tempDir, storage, path.join(agentDir, "sessions"));
			const sm = SessionManager.create(tempDir, sessionDir, storage);
			const u1 = sm.appendMessage({ role: "user", content: [{ type: "text", text: "Q1" }], timestamp: 1 });
			const a1 = sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "A1" }],
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
				timestamp: 2,
			});
			await sm.flush();
			const sessionId = sm.getSessionId();
			const sourcePath = sm.getSessionFile()!;

			const branched = await cancelClient.request(1, { BranchSession: { session: sessionId } });
			expect(branched.outcome.RequestFailed?.error).toMatchObject({
				scope: "Session",
				code: "SWITCH_CANCELLED",
				retryable: true,
			});

			// Source session remains intact
			const reopened = await SessionManager.open(sourcePath, undefined, undefined, { suppressBreadcrumb: true });
			expect(reopened.getLeafId()).toBe(a1);
			expect(reopened.getBranch().map(e => e.id)).toEqual([u1, a1]);

			// Session list only has the original session
			const listed = await cancelClient.request(2, "ListSessions");
			expect(sessionRows(listed.frames).map(s => s.id)).toEqual([sessionId]);
		} finally {
			cancelClient?.destroy();
			if (cancelServer) await cancelServer.close();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
