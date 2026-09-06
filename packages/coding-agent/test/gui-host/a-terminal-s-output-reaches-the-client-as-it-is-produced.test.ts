/**
 * WHY:
 *
 * Terminal action handlers previously returned empty success responses without
 * managing real PTY sessions, failing to stream terminal output, neglecting scrollback
 * retention on attach, ignoring exited terminal states during writes, and discarding
 * lifecycle status changes.
 *
 * This test suite closes the class of fake/shallow terminal host implementations by
 * driving real PTY processes through the GUI host socket protocol and asserting exact
 * output byte arrays, monotonic sequence numbers, scrollback cap truncation, attach
 * replays, running/exited/failed status transitions, and fail-closed error contracts.
 *
 * Gap left:
 * Operating system PTY behavior under extreme system-wide file descriptor exhaustion.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { SCROLLBACK_CAP_BYTES } from "../../src/gui-host/actions/terminals";
import { type RequestFrame, TestSocketClient } from "./test-client";

describe("a terminal's output reaches the client as it is produced", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-term-test-"));
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test("CreateTerminal streams PTY output, emits exit code, allows scrollback replay on attach, and refuses write when exited", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		// Read greeting and capabilities
		await client.nextFrame();
		await client.nextFrame();

		// 1. Create a terminal running `/bin/sh -c 'printf hello; exit 3'`
		const createResult = await client.request(1, {
			CreateTerminal: {
				cwd: tempDir,
				shell: "/bin/sh -c 'printf hello; exit 3'",
				cols: 80,
				rows: 24,
			},
		});

		expect(createResult.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		const initialSnapFrame = createResult.frames.find(f => f.Snapshot && "Terminals" in f.Snapshot);
		expect(initialSnapFrame).toBeDefined();
		const initialSnap = initialSnapFrame!.Snapshot!.Terminals as Array<{
			id: string;
			cwd: string;
			shell: string;
			cols: number;
			rows: number;
			status: unknown;
		}>;
		expect(initialSnap.length).toBe(1);
		const terminalId = initialSnap[0].id;
		expect(initialSnap[0].cwd).toBe(tempDir);
		expect(initialSnap[0].shell).toBe("/bin/sh -c 'printf hello; exit 3'");
		expect(initialSnap[0].cols).toBe(80);
		expect(initialSnap[0].rows).toBe(24);
		expect(initialSnap[0].status).toBe("Running");

		// 2. Find streaming output frame (hello -> [104, 101, 108, 108, 111]) and exit frame
		let outputFrame: RequestFrame | null =
			createResult.frames.find(f => f.Snapshot && "TerminalOutput" in f.Snapshot) ?? null;
		let exitFrame: RequestFrame | null =
			createResult.frames.find(
				f =>
					f !== initialSnapFrame &&
					f.Snapshot &&
					"Terminals" in f.Snapshot &&
					typeof (f.Snapshot.Terminals as Array<{ status: unknown }>)[0]?.status === "object",
			) ?? null;

		for (let i = 0; i < 10 && (!outputFrame || !exitFrame); i++) {
			const frame = (await client.nextFrame()) as RequestFrame;
			if (!outputFrame && frame.Snapshot && "TerminalOutput" in frame.Snapshot) {
				outputFrame = frame;
			} else if (
				!exitFrame &&
				frame.Snapshot &&
				"Terminals" in frame.Snapshot &&
				typeof (frame.Snapshot.Terminals as Array<{ status: unknown }>)[0]?.status === "object"
			) {
				exitFrame = frame;
			}
		}

		expect(outputFrame).not.toBeNull();
		const terminalOutput = outputFrame!.Snapshot!.TerminalOutput as {
			terminal: string;
			seq: number;
			data: number[];
			reset: boolean;
		};
		expect(terminalOutput.terminal).toBe(terminalId);
		expect(terminalOutput.seq).toBe(1);
		expect(terminalOutput.reset).toBe(true);
		expect(Buffer.from(terminalOutput.data).toString("utf8")).toBe("hello");

		expect(exitFrame).not.toBeNull();
		const exitTerminals = exitFrame!.Snapshot!.Terminals as Array<{
			id: string;
			status: { Exited: { code: number } };
		}>;
		expect(exitTerminals.length).toBe(1);
		expect(exitTerminals[0].id).toBe(terminalId);
		expect(exitTerminals[0].status).toEqual({ Exited: { code: 3 } });

		// 3. AttachTerminal replays scrollback as a single reset: true chunk
		const attachResult = await client.request(2, {
			AttachTerminal: { terminal_id: terminalId },
		});
		expect(attachResult.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		const replayedOutput = attachResult.frames[0].Snapshot!.TerminalOutput as {
			terminal: string;
			seq: number;
			data: number[];
			reset: boolean;
		};
		expect(replayedOutput.terminal).toBe(terminalId);
		expect(replayedOutput.seq).toBe(2);
		expect(replayedOutput.reset).toBe(true);
		expect(Buffer.from(replayedOutput.data).toString("utf8")).toBe("hello");

		// 4. WriteTerminal to the exited terminal fails with TERMINAL_NOT_RUNNING
		const writeResult = await client.request(3, {
			WriteTerminal: { terminal_id: terminalId, data: [65, 66, 67] },
		});
		expect(writeResult.outcome.RequestFailed?.request).toBe(3);
		expect(writeResult.outcome.RequestFailed?.error).toMatchObject({
			scope: "Terminal",
			code: "TERMINAL_NOT_RUNNING",
			message: `Terminal '${terminalId}' is not running`,
			retryable: false,
		});

		client.destroy();
	});

	test("Scrollback buffer is capped at SCROLLBACK_CAP_BYTES on high-volume output", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		await client.nextFrame();
		await client.nextFrame();

		// Spawn a process that emits 150 KiB (exceeding the 128 KiB cap)
		const createResult = await client.request(10, {
			CreateTerminal: {
				cwd: tempDir,
				shell: '/bin/sh -c \'head -c 150000 /dev/zero | tr "\\0" "A"; exit 0\'',
			},
		});
		expect(createResult.outcome).toEqual({ RequestSucceeded: { request: 10 } });
		const terminalId = (createResult.frames[0].Snapshot!.Terminals as Array<{ id: string }>)[0].id;

		// Wait until the terminal process exits
		while (true) {
			const frame = (await client.nextFrame()) as RequestFrame;
			if (frame.Snapshot && "Terminals" in frame.Snapshot) {
				const terms = frame.Snapshot.Terminals as Array<{ id: string; status: unknown }>;
				if (terms[0]?.status && typeof terms[0].status === "object" && "Exited" in terms[0].status) {
					break;
				}
			}
		}

		// Replay scrollback via AttachTerminal
		const attachResult = await client.request(11, {
			AttachTerminal: { terminal_id: terminalId },
		});
		expect(attachResult.outcome).toEqual({ RequestSucceeded: { request: 11 } });
		const replayed = attachResult.frames[0].Snapshot!.TerminalOutput as {
			terminal: string;
			data: number[];
			reset: boolean;
		};
		expect(replayed.reset).toBe(true);
		expect(replayed.data.length).toBe(SCROLLBACK_CAP_BYTES);
		expect(replayed.data.every(b => b === 65)).toBe(true);

		client.destroy();
	});

	test("Interactive terminal supports Write, Resize, Clear, Restart, and Close", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		await client.nextFrame();
		await client.nextFrame();

		// 1. Create interactive shell terminal
		const createResult = await client.request(20, {
			CreateTerminal: {
				cwd: tempDir,
				shell: "/bin/sh",
				cols: 80,
				rows: 24,
			},
		});
		expect(createResult.outcome).toEqual({ RequestSucceeded: { request: 20 } });
		const terminalId = (createResult.frames[0].Snapshot!.Terminals as Array<{ id: string }>)[0].id;

		// 2. ResizeTerminal
		const resizeResult = await client.request(21, {
			ResizeTerminal: {
				terminal_id: terminalId,
				cols: 120,
				rows: 40,
			},
		});
		expect(resizeResult.outcome).toEqual({ RequestSucceeded: { request: 21 } });
		const resizedTerms = resizeResult.frames[0].Snapshot!.Terminals as Array<{
			id: string;
			cols: number;
			rows: number;
		}>;
		expect(resizedTerms[0].cols).toBe(120);
		expect(resizedTerms[0].rows).toBe(40);

		// Invalid resize parameters fail closed
		const invalidResize = await client.request(22, {
			ResizeTerminal: {
				terminal_id: terminalId,
				cols: 0,
				rows: -5,
			},
		});
		expect(invalidResize.outcome.RequestFailed?.request).toBe(22);
		expect(invalidResize.outcome.RequestFailed?.error).toMatchObject({
			scope: "Terminal",
			code: "INVALID_ARGUMENTS",
			message: "ResizeTerminal requires positive integer cols and rows parameters",
			retryable: false,
		});

		// 3. WriteTerminal sends command to PTY
		const writeResult = await client.request(23, {
			WriteTerminal: {
				terminal_id: terminalId,
				data: Array.from(Buffer.from("echo dynamic_output\n", "utf8")),
			},
		});
		expect(writeResult.outcome).toEqual({ RequestSucceeded: { request: 23 } });

		// 4. ClearTerminal empties scrollback and emits reset: true with empty data
		const clearResult = await client.request(24, {
			ClearTerminal: { terminal_id: terminalId },
		});
		expect(clearResult.outcome).toEqual({ RequestSucceeded: { request: 24 } });
		const clearOutput = clearResult.frames[0].Snapshot!.TerminalOutput as {
			terminal: string;
			data: number[];
			reset: boolean;
		};
		expect(clearOutput.terminal).toBe(terminalId);
		expect(clearOutput.reset).toBe(true);
		expect(clearOutput.data).toEqual([]);

		// 5. RestartTerminal restarts PTY session
		const restartResult = await client.request(25, {
			RestartTerminal: { terminal_id: terminalId },
		});
		expect(restartResult.outcome).toEqual({ RequestSucceeded: { request: 25 } });
		const restartedTerms = restartResult.frames[0].Snapshot!.Terminals as Array<{
			id: string;
			status: string;
		}>;
		expect(restartedTerms[0].id).toBe(terminalId);
		expect(restartedTerms[0].status).toBe("Running");

		// 6. CloseTerminal terminates PTY and removes from list
		const closeResult = await client.request(26, {
			CloseTerminal: { terminal_id: terminalId },
		});
		expect(closeResult.outcome).toEqual({ RequestSucceeded: { request: 26 } });
		const remainingTerms = closeResult.frames[0].Snapshot!.Terminals as Array<unknown>;
		expect(remainingTerms).toEqual([]);

		client.destroy();
	});

	test("Missing terminal id fails with TERMINAL_NOT_FOUND in scope Terminal", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		await client.nextFrame();
		await client.nextFrame();

		const missingId = "term-nonexistent-123";
		const actions = [
			{ AttachTerminal: { terminal_id: missingId } },
			{ WriteTerminal: { terminal_id: missingId, data: [1] } },
			{ ResizeTerminal: { terminal_id: missingId, cols: 80, rows: 24 } },
			{ RestartTerminal: { terminal_id: missingId } },
			{ ClearTerminal: { terminal_id: missingId } },
			{ CloseTerminal: { terminal_id: missingId } },
		];

		let reqId = 30;
		for (const action of actions) {
			const res = await client.request(reqId, action);
			expect(res.outcome.RequestFailed?.request).toBe(reqId);
			expect(res.outcome.RequestFailed?.error).toMatchObject({
				scope: "Terminal",
				code: "TERMINAL_NOT_FOUND",
				message: `Terminal '${missingId}' was not found`,
				retryable: false,
			});
			reqId++;
		}

		client.destroy();
	});

	test("CreateTerminal with invalid working directory fails with TERMINAL_SPAWN_FAILED and records Failed status", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		await client.nextFrame();
		await client.nextFrame();

		const invalidCwd = path.join(tempDir, "does-not-exist-dir");
		const res = await client.request(40, {
			CreateTerminal: {
				cwd: invalidCwd,
				shell: "/bin/sh",
			},
		});

		expect(res.outcome.RequestFailed?.request).toBe(40);
		expect(res.outcome.RequestFailed?.error).toMatchObject({
			scope: "Terminal",
			code: "TERMINAL_SPAWN_FAILED",
			retryable: false,
		});
		expect(res.outcome.RequestFailed?.error.message).toContain(invalidCwd);

		const snap = res.frames[0].Snapshot!.Terminals as Array<{
			id: string;
			status: { Failed: { message: string } };
		}>;
		expect(snap.length).toBe(1);
		expect(snap[0].status.Failed.message).toContain(invalidCwd);

		client.destroy();
	});
});
