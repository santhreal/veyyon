import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SessionKernel } from "@veyyon/coding-agent/eval/kernel-base";
import { disposeAllKernelSessions, executePython } from "@veyyon/coding-agent/eval/py/executor";
import type {
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelShutdownResult,
} from "@veyyon/coding-agent/eval/py/kernel";
import { PythonKernel } from "@veyyon/coding-agent/eval/py/kernel";
import { TempDir } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

// The code under test opens `AgentStorage`, which resolves `agent.db` under the
// ACTIVE PROFILE's agent dir. Without this the suite writes into the developer's
// real `~/.veyyon/profiles/<profile>/agent`.
useIsolatedAgentDir();

class FakeKernel implements SessionKernel {
	executeCalls = 0;
	shutdownCalls = 0;
	alive = true;
	readonly id: string;

	constructor(id: string) {
		this.id = id;
	}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.executeCalls += 1;
		options?.onChunk?.("ok\n");
		return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
	}

	async shutdown(): Promise<KernelShutdownResult> {
		this.shutdownCalls += 1;
		this.alive = false;
		return { confirmed: true };
	}

	isAlive(): boolean {
		return this.alive;
	}
}

// No `VEYYON_PYTHON_SKIP_CHECK` here on purpose: `checkPythonKernelAvailability`
// already returns ok without probing an interpreter under `bun test`, so setting the
// flag bought nothing and leaked a process-global into every file that ran later.
// Pinned by `core/python-availability-preflight-skip.test.ts`.
describe("executePython kernel reuse", () => {
	const originalStart = PythonKernel.start;
	let startCalls = 0;
	let kernels: FakeKernel[] = [];

	beforeEach(() => {
		startCalls = 0;
		kernels = [];
		PythonKernel.start = (async () => {
			startCalls += 1;
			const kernel = new FakeKernel(`kernel-${startCalls}`);
			kernels.push(kernel);
			return kernel as unknown as PythonKernel;
		}) as typeof PythonKernel.start;
	});

	afterEach(async () => {
		PythonKernel.start = originalStart;
		await disposeAllKernelSessions();
	});

	it("reuses kernels for session mode", async () => {
		using tempDir = TempDir.createSync("@python-kernel-session-");
		await executePython("print('one')", { cwd: tempDir.path(), sessionId: "session-a", kernelMode: "session" });
		await executePython("print('two')", { cwd: tempDir.path(), sessionId: "session-a", kernelMode: "session" });

		expect(startCalls).toBe(1);
		expect(kernels[0]?.executeCalls).toBe(2);
	});

	it("creates and disposes per-call kernels", async () => {
		using tempDir = TempDir.createSync("@python-kernel-session-");
		await executePython("print('one')", { cwd: tempDir.path(), kernelMode: "per-call" });
		await executePython("print('two')", { cwd: tempDir.path(), kernelMode: "per-call" });

		expect(startCalls).toBe(2);
		expect(kernels[0]?.shutdownCalls).toBe(1);
		expect(kernels[1]?.shutdownCalls).toBe(1);
	});

	it("resets the session kernel when requested", async () => {
		using tempDir = TempDir.createSync("@python-kernel-session-");
		await executePython("print('one')", { cwd: tempDir.path(), sessionId: "session-b", kernelMode: "session" });
		await executePython("print('two')", {
			cwd: tempDir.path(),
			sessionId: "session-b",
			kernelMode: "session",
			reset: true,
		});

		expect(startCalls).toBe(2);
		expect(kernels[0]?.shutdownCalls).toBe(1);
	});
});
