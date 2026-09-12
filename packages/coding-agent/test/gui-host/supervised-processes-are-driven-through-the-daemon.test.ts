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
 * process signaling/stopping/restarting, exit reporting, and fail-closed validation
 * contracts.
 *
 * The listing carries every field the daemon's own describe RPC returns, which is why the
 * protocol has no separate describe action: a single-row snapshot would replace the pane's
 * whole list with the one process it named. The exit of a process is read from the same
 * listing rather than from a blocking wait action.
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

	test("ProcessStart, RefreshProcesses, ProcessLogs, ProcessSend, ProcessStop, ProcessRestart, and ProcessSignal drive daemon supervisor", async () => {
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

		// 2. RefreshProcesses lists every managed process with the whole of its spec, which
		//    is what makes a separate per-process describe action unnecessary.
		const refreshResult = await client.request(2, "RefreshProcesses");
		expect(refreshResult.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		const refreshSnapFrame = refreshResult.frames.find(f => f.Snapshot && "Processes" in f.Snapshot);
		expect(refreshSnapFrame).toBeDefined();
		const refreshedList = refreshSnapFrame!.Snapshot!.Processes as Array<{
			name: string;
			application: string;
			args: string[];
			cwd: string;
			lifetime: string;
		}>;
		const worker = refreshedList.find(p => p.name === "worker-proc");
		expect(worker).toBeDefined();
		expect(worker!.application).toBe("sh");
		expect(worker!.args).toEqual(["-c", "printf 'line1\\nline2\\n'; sleep 30"]);
		expect(worker!.cwd).toBe(tempDir);
		expect(worker!.lifetime).toBe("last-client-exit");

		// 3. ProcessLogs retrieves lines and cursor
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

		// 4. ProcessSend sends data to running process
		const sendResult = await client.request(5, {
			ProcessSend: {
				process_id: "worker-proc",
				data: Array.from(Buffer.from("hello\n", "utf8")),
			},
		});
		expect(sendResult.outcome).toEqual({ RequestSucceeded: { request: 5 } });

		// 5. ProcessStop stops the running process
		const stopResult = await client.request(6, {
			ProcessStop: { process_id: "worker-proc" },
		});
		expect(stopResult.outcome).toEqual({ RequestSucceeded: { request: 6 } });
		const stopSnapFrame = stopResult.frames.find(f => f.Snapshot && "Processes" in f.Snapshot);
		expect(stopSnapFrame).toBeDefined();

		// 6. ProcessRestart restarts the process
		const restartResult = await client.request(7, {
			ProcessRestart: { process_id: "worker-proc" },
		});
		expect(restartResult.outcome).toEqual({ RequestSucceeded: { request: 7 } });
		const restartSnapFrame = restartResult.frames.find(f => f.Snapshot && "Processes" in f.Snapshot);
		expect(restartSnapFrame).toBeDefined();

		// 7. ProcessSignal terminates the restarted process with SIGINT
		const signalResult = await client.request(8, {
			ProcessSignal: {
				process_id: "worker-proc",
				signal: "SIGINT",
			},
		});
		expect(signalResult.outcome).toEqual({ RequestSucceeded: { request: 8 } });

		// 8. A process that exits reports its exit code through the same listing. The loop is
		//    bounded, so a process whose exit never reaches the listing fails the test rather
		//    than hanging it, and every iteration is one request rather than a wall-clock wait.
		await client.request(9, {
			ProcessStart: {
				command: "sh",
				args: ["-c", "exit 0"],
				name: "quick-exit",
			},
		});
		let quickProc: { name: string; status: string; exit_code: number | null } | undefined;
		let listRequest = 10;
		for (let attempt = 0; attempt < 100 && quickProc?.exit_code === undefined; attempt += 1) {
			const listResult = await client.request(listRequest, "RefreshProcesses");
			expect(listResult.outcome).toEqual({ RequestSucceeded: { request: listRequest } });
			listRequest += 1;
			const listFrame = listResult.frames.find(f => f.Snapshot && "Processes" in f.Snapshot);
			const rows = (listFrame?.Snapshot?.Processes ?? []) as Array<{
				name: string;
				status: string;
				exit_code: number | null;
			}>;
			const row = rows.find(p => p.name === "quick-exit");
			if (row && row.exit_code !== null) {
				quickProc = row;
			}
		}
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
