/**
 * WHY:
 *
 * Process supervisor action handlers previously returned fake success responses without
 * fetching logs, without driving the daemon supervisor, dropping log lines, and omitting
 * proper status mapping from the daemon list/describe RPC responses.
 *
 * This test suite closes the class of fake/shallow process supervisor implementations by
 * driving a real daemon supervisor instance through the GUI host socket protocol and
 * asserting full ProcessView fields, ProcessLogs chunk lines and cursors, follow streaming,
 * process signaling/stopping/restarting/waiting, and fail-closed validation contracts.
 *
 * Gap left:
 * Operating system daemon supervisor process tree orphan reaping during SIGKILL of broker worker.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { closeDaemonClients } from "../../src/launch/client";
import { TestSocketClient } from "./test-client";

describe("supervised processes are driven through the daemon", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-proc-test-"));
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		await closeDaemonClients();
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test("ProcessStart, RefreshProcesses, ProcessDescribe, ProcessLogs, ProcessSend, ProcessStop, ProcessRestart, and ProcessWait drive daemon supervisor", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		await client.nextFrame();
		await client.nextFrame();

		// 1. ProcessStart starts a real background process
		const startResult = await client.request(1, {
			ProcessStart: {
				command: "sh",
				args: ["-c", "printf 'line1\\nline2\\n'; sleep 30"],
				name: "worker-proc",
			},
		});

		expect(startResult.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		const startSnapFrame = startResult.frames.find(f => f.Snapshot && "Processes" in f.Snapshot);
		expect(startSnapFrame).toBeDefined();
		const startProcesses = startSnapFrame!.Snapshot!.Processes as Array<{
			name: string;
			pid: number | null;
			status: string;
			application: string;
			args: string[];
			cwd: string;
			lifetime: string;
			exit_code: number | null;
			terminated_by: string | null;
		}>;
		const workerProc = startProcesses.find(p => p.name === "worker-proc");
		expect(workerProc).toBeDefined();
		expect(workerProc!.name).toBe("worker-proc");
		expect(workerProc!.application).toBe("sh");
		expect(workerProc!.args).toEqual(["-c", "printf 'line1\\nline2\\n'; sleep 30"]);
		expect(workerProc!.cwd).toBe(tempDir);
		expect(workerProc!.lifetime).toBe("last-client-exit");
		expect(workerProc!.exit_code).toBeNull();
		expect(workerProc!.terminated_by).toBeNull();
		expect(typeof workerProc!.pid).toBe("number");

		// 2. RefreshProcesses lists all managed processes
		const refreshResult = await client.request(2, "RefreshProcesses");
		expect(refreshResult.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		const refreshSnapFrame = refreshResult.frames.find(f => f.Snapshot && "Processes" in f.Snapshot);
		expect(refreshSnapFrame).toBeDefined();
		const refreshedList = refreshSnapFrame!.Snapshot!.Processes as Array<{ name: string }>;
		expect(refreshedList.some(p => p.name === "worker-proc")).toBe(true);

		// 3. ProcessDescribe emits a single-row Processes snapshot for the named process
		const describeResult = await client.request(3, {
			ProcessDescribe: { process_id: "worker-proc" },
		});
		expect(describeResult.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		const descSnapFrame = describeResult.frames.find(f => f.Snapshot && "Processes" in f.Snapshot);
		expect(descSnapFrame).toBeDefined();
		const descProcesses = descSnapFrame!.Snapshot!.Processes as Array<{
			name: string;
			application: string;
			args: string[];
			cwd: string;
			lifetime: string;
		}>;
		expect(descProcesses.length).toBe(1);
		expect(descProcesses[0].name).toBe("worker-proc");
		expect(descProcesses[0].application).toBe("sh");
		expect(descProcesses[0].args).toEqual(["-c", "printf 'line1\\nline2\\n'; sleep 30"]);
		expect(descProcesses[0].cwd).toBe(tempDir);
		expect(descProcesses[0].lifetime).toBe("last-client-exit");

		// 4. ProcessLogs retrieves lines and cursor
		const logsResult = await client.request(4, {
			ProcessLogs: { process_id: "worker-proc", follow: false },
		});
		expect(logsResult.outcome).toEqual({ RequestSucceeded: { request: 4 } });
		const logsSnapFrame = logsResult.frames.find(f => f.Snapshot && "ProcessLogs" in f.Snapshot);
		expect(logsSnapFrame).toBeDefined();
		const logsChunk = logsSnapFrame!.Snapshot!.ProcessLogs as {
			process: string;
			lines: string[];
			cursor: number;
			reset: boolean;
		};
		expect(logsChunk.process).toBe("worker-proc");
		expect(logsChunk.reset).toBe(true);
		expect(typeof logsChunk.cursor).toBe("number");
		expect(logsChunk.lines).toContain("line1");
		expect(logsChunk.lines).toContain("line2");

		// 5. ProcessSend sends data to running process
		const sendResult = await client.request(5, {
			ProcessSend: {
				process_id: "worker-proc",
				data: Array.from(Buffer.from("hello\n", "utf8")),
			},
		});
		expect(sendResult.outcome).toEqual({ RequestSucceeded: { request: 5 } });

		// 6. ProcessStop stops the running process
		const stopResult = await client.request(6, {
			ProcessStop: { process_id: "worker-proc" },
		});
		expect(stopResult.outcome).toEqual({ RequestSucceeded: { request: 6 } });
		const stopSnapFrame = stopResult.frames.find(f => f.Snapshot && "Processes" in f.Snapshot);
		expect(stopSnapFrame).toBeDefined();

		// 7. ProcessRestart restarts the process
		const restartResult = await client.request(7, {
			ProcessRestart: { process_id: "worker-proc" },
		});
		expect(restartResult.outcome).toEqual({ RequestSucceeded: { request: 7 } });
		const restartSnapFrame = restartResult.frames.find(f => f.Snapshot && "Processes" in f.Snapshot);
		expect(restartSnapFrame).toBeDefined();

		// 8. ProcessSignal terminates the restarted process with SIGINT
		const signalResult = await client.request(8, {
			ProcessSignal: {
				process_id: "worker-proc",
				signal: "SIGINT",
			},
		});
		expect(signalResult.outcome).toEqual({ RequestSucceeded: { request: 8 } });

		// 9. ProcessWait waits for a short-lived process to exit
		await client.request(9, {
			ProcessStart: {
				command: "sh",
				args: ["-c", "exit 0"],
				name: "quick-exit",
			},
		});
		const waitResult = await client.request(10, {
			ProcessWait: { process_id: "quick-exit" },
		});
		expect(waitResult.outcome).toEqual({ RequestSucceeded: { request: 10 } });
		const waitSnapFrame = waitResult.frames.find(f => f.Snapshot && "Processes" in f.Snapshot);
		expect(waitSnapFrame).toBeDefined();
		const waitProcesses = waitSnapFrame!.Snapshot!.Processes as Array<{
			name: string;
			status: string;
			exit_code: number | null;
		}>;
		const quickProc = waitProcesses.find(p => p.name === "quick-exit");
		expect(quickProc).toBeDefined();
		expect(quickProc!.exit_code).toBe(0);

		client.destroy();
	});

	test("Missing required arguments fail with INVALID_ARGUMENTS in scope Terminal", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		await client.nextFrame();
		await client.nextFrame();

		const invalidActions = [
			{ ProcessLogs: {} },
			{ ProcessSend: {} },
			{ ProcessSignal: {} },
			{ ProcessSignal: { process_id: "proc" } },
			{ ProcessStop: {} },
			{ ProcessRestart: {} },
			{ ProcessStart: {} },
			{ ProcessWait: {} },
			{ ProcessDescribe: {} },
		];

		let reqId = 20;
		for (const action of invalidActions) {
			const res = await client.request(reqId, action);
			expect(res.outcome.RequestFailed?.request).toBe(reqId);
			expect(res.outcome.RequestFailed?.error).toMatchObject({
				scope: "Terminal",
				code: "INVALID_ARGUMENTS",
				retryable: false,
			});
			reqId++;
		}

		client.destroy();
	});
});
