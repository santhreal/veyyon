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

describe("sessions action group behaviour", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-sessions-test-"));
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir });
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
});
