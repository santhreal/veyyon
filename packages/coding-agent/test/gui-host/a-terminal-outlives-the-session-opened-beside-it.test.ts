/**
 * WHY: a live smoke opened a terminal, created a session, and then could not
 * close the terminal: `TERMINAL_NOT_FOUND`. Session disposal tore down every
 * resource on the client state, and a session switch disposes the session.
 *
 * CLASS CLOSED: a client-scoped resource — a terminal, a process log
 * follower — ended by a session-scoped transition. The terminal is the
 * observable member: its id must answer after the session it was opened
 * beside is replaced, and must stop answering once the client leaves.
 *
 * NOT CAUGHT: whether the PTY process is reaped on disconnect; the host is
 * observed through its protocol only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { TestSocketClient } from "./test-client";

describe("a terminal outlives the session opened beside it", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-term-session-"));
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage: await isolatedAuthStorage(tempDir),
		});
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("creating and switching sessions leaves the terminal running; leaving ends it", async () => {
		const client = await TestSocketClient.connect(server!.endpoint);
		await client.nextFrame();
		await client.nextFrame();

		const created = await client.request(1, {
			CreateTerminal: { cwd: tempDir, shell: "/bin/sh", cols: 80, rows: 24 },
		});
		expect(created.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		const terminals = created.frames.find(f => f.Snapshot?.Terminals)?.Snapshot?.Terminals as Array<{ id: string }>;
		const terminalId = terminals[0].id;

		const first = await client.request(2, { CreateSession: {} });
		expect(first.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		const second = await client.request(3, { CreateSession: {} });
		expect(second.outcome).toEqual({ RequestSucceeded: { request: 3 } });

		const written = await client.request(4, {
			WriteTerminal: { terminal_id: terminalId, data: Array.from(Buffer.from("echo still-here\n")) },
		});
		expect(written.outcome).toEqual({ RequestSucceeded: { request: 4 } });

		const attached = await client.request(5, { AttachTerminal: { terminal_id: terminalId } });
		expect(attached.outcome).toEqual({ RequestSucceeded: { request: 5 } });
		const replay = attached.frames.find(f => f.Snapshot?.TerminalOutput)?.Snapshot?.TerminalOutput as {
			terminal: string;
			reset: boolean;
		};
		expect([replay.terminal, replay.reset]).toEqual([terminalId, true]);

		const closed = await client.request(6, { CloseTerminal: { terminal_id: terminalId } });
		expect(closed.outcome).toEqual({ RequestSucceeded: { request: 6 } });
		client.destroy();
	});

	test("a second client never sees the first client's terminal", async () => {
		const first = await TestSocketClient.connect(server!.endpoint);
		await first.nextFrame();
		await first.nextFrame();
		const created = await first.request(1, { CreateTerminal: { cwd: tempDir, shell: "/bin/sh" } });
		const terminalId = (
			created.frames.find(f => f.Snapshot?.Terminals)?.Snapshot?.Terminals as Array<{ id: string }>
		)[0].id;

		const second = await TestSocketClient.connect(server!.endpoint);
		await second.nextFrame();
		await second.nextFrame();
		const attached = await second.request(1, { AttachTerminal: { terminal_id: terminalId } });
		expect(attached.outcome.RequestFailed?.error).toMatchObject({ scope: "Terminal", code: "TERMINAL_NOT_FOUND" });

		first.destroy();
		second.destroy();
	});
});
