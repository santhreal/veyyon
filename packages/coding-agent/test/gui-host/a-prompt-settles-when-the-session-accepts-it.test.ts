/**
 * WHY: the turn actions are the composer's primary controls, and each one
 * used to answer without touching the session it named: `SubmitPrompt`
 * ignored `session` and blocked its reply until the whole turn ended;
 * `SetQueueMode` stored any string and nothing read it; `CancelTool` aborted
 * whatever was running for any id. The class this closes is a turn control
 * that reports success without the session having taken the action.
 *
 * Not caught: a streamed turn against a provider, which needs a model and a
 * key. The acceptance path is asserted up to the session's own rejection,
 * which is deterministic because the host is given an empty credential store
 * of its own rather than the profile's.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, TestSocketClient } from "./test-client";

describe("a prompt settles when the session accepts it", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	let sessionId: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-turn-test-"));
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage: await isolatedAuthStorage(tempDir),
		});
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
		const created = await client.request(1, { CreateSession: {} });
		const active = created.frames.find(f => f.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		sessionId = active.Snapshot.ActiveSession.value.id;
	});

	afterEach(async () => {
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("a prompt the session rejects fails with the session's reason and streams nothing", async () => {
		const submitted = await client.request(2, {
			SubmitPrompt: { session: sessionId, text: "hello", attachments: [] },
		});
		expect(submitted.outcome.RequestFailed?.error.scope).toBe("Session");
		expect(submitted.outcome.RequestFailed?.error.code).toBe("PROMPT_REJECTED");
		expect(submitted.outcome.RequestFailed?.error.message.length).toBeGreaterThan(0);
		expect(submitted.frames.filter(f => "StreamingChanged" in f)).toEqual([]);
	});

	test("a prompt naming an unknown session is not delivered anywhere", async () => {
		const submitted = await client.request(2, {
			SubmitPrompt: { session: "no-such-session", text: "hello", attachments: [] },
		});
		expect(submitted.outcome.RequestFailed?.error).toMatchObject({ scope: "Session", code: "SESSION_NOT_FOUND" });
	});

	test("an empty prompt is rejected before the session is touched", async () => {
		const submitted = await client.request(2, { SubmitPrompt: { session: sessionId, text: "   ", attachments: [] } });
		expect(submitted.outcome.RequestFailed?.error).toMatchObject({ scope: "Session", code: "INVALID_ARGUMENTS" });
		expect(submitted.frames).toHaveLength(1);
	});

	test("the queue mode is one of the two the composer offers", async () => {
		const lower = await client.request(2, { SetQueueMode: { session: sessionId, mode: "steer" } });
		expect(lower.outcome.RequestFailed?.error).toMatchObject({ scope: "Session", code: "INVALID_ARGUMENTS" });
		expect(lower.outcome.RequestFailed?.error.message).toContain("Steer, Queue");
		const upper = await client.request(3, { SetQueueMode: { session: sessionId, mode: "Queue" } });
		expect(upper.outcome).toEqual({ RequestSucceeded: { request: 3 } });
	});

	test("abort and cancel on an idle session name what is not running", async () => {
		const abort = await client.request(2, { AbortTurn: { session: sessionId } });
		expect(abort.outcome.RequestFailed?.error).toMatchObject({ scope: "Session", code: "NOT_RUNNING" });
		const cancel = await client.request(3, { CancelTool: { session: sessionId, tool_call_id: "call-1" } });
		expect(cancel.outcome.RequestFailed?.error).toMatchObject({ scope: "Tool", code: "TOOL_NOT_RUNNING" });
		expect(cancel.outcome.RequestFailed?.error.message).toContain("call-1");
	});

	test("an answer to a decision nobody raised is not found", async () => {
		const answered = await client.request(2, {
			RespondToInteraction: { session: sessionId, interaction_id: "missing", response: { approved: true } },
		});
		const error = (answered.outcome as RequestFrame).RequestFailed?.error;
		expect(error).toMatchObject({ scope: "Interaction", code: "INTERACTION_NOT_FOUND" });
	});
});
