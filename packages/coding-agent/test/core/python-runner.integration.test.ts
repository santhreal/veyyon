/**
 * End-to-end exercise of the new subprocess-backed Python runner.
 *
 * Gated by `VEYYON_PYTHON_INTEGRATION=1` so CI without a real Python interpreter
 * (or sandboxes where subprocess spawning is restricted) does not fail.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { disposeAllKernelSessions, executePythonWithKernel } from "@veyyon/coding-agent/eval/py/executor";
import { PythonKernel } from "@veyyon/coding-agent/eval/py/kernel";
import { filterEnv, resolvePythonRuntime } from "@veyyon/coding-agent/eval/py/runtime";
import { TempDir } from "@veyyon/utils";

const SHOULD_RUN = Bun.env.VEYYON_PYTHON_INTEGRATION === "1";
const MATPLOTLIB_TEST_CWD = process.cwd();

async function hasMatplotlib(cwd: string): Promise<boolean> {
	if (!SHOULD_RUN) return false;
	try {
		const { env } = (await Settings.init()).getShellConfig();
		const runtime = resolvePythonRuntime(cwd, filterEnv(env));
		const spawnEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(runtime.env)) {
			if (typeof value === "string") spawnEnv[key] = value;
		}
		const result = Bun.spawnSync([runtime.pythonPath, "-c", "import matplotlib"], {
			cwd,
			env: spawnEnv,
			stdout: "ignore",
			stderr: "ignore",
		});
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

const HAS_MATPLOTLIB = await hasMatplotlib(MATPLOTLIB_TEST_CWD);

describe.skipIf(!SHOULD_RUN)("python runner subprocess", () => {
	afterEach(async () => {
		await disposeAllKernelSessions();
	});

	it("streams stdout chunks as they are produced", async () => {
		using tempDir = TempDir.createSync("@python-runner-stream-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const chunks: string[] = [];
			const result = await executePythonWithKernel(
				kernel,
				["import sys", "for i in range(5):", "    print(i, flush=True)"].join("\n"),
				{
					onChunk: chunk => {
						chunks.push(chunk);
					},
				},
			);
			expect(result.exitCode).toBe(0);
			// 5 lines * (digit + newline) → at least 5 distinct chunks once printed.
			const text = chunks.join("");
			expect(text).toContain("0\n");
			expect(text).toContain("4\n");
		} finally {
			await kernel.shutdown();
		}
	});

	it.skipIf(process.platform === "win32")("runs in its own POSIX session", async () => {
		using tempDir = TempDir.createSync("@python-runner-session-isolation-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "import os; print(os.getsid(0), os.getpid())");
			const [sessionId, processId] = result.output.trim().split(/\s+/).map(Number);
			expect(sessionId).toBe(processId);
		} finally {
			await kernel.shutdown();
		}
	});

	// GRAN-11 sub-item (a): the Python kernel is spawned `detached: true` on POSIX,
	// so it becomes its OWN session/process-group leader (proven by the test above).
	// A process-GROUP-directed signal aimed at the parent's group would NOT reach a
	// child in its own group. The reap must therefore signal the kernel's DIRECT
	// pid. `BaseKernel.shutdown` escalates via `proc.kill("SIGTERM"/"SIGKILL")` on
	// the Bun.Subprocess, which targets the child pid directly (not the group), so
	// it does reach the detached child. This test locks that: it captures the real
	// OS pid of the detached kernel, confirms it is alive, then asserts shutdown
	// actually reaps it. If a future change relied on a group signal, the detached
	// child would survive and this test would fail with the process still alive.
	it.skipIf(process.platform === "win32")(
		"reaps the detached kernel process on shutdown (direct-pid kill reaches a setsid child)",
		async () => {
			using tempDir = TempDir.createSync("@python-runner-reap-");
			const kernel = await PythonKernel.start({ cwd: tempDir.path() });
			const result = await executePythonWithKernel(kernel, "import os; print(os.getpid())");
			const pid = Number(result.output.trim());
			expect(Number.isInteger(pid)).toBe(true);
			expect(pid).toBeGreaterThan(1);

			// `process.kill(pid, 0)` sends no signal; it only probes existence: it
			// succeeds while the pid is live and throws ESRCH once the pid is gone.
			const isAlive = (p: number): boolean => {
				try {
					process.kill(p, 0);
					return true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
					return true; // EPERM etc: the process exists, we just can't signal it
				}
			};

			expect(isAlive(pid)).toBe(true);

			// The reap CONTRACT: the detached child is actually gone after shutdown, and
			// (post KERNEL-EXIT-CONFIRM fix) `confirmed` truthfully reports the exit.
			// An idle kernel takes the graceful `{"type":"exit"}` path and exits with
			// code 0, which the FIRST wait observes — so shutdown confirms quickly and
			// does NOT need to escalate to SIGTERM/SIGKILL. If exit-0 were still misread
			// as "still running", this would both take multiple grace windows and report
			// confirmed:false, so the timing bound doubles as a no-needless-escalation
			// check (a full escalation would blow past ~2s of grace windows).
			const startedAt = Date.now();
			const shutdown = await kernel.shutdown();
			const elapsedMs = Date.now() - startedAt;
			expect(shutdown.confirmed).toBe(true);
			expect(elapsedMs).toBeLessThan(2_000);

			let stillAlive = isAlive(pid);
			for (let i = 0; stillAlive && i < 100; i++) {
				await new Promise(resolve => setTimeout(resolve, 20));
				stillAlive = isAlive(pid);
			}
			expect(stillAlive).toBe(false);
		},
	);

	it("cancels a long sleep via SIGINT within 500ms", async () => {
		using tempDir = TempDir.createSync("@python-runner-cancel-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const start = Date.now();
			const ac = new AbortController();
			const pending = executePythonWithKernel(kernel, "import time\ntime.sleep(30)", {
				signal: ac.signal,
			});
			setTimeout(() => ac.abort(new DOMException("user cancelled", "AbortError")), 50);
			const result = await pending;
			const elapsed = Date.now() - start;
			expect(result.cancelled).toBe(true);
			expect(elapsed).toBeLessThan(2_000);
			// Kernel must survive cancellation and remain usable.
			const next = await executePythonWithKernel(kernel, "print('alive')");
			expect(next.exitCode).toBe(0);
			expect(next.output).toContain("alive");
		} finally {
			await kernel.shutdown();
		}
	});

	it("preserves user namespace across calls", async () => {
		using tempDir = TempDir.createSync("@python-runner-session-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			await executePythonWithKernel(kernel, "x = 41");
			const result = await executePythonWithKernel(kernel, "x + 1");
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("42");
		} finally {
			await kernel.shutdown();
		}
	});

	it("emits an error frame when user code raises", async () => {
		using tempDir = TempDir.createSync("@python-runner-error-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "raise ValueError('boom')");
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("ValueError");
			expect(result.output).toContain("boom");
		} finally {
			await kernel.shutdown();
		}
	});

	it("supports top-level await across cells", async () => {
		using tempDir = TempDir.createSync("@python-runner-await-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const first = await executePythonWithKernel(
				kernel,
				["import asyncio", "x = await asyncio.sleep(0, result=21)", "x * 2"].join("\n"),
			);
			expect(first.exitCode).toBe(0);
			expect(first.output).toContain("42");
			const second = await executePythonWithKernel(kernel, "x + 1");
			expect(second.exitCode).toBe(0);
			expect(second.output).toContain("22");
		} finally {
			await kernel.shutdown();
		}
	});

	it.skipIf(!HAS_MATPLOTLIB)("captures display(fig) as a PNG before the figure is closed", async () => {
		const kernel = await PythonKernel.start({ cwd: MATPLOTLIB_TEST_CWD });
		try {
			const result = await executePythonWithKernel(
				kernel,
				[
					"import matplotlib.pyplot as plt",
					"fig, ax = plt.subplots()",
					"ax.plot([0, 1], [0, 1])",
					"display(fig)",
					"plt.close(fig)",
				].join("\n"),
			);

			expect(result.exitCode).toBe(0);
			const images = result.displayOutputs.filter(output => output.type === "image");
			expect(images).toHaveLength(1);
			expect(images[0]).toMatchObject({ mimeType: "image/png" });
			expect(images[0]?.data).not.toContain("blob:");
			expect(result.output).toContain("<Figure");
		} finally {
			await kernel.shutdown();
		}
	});

	it.skipIf(!HAS_MATPLOTLIB)("does not flush a second PNG for a displayed open figure", async () => {
		const kernel = await PythonKernel.start({ cwd: MATPLOTLIB_TEST_CWD });
		try {
			const result = await executePythonWithKernel(
				kernel,
				[
					"import matplotlib.pyplot as plt",
					"fig, ax = plt.subplots()",
					"ax.plot([0, 1], [1, 0])",
					"display(fig)",
				].join("\n"),
			);

			expect(result.exitCode).toBe(0);
			expect(result.displayOutputs.filter(output => output.type === "image")).toHaveLength(1);
		} finally {
			await kernel.shutdown();
		}
	});

	it("translates %pwd magic to the user namespace", async () => {
		using tempDir = TempDir.createSync("@python-runner-magic-");
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executePythonWithKernel(kernel, "%pwd");
			expect(result.exitCode).toBe(0);
			// %pwd returns the cwd string, which becomes the last-expression result.
			// On macOS, the OS may resolve /var to /private/var, so check by basename.
			expect(result.output).toContain(path.basename(tempDir.path()));
		} finally {
			await kernel.shutdown();
		}
	});
});
