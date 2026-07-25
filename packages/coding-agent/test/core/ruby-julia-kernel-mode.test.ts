/**
 * Ruby and Julia honour a per-call kernel mode, the way Python already did.
 *
 * WHY THIS SUITE EXISTS. `eval` keeps a language kernel alive between cells so the second cell can see
 * the first cell's variables, which is what makes it feel like a notebook. That is the right default and
 * it is the wrong behaviour for anything that needs a clean slate: a cell that mutates a global, a run
 * that must not inherit a half-broken state from the cell before it, a kernel wedged by a previous cell.
 * Python had `python.kernelMode = "per-call"` for exactly that. Ruby and Julia had no such concept at
 * all: their executors only ever ran on a shared session, so the same operator knob silently did nothing
 * for two of the three runtimes.
 *
 * The tests below pin the two properties that make the mode real rather than nominal, for BOTH new
 * languages: a per-call run starts a kernel of its own and shuts it down when the cell is done (so no
 * state and no process survives the call), and a session run keeps using the one kernel (so adding the
 * mode did not quietly turn the notebook default into a fresh kernel per cell, which would be a large
 * silent slowdown -- a Julia kernel recompiles on every start).
 *
 * Shutdown-on-failure has its own test because the `finally` is the part that is easy to lose in a
 * refactor, and losing it leaks one kernel subprocess per failed cell.
 *
 * The kernels are stubbed. A real Ruby kernel is available on some machines and a real Julia kernel on
 * almost none, and neither is needed: the question here is which lifecycle the executor drives, and a
 * stub answers it exactly and identically on every machine.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { EDITING_SETTINGS } from "@veyyon/coding-agent/config/settings-domains/editing";
import { disposeAllJuliaKernelSessions, executeJulia } from "@veyyon/coding-agent/eval/jl/executor";
import { JuliaKernel } from "@veyyon/coding-agent/eval/jl/kernel";
import { disposeAllRubyKernelSessions, executeRuby } from "@veyyon/coding-agent/eval/rb/executor";
import { RubyKernel } from "@veyyon/coding-agent/eval/rb/kernel";
import { TempDir } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

// The executors open `AgentStorage`, which resolves under the ACTIVE PROFILE's agent dir, so without
// this the suite writes into the developer's real `~/.veyyon` and trips the real-data tripwire.
useIsolatedAgentDir();

const originalRubyStart = RubyKernel.start;
const originalJuliaStart = JuliaKernel.start;

/** What the stubbed kernels recorded, which is the whole observation this suite makes. */
interface Lifecycle {
	starts: number;
	shutdowns: number;
	codes: string[];
}

/** Install a stub kernel that succeeds, and report how many were started and shut down. */
function stubKernels(options: { fail?: boolean } = {}): Lifecycle {
	const lifecycle: Lifecycle = { starts: 0, shutdowns: 0, codes: [] };
	const kernel = {
		execute: async (code: string) => {
			lifecycle.codes.push(code);
			if (options.fail) throw new Error("the cell blew up");
			return { status: "ok" as const, cancelled: false, timedOut: false, stdinRequested: false };
		},
		isAlive: () => true,
		shutdown: async () => {
			lifecycle.shutdowns += 1;
			return { confirmed: true };
		},
	};
	const start = async () => {
		lifecycle.starts += 1;
		return kernel as unknown as RubyKernel & JuliaKernel;
	};
	RubyKernel.start = start as unknown as typeof RubyKernel.start;
	JuliaKernel.start = start as unknown as typeof JuliaKernel.start;
	return lifecycle;
}

afterEach(async () => {
	// Session-mode tests leave a stub kernel registered under a session key. Dropping it here keeps the
	// stub out of any later file's sessions, and exercises the dispose path against the stub as a bonus.
	await disposeAllRubyKernelSessions();
	await disposeAllJuliaKernelSessions();
	RubyKernel.start = originalRubyStart;
	JuliaKernel.start = originalJuliaStart;
});

describe("Ruby per-call kernel mode", () => {
	/**
	 * THE contract. Two cells, two kernels, two shutdowns: nothing the first cell defined can be visible
	 * to the second, because the process that held it is gone before the second one starts.
	 */
	it("starts a kernel for every cell and shuts each one down", async () => {
		using tempDir = TempDir.createSync("@veyyon-rb-kernel-mode-");
		const lifecycle = stubKernels();

		await executeRuby("x = 1", { kernelMode: "per-call", cwd: tempDir.path() });
		await executeRuby("x = 2", { kernelMode: "per-call", cwd: tempDir.path() });

		expect(lifecycle.starts).toBe(2);
		expect(lifecycle.shutdowns).toBe(2);
		expect(lifecycle.codes).toEqual(["x = 1", "x = 2"]);
	});

	/**
	 * The `finally` around the cell. A cell that throws still owns a kernel subprocess, and leaving it
	 * running leaks one process per failure -- the failure mode that is invisible until a machine is out
	 * of file descriptors.
	 */
	it("shuts the kernel down even when the cell throws", async () => {
		using tempDir = TempDir.createSync("@veyyon-rb-kernel-mode-");
		const lifecycle = stubKernels({ fail: true });

		await expect(executeRuby("raise 'no'", { kernelMode: "per-call", cwd: tempDir.path() })).rejects.toThrow(
			"the cell blew up",
		);

		expect(lifecycle.starts).toBe(1);
		expect(lifecycle.shutdowns).toBe(1);
	});

	/** A per-call run registers no session, so a later session-mode run cannot inherit its kernel. */
	it("leaves no session behind, so a following session run starts its own kernel", async () => {
		using tempDir = TempDir.createSync("@veyyon-rb-kernel-mode-");
		const lifecycle = stubKernels();

		await executeRuby("x = 1", { kernelMode: "per-call", cwd: tempDir.path(), sessionId: "ruby:shared" });
		expect(lifecycle.shutdowns).toBe(1);

		await executeRuby("x", { kernelMode: "session", cwd: tempDir.path(), sessionId: "ruby:shared" });

		expect(lifecycle.starts).toBe(2);
	});
});

describe("Ruby session kernel mode", () => {
	/**
	 * The default, unchanged. This is the test that catches the dangerous direction of the change: if the
	 * dispatch were inverted, or the default read as `per-call`, every Ruby cell would pay a fresh kernel
	 * startup and no cell would see the one before it, and nothing else in the suite would notice.
	 */
	it("reuses one kernel across cells and does not shut it down between them", async () => {
		using tempDir = TempDir.createSync("@veyyon-rb-kernel-mode-");
		const lifecycle = stubKernels();

		await executeRuby("x = 1", { kernelMode: "session", cwd: tempDir.path(), sessionId: "ruby:reuse" });
		await executeRuby("x + 1", { kernelMode: "session", cwd: tempDir.path(), sessionId: "ruby:reuse" });

		expect(lifecycle.starts).toBe(1);
		expect(lifecycle.shutdowns).toBe(0);
	});

	/** An omitted mode is the session mode, which is the behaviour every Ruby cell had before the knob. */
	it("is what an omitted kernelMode means", async () => {
		using tempDir = TempDir.createSync("@veyyon-rb-kernel-mode-");
		const lifecycle = stubKernels();

		await executeRuby("x = 1", { cwd: tempDir.path(), sessionId: "ruby:default" });
		await executeRuby("x + 1", { cwd: tempDir.path(), sessionId: "ruby:default" });

		expect(lifecycle.starts).toBe(1);
		expect(lifecycle.shutdowns).toBe(0);
	});
});

describe("Julia per-call kernel mode", () => {
	/**
	 * Julia is the language where per-call costs the most: a fresh kernel recompiles, so this mode is a
	 * deliberate trade of speed for a clean slate. It still has to actually be a clean slate.
	 */
	it("starts a kernel for every cell and shuts each one down", async () => {
		using tempDir = TempDir.createSync("@veyyon-jl-kernel-mode-");
		const lifecycle = stubKernels();

		await executeJulia("x = 1", { kernelMode: "per-call", cwd: tempDir.path() });
		await executeJulia("x = 2", { kernelMode: "per-call", cwd: tempDir.path() });

		expect(lifecycle.starts).toBe(2);
		expect(lifecycle.shutdowns).toBe(2);
		expect(lifecycle.codes).toEqual(["x = 1", "x = 2"]);
	});

	it("shuts the kernel down even when the cell throws", async () => {
		using tempDir = TempDir.createSync("@veyyon-jl-kernel-mode-");
		const lifecycle = stubKernels({ fail: true });

		await expect(executeJulia("error()", { kernelMode: "per-call", cwd: tempDir.path() })).rejects.toThrow(
			"the cell blew up",
		);

		expect(lifecycle.shutdowns).toBe(1);
	});
});

describe("Julia session kernel mode", () => {
	it("reuses one kernel across cells, which stays the default", async () => {
		using tempDir = TempDir.createSync("@veyyon-jl-kernel-mode-");
		const lifecycle = stubKernels();

		await executeJulia("x = 1", { cwd: tempDir.path(), sessionId: "julia:reuse" });
		await executeJulia("x + 1", { kernelMode: "session", cwd: tempDir.path(), sessionId: "julia:reuse" });

		expect(lifecycle.starts).toBe(1);
		expect(lifecycle.shutdowns).toBe(0);
	});
});

describe("the settings behind the mode", () => {
	/**
	 * A mode the executor supports but no setting exposes is not a feature. These assert the operator
	 * surface: the same values and the same default as Python, so `ruby.kernelMode` means what a reader
	 * who has only seen `python.kernelMode` expects it to mean.
	 */
	it("declares ruby.kernelMode and julia.kernelMode with Python's values and default", () => {
		const python = EDITING_SETTINGS["python.kernelMode"];

		for (const key of ["ruby.kernelMode", "julia.kernelMode"] as const) {
			const setting = EDITING_SETTINGS[key];
			expect(setting.type).toBe("enum");
			expect(setting.default).toBe("session");
			expect([...setting.values]).toEqual([...python.values]);
			expect([...setting.values]).toEqual(["session", "per-call"]);
		}
	});

	it("puts all three on the same settings tab and group, so they are found together", () => {
		const groups = (["python.kernelMode", "ruby.kernelMode", "julia.kernelMode"] as const).map(key => {
			const ui = EDITING_SETTINGS[key].ui;
			return `${ui.tab}/${ui.group}`;
		});

		expect(groups).toEqual(["shell/Eval & Runtimes", "shell/Eval & Runtimes", "shell/Eval & Runtimes"]);
	});

	/**
	 * The wiring, asserted on the source because reaching it needs a live `ToolSession` and a real kernel.
	 * A setting nothing reads is the exact defect this row was about: without these lines the executors
	 * would support `per-call` and no operator could ever select it.
	 */
	it("is read by each backend, so setting it reaches the executor", async () => {
		const dir = path.join(import.meta.dir, "../../src/eval");
		const ruby = await Bun.file(path.join(dir, "rb/index.ts")).text();
		const julia = await Bun.file(path.join(dir, "jl/index.ts")).text();

		expect(ruby).toContain('readSetting<RubyExecutorOptions["kernelMode"]>(opts.session, "ruby.kernelMode")');
		expect(julia).toContain('readSetting<JuliaExecutorOptions["kernelMode"]>(opts.session, "julia.kernelMode")');
	});
});
