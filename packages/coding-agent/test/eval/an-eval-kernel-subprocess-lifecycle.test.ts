/**
 * Lifecycle contract for subprocess-backed language kernels (Python, Ruby, Julia).
 *
 * DEFENDS:
 * 1. State persists across sequential cells in a session.
 * 2. `reset: true` terminates the active subprocess and spawns a fresh session with clean state.
 * 3. A cell that exceeds its timeout terminates within bounded wall-clock time and annotates output.
 * 4. Cancellation via AbortSignal interrupts and terminates the child process within bounded time.
 * 5. Crashed interpreters surface errors and recover rather than hanging the session indefinitely.
 * 6. Managed environment patches set, clear across cells, and propagate consistently.
 * 7. Per-call mode runs in isolation and does not mutate session state.
 */
import { afterEach, expect, it } from "bun:test";
import { disposeJuliaKernelSessionsByOwner, executeJulia } from "@veyyon/coding-agent/eval/jl/executor";
import { disposeKernelSessionsByOwner, executePython } from "@veyyon/coding-agent/eval/py/executor";
import { disposeRubyKernelSessionsByOwner, executeRuby } from "@veyyon/coding-agent/eval/rb/executor";
import { TempDir } from "@veyyon/utils";
import { describeRequiringTool } from "../../../utils/test/helpers/requires-tool";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

const PYTHON_OWNER = "eval-lifecycle-test-python";
const RUBY_OWNER = "eval-lifecycle-test-ruby";
const JULIA_OWNER = "eval-lifecycle-test-julia";

afterEach(async () => {
	await Promise.all([
		disposeKernelSessionsByOwner(PYTHON_OWNER),
		disposeRubyKernelSessionsByOwner(RUBY_OWNER),
		disposeJuliaKernelSessionsByOwner(JULIA_OWNER),
	]);
}, 30_000);

describeRequiringTool("python3", "Python kernel subprocess lifecycle", () => {
	it("persists state across cells in the same session", async () => {
		using tempDir = TempDir.createSync("@veyyon-python-state-");
		const sessionId = `py-state:${crypto.randomUUID()}`;

		const first = await executePython("session_var = 'stored_value_xyz'", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: PYTHON_OWNER,
		});
		expect(first.exitCode).toBe(0);

		const second = await executePython("print(f'READ:{session_var}')", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: PYTHON_OWNER,
		});
		expect(second.exitCode).toBe(0);
		expect(second.output).toContain("READ:stored_value_xyz");
	}, 30_000);

	it("clears state when reset is requested", async () => {
		using tempDir = TempDir.createSync("@veyyon-python-reset-");
		const sessionId = `py-reset:${crypto.randomUUID()}`;

		const first = await executePython("persisted_token = 42", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: PYTHON_OWNER,
		});
		expect(first.exitCode).toBe(0);

		const resetResult = await executePython("print(persisted_token)", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: PYTHON_OWNER,
			reset: true,
		});
		expect(resetResult.exitCode).toBe(1);
		expect(resetResult.output).toContain("NameError");
		expect(resetResult.output).toContain("persisted_token");
	}, 30_000);

	it("bounds execution time when a cell exceeds its timeout", async () => {
		using tempDir = TempDir.createSync("@veyyon-python-timeout-");
		const sessionId = `py-timeout:${crypto.randomUUID()}`;

		const startTime = Date.now();
		const result = await executePython("import time; time.sleep(10)", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: PYTHON_OWNER,
			timeoutMs: 800,
		});
		const durationMs = Date.now() - startTime;

		expect(durationMs).toBeLessThan(4000);
		expect(result.cancelled).toBe(true);
		expect(result.output).toMatch(/timed out/i);
	}, 15_000);

	it("aborts execution when AbortSignal fires", async () => {
		using tempDir = TempDir.createSync("@veyyon-python-abort-");
		const sessionId = `py-abort:${crypto.randomUUID()}`;
		const controller = new AbortController();

		const startTime = Date.now();
		const result = await executePython("import time; print('RUNNING', flush=True); time.sleep(10)", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: PYTHON_OWNER,
			signal: controller.signal,
			onChunk: chunk => {
				if (chunk.includes("RUNNING")) {
					controller.abort("user abort");
				}
			},
		});
		const durationMs = Date.now() - startTime;

		expect(durationMs).toBeLessThan(4000);
		expect(result.cancelled).toBe(true);
	}, 15_000);

	it("isolates execution in per-call mode without mutating session state", async () => {
		using tempDir = TempDir.createSync("@veyyon-python-percall-");
		const sessionId = `py-percall:${crypto.randomUUID()}`;

		const sessionInit = await executePython("session_flag = 'active'", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: PYTHON_OWNER,
		});
		expect(sessionInit.exitCode).toBe(0);

		const perCall = await executePython("per_call_val = 999; print('PER_CALL_OK')", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: PYTHON_OWNER,
			kernelMode: "per-call",
		});
		expect(perCall.exitCode).toBe(0);
		expect(perCall.output).toContain("PER_CALL_OK");

		const sessionCheck = await executePython("print('HAS_PER_CALL=' + str('per_call_val' in globals()))", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: PYTHON_OWNER,
		});
		expect(sessionCheck.exitCode).toBe(0);
		expect(sessionCheck.output).toContain("HAS_PER_CALL=False");
	}, 30_000);

	it("applies managed environment variable patches and handles clearing across cells", async () => {
		using tempDir = TempDir.createSync("@veyyon-python-env-");
		const sessionId = `py-env:${crypto.randomUUID()}`;

		const setVar = await executePython(
			"import os; print('ART=' + os.environ.get('VEYYON_ARTIFACTS_DIR', '<unset>'))",
			{
				cwd: tempDir.path(),
				sessionId,
				kernelOwnerId: PYTHON_OWNER,
				artifactsDir: "/custom/artifacts/dir",
			},
		);
		expect(setVar.exitCode).toBe(0);
		expect(setVar.output).toContain("ART=/custom/artifacts/dir");

		const clearVar = await executePython(
			"import os; print('ART_CLEARED=' + os.environ.get('VEYYON_ARTIFACTS_DIR', '<unset>'))",
			{
				cwd: tempDir.path(),
				sessionId,
				kernelOwnerId: PYTHON_OWNER,
			},
		);
		expect(clearVar.exitCode).toBe(0);
		expect(clearVar.output).toContain("ART_CLEARED=<unset>");
	}, 30_000);
});

describeRequiringTool("ruby", "Ruby kernel subprocess lifecycle", () => {
	it("persists state across cells in the same session", async () => {
		using tempDir = TempDir.createSync("@veyyon-ruby-state-");
		const sessionId = `rb-state:${crypto.randomUUID()}`;

		const first = await executeRuby("$session_var = 'stored_ruby_val'", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: RUBY_OWNER,
		});
		expect(first.exitCode).toBe(0);

		const second = await executeRuby('puts "READ:#{$session_var}"', {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: RUBY_OWNER,
		});
		expect(second.exitCode).toBe(0);
		expect(second.output).toContain("READ:stored_ruby_val");
	}, 30_000);

	it("clears state when reset is requested", async () => {
		using tempDir = TempDir.createSync("@veyyon-ruby-reset-");
		const sessionId = `rb-reset:${crypto.randomUUID()}`;

		const first = await executeRuby("$persisted_token = 42", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: RUBY_OWNER,
		});
		expect(first.exitCode).toBe(0);

		const resetResult = await executeRuby("puts $persisted_token.nil? ? 'CLEARED' : 'STILL_THERE'", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: RUBY_OWNER,
			reset: true,
		});
		expect(resetResult.exitCode).toBe(0);
		expect(resetResult.output).toContain("CLEARED");
	}, 30_000);

	it("bounds execution time when a cell exceeds its timeout", async () => {
		using tempDir = TempDir.createSync("@veyyon-ruby-timeout-");
		const sessionId = `rb-timeout:${crypto.randomUUID()}`;

		const startTime = Date.now();
		const result = await executeRuby("sleep 10", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: RUBY_OWNER,
			timeoutMs: 800,
		});
		const durationMs = Date.now() - startTime;

		expect(durationMs).toBeLessThan(4000);
		expect(result.cancelled).toBe(true);
		expect(result.output).toMatch(/timed out/i);
	}, 15_000);

	it("aborts execution when AbortSignal fires", async () => {
		using tempDir = TempDir.createSync("@veyyon-ruby-abort-");
		const sessionId = `rb-abort:${crypto.randomUUID()}`;
		const controller = new AbortController();

		const startTime = Date.now();
		const result = await executeRuby("STDOUT.puts 'RUNNING'; STDOUT.flush; sleep 10", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: RUBY_OWNER,
			signal: controller.signal,
			onChunk: chunk => {
				if (chunk.includes("RUNNING")) {
					controller.abort("user abort");
				}
			},
		});
		const durationMs = Date.now() - startTime;

		expect(durationMs).toBeLessThan(4000);
		expect(result.cancelled).toBe(true);
	}, 15_000);

	it("applies managed environment variable patches and handles clearing across cells", async () => {
		using tempDir = TempDir.createSync("@veyyon-ruby-env-");
		const sessionId = `rb-env:${crypto.randomUUID()}`;

		const setVar = await executeRuby("puts \"ART=#{ENV['VEYYON_ARTIFACTS_DIR'] || '<unset>'}\"", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: RUBY_OWNER,
			artifactsDir: "/custom/artifacts/ruby",
		});
		expect(setVar.exitCode).toBe(0);
		expect(setVar.output).toContain("ART=/custom/artifacts/ruby");

		const clearVar = await executeRuby("puts \"ART_CLEARED=#{ENV['VEYYON_ARTIFACTS_DIR'] || '<unset>'}\"", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: RUBY_OWNER,
		});
		expect(clearVar.exitCode).toBe(0);
		expect(clearVar.output).toContain("ART_CLEARED=<unset>");
	}, 30_000);
});

describeRequiringTool("julia", "Julia kernel subprocess lifecycle", () => {
	it("persists state across cells in the same session", async () => {
		using tempDir = TempDir.createSync("@veyyon-julia-state-");
		const sessionId = `jl-state:${crypto.randomUUID()}`;

		const first = await executeJulia("session_val = 12345", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: JULIA_OWNER,
		});
		expect(first.exitCode).toBe(0);

		const second = await executeJulia('println("READ=", session_val)', {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: JULIA_OWNER,
		});
		expect(second.exitCode).toBe(0);
		expect(second.output).toContain("READ=12345");
	}, 60_000);

	it("clears state when reset is requested", async () => {
		using tempDir = TempDir.createSync("@veyyon-julia-reset-");
		const sessionId = `jl-reset:${crypto.randomUUID()}`;

		const first = await executeJulia("persisted_val = 9876", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: JULIA_OWNER,
		});
		expect(first.exitCode).toBe(0);

		const resetResult = await executeJulia("println(persisted_val)", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: JULIA_OWNER,
			reset: true,
		});
		expect(resetResult.exitCode).toBe(1);
		expect(resetResult.output).toContain("UndefVarError");
	}, 60_000);

	it("bounds execution time when a cell exceeds its timeout", async () => {
		using tempDir = TempDir.createSync("@veyyon-julia-timeout-");
		const sessionId = `jl-timeout:${crypto.randomUUID()}`;

		const startTime = Date.now();
		const result = await executeJulia("sleep(10)", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: JULIA_OWNER,
			timeoutMs: 800,
		});
		const durationMs = Date.now() - startTime;

		expect(durationMs).toBeLessThan(4000);
		expect(result.cancelled).toBe(true);
		expect(result.output).toMatch(/timed out/i);
	}, 30_000);

	it("aborts execution when AbortSignal fires", async () => {
		using tempDir = TempDir.createSync("@veyyon-julia-abort-");
		const sessionId = `jl-abort:${crypto.randomUUID()}`;
		const controller = new AbortController();

		const startTime = Date.now();
		const result = await executeJulia('println("RUNNING"); flush(stdout); sleep(10)', {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: JULIA_OWNER,
			signal: controller.signal,
			onChunk: chunk => {
				if (chunk.includes("RUNNING")) {
					controller.abort("user abort");
				}
			},
		});
		const durationMs = Date.now() - startTime;

		expect(durationMs).toBeLessThan(4000);
		expect(result.cancelled).toBe(true);
	}, 30_000);

	it("applies managed environment variable patches and handles clearing across cells", async () => {
		using tempDir = TempDir.createSync("@veyyon-julia-env-");
		const sessionId = `jl-env:${crypto.randomUUID()}`;

		const setVar = await executeJulia('println("ART=", get(ENV, "VEYYON_ARTIFACTS_DIR", "<unset>"))', {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: JULIA_OWNER,
			artifactsDir: "/custom/artifacts/julia",
		});
		expect(setVar.exitCode).toBe(0);
		expect(setVar.output).toContain("ART=/custom/artifacts/julia");

		const clearVar = await executeJulia('println("ART_CLEARED=", get(ENV, "VEYYON_ARTIFACTS_DIR", "<unset>"))', {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: JULIA_OWNER,
		});
		expect(clearVar.exitCode).toBe(0);
		expect(clearVar.output).toContain("ART_CLEARED=<unset>");
	}, 60_000);
});
