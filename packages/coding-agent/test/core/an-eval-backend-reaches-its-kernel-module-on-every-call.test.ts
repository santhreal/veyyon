/**
 * An eval backend reaches its kernel and executor modules on every call.
 *
 * WHY THIS SUITE EXISTS. The three kernel backends are built by one factory,
 * `createKernelBackend`, and the descriptor passed to it is evaluated once, when the
 * backend module loads. Handing that descriptor the imported functions themselves
 * (`checkAvailability: checkPythonKernelAvailability`) froze whichever function object
 * existed at that moment, so the backend stopped reaching the kernel module and started
 * holding a copy of it. The kernel module was no longer the single definition of its own
 * availability check, and a later replacement of the export — the mechanism every suite
 * in this package uses to run the eval path without a real interpreter — was ignored by
 * the backend while appearing to take effect everywhere else. Three tests in
 * `agent-session-python-cleanup.test.ts` failed with `undefined is not an object` from
 * inside the factory, and the assertions that the executor had NOT run passed for the
 * wrong reason: the backend was calling past the replacement, straight into the real
 * executor.
 *
 * WHAT THIS COVERS. Every backend the eval barrel exports, discovered at run time, for
 * both entry points a backend owns: availability and execution. Adding a fourth language
 * turns this suite red until its kernel and executor modules are named below.
 *
 * WHAT THIS DOES NOT COVER. Whether the availability check or the executor is correct;
 * only that the backend reaches the module that defines them rather than a snapshot.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ExecutorBackend, ExecutorBackendExecOptions } from "@veyyon/coding-agent/eval";
import * as evalBarrel from "@veyyon/coding-agent/eval";
import * as juliaExecutor from "@veyyon/coding-agent/eval/jl/executor";
import * as juliaKernel from "@veyyon/coding-agent/eval/jl/kernel";
import * as pythonExecutor from "@veyyon/coding-agent/eval/py/executor";
import * as pythonKernel from "@veyyon/coding-agent/eval/py/kernel";
import * as rubyExecutor from "@veyyon/coding-agent/eval/rb/executor";
import * as rubyKernel from "@veyyon/coding-agent/eval/rb/kernel";
import { TempDir } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { makeToolSession } from "../helpers/tool-session";

useIsolatedAgentDir();

/** A backend's two module seams, named by the module object the backend must reach. */
interface KernelSeams {
	availabilityModule: Record<string, unknown>;
	availabilityExport: string;
	executorModule: Record<string, unknown>;
	executorExport: string;
}

/**
 * Backends whose runtime lives in another process and so has a kernel module. `js` runs
 * in this process and owns neither seam, which is why it is recorded here by name rather
 * than skipped by a shape test that would also skip a broken kernel backend.
 */
const SEAMS: Readonly<Record<string, KernelSeams>> = {
	python: {
		availabilityModule: pythonKernel as unknown as Record<string, unknown>,
		availabilityExport: "checkPythonKernelAvailability",
		executorModule: pythonExecutor as unknown as Record<string, unknown>,
		executorExport: "executePython",
	},
	ruby: {
		availabilityModule: rubyKernel as unknown as Record<string, unknown>,
		availabilityExport: "checkRubyKernelAvailability",
		executorModule: rubyExecutor as unknown as Record<string, unknown>,
		executorExport: "executeRuby",
	},
	julia: {
		availabilityModule: juliaKernel as unknown as Record<string, unknown>,
		availabilityExport: "checkJuliaKernelAvailability",
		executorModule: juliaExecutor as unknown as Record<string, unknown>,
		executorExport: "executeJulia",
	},
};

/** Backends with no out-of-process kernel, pinned by exact equality below. */
const NO_KERNEL_MODULE = ["js"];

function isBackend(value: unknown): value is ExecutorBackend {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ExecutorBackend>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.isAvailable === "function" &&
		typeof candidate.execute === "function"
	);
}

/** Every backend the barrel exports, taken from the barrel rather than from a list here. */
const BACKENDS: ExecutorBackend[] = Object.values(evalBarrel).filter(isBackend);

function execOptions(cwd: string, session: ReturnType<typeof makeToolSession>): ExecutorBackendExecOptions {
	return {
		cwd,
		sessionId: "kernel-module-seam",
		sessionFile: undefined,
		kernelOwnerId: undefined,
		session,
		reset: false,
		onChunk: () => {},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the backend list this suite sweeps", () => {
	/** An empty barrel would satisfy every assertion below by finding nothing to check. */
	it("finds every eval backend the barrel exports", () => {
		expect(BACKENDS.map(backend => backend.id).sort()).toEqual(["js", "julia", "python", "ruby"]);
	});

	/** A backend with no named seams and no recorded exemption is a hole, not a pass. */
	it("names a kernel module for every backend that has one", () => {
		const unaccounted = BACKENDS.map(backend => backend.id).filter(
			id => SEAMS[id] === undefined && !NO_KERNEL_MODULE.includes(id),
		);
		expect(unaccounted).toEqual([]);
		expect(NO_KERNEL_MODULE).toEqual(["js"]);
	});
});

describe.each(Object.keys(SEAMS))("the %s backend", id => {
	const seams = SEAMS[id]!;
	const backend = (): ExecutorBackend => {
		const found = BACKENDS.find(candidate => candidate.id === id);
		if (found === undefined) throw new Error(`no backend exported for ${id}`);
		return found;
	};

	it("asks its kernel module whether the runtime is available", async () => {
		using tempDir = TempDir.createSync(`@veyyon-${id}-availability-seam-`);
		let checks = 0;
		vi.spyOn(seams.availabilityModule, seams.availabilityExport).mockImplementation((async () => {
			checks += 1;
			return { ok: true };
		}) as never);

		const available = await backend().isAvailable(makeToolSession({ cwd: tempDir.path() }));

		// Once, counted here rather than read off the spy: a backend that probed twice per
		// availability check would double every interpreter launch.
		expect(checks).toBe(1);
		expect(available).toBe(true);
	});

	it("reports what its kernel module answers, rather than a value fixed at import", async () => {
		using tempDir = TempDir.createSync(`@veyyon-${id}-availability-answer-`);
		vi.spyOn(seams.availabilityModule, seams.availabilityExport).mockResolvedValue({
			ok: false,
			reason: "no interpreter",
		} as never);

		expect(await backend().isAvailable(makeToolSession({ cwd: tempDir.path() }))).toBe(false);
	});

	it("runs the cell through its executor module", async () => {
		using tempDir = TempDir.createSync(`@veyyon-${id}-executor-seam-`);
		let runs = 0;
		vi.spyOn(seams.executorModule, seams.executorExport).mockImplementation((async () => {
			runs += 1;
			return {
				output: "from the executor module",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 24,
				outputLines: 1,
				outputBytes: 24,
				displayOutputs: [],
				stdinRequested: false,
			};
		}) as never);
		const session = makeToolSession({ cwd: tempDir.path() });

		const result = await backend().execute("1 + 1", execOptions(tempDir.path(), session));

		expect(runs).toBe(1);
		expect(result.output).toBe("from the executor module");
	});
});
