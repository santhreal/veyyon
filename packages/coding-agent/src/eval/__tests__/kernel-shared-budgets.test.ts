/**
 * Every eval kernel takes its shutdown and interrupt budgets, and its two naming conventions, from one owner.
 *
 * `kernel-base.ts` already owned `DEFAULT_KERNEL_STARTUP_TIMEOUT_MS` and its doc gave the reason: "the shared
 * value lives here so raising the floor is one edit rather than one edit per language". Three sibling values
 * did not follow it.
 *
 *   SHUTDOWN_GRACE_MS = 1_000        py/kernel.ts, rb/kernel.ts, jl/kernel.ts, AND jl/executor.ts
 *   INTERRUPT_ESCALATION_MS = 5_000  py/kernel.ts, rb/kernel.ts, jl/kernel.ts
 *   TRACE_IPC                        each kernel built `VEYYON_<LANG>_IPC_TRACE` itself
 *   RUNNER_CACHE_DIR                 each kernel joined `<tmpdir>/veyyon-<lang>-runner` itself
 *
 * The two budgets are the same decision typed three or four times, so raising one is an edit nothing checks:
 * the Julia executor's session reset held a FOURTH copy of the shutdown grace, meaning a language given a
 * longer shutdown in its kernel would still have been killed at one second when its session was reset.
 *
 * The two conventions are worse than duplication, because they are product surface. `VEYYON_RUBY_IPC_TRACE`
 * is a name a user types, and with each kernel formatting its own there was nothing anywhere stating the
 * convention and no reason a fourth language would follow it. Same for the runner cache directory: the layout
 * under the temp directory was a coincidence, so a stale-runner cleanup had nothing to ask.
 *
 * These tests hold the arrangement behaviourally (the helpers produce the exact names the three languages
 * already use, and the path helper is separator-correct) and structurally (nobody retypes a budget, and every
 * kernel imports the owner).
 */

import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_KERNEL_STARTUP_TIMEOUT_MS,
	KERNEL_INTERRUPT_ESCALATION_MS,
	KERNEL_SHUTDOWN_GRACE_MS,
	kernelIpcTraceEnvVar,
	kernelRunnerCacheDir,
} from "../kernel-base";

const EVAL_SRC = path.resolve(import.meta.dir, "..");
const KERNELS = ["py/kernel.ts", "rb/kernel.ts", "jl/kernel.ts"];

describe("the shared kernel budgets", () => {
	/**
	 * One second for an interpreter to flush and unwind before it is killed. Pinned because it was four
	 * separate literals, and because a value that drifts here does not fail: a kernel simply gets killed
	 * earlier than intended and whatever it was flushing is lost.
	 */
	it("gives a kernel one second to shut down on its own", () => {
		expect(KERNEL_SHUTDOWN_GRACE_MS).toBe(1_000);
	});

	/**
	 * Five seconds for an interrupt to land before the kernel is terminated. This is the budget behind Ctrl-C
	 * in an eval cell, so the number describes a user's patience rather than anything about an interpreter,
	 * which is exactly why it should never have been per-language.
	 */
	it("gives an interrupt five seconds before escalating to termination", () => {
		expect(KERNEL_INTERRUPT_ESCALATION_MS).toBe(5_000);
	});

	/**
	 * The escalation budget has to exceed the shutdown grace, or escalation would fire while the polite
	 * shutdown it escalates to was still within its own window, and a kernel would be killed for being slow
	 * to do the thing it had not yet been asked to do.
	 */
	it("leaves the escalation window wider than the shutdown grace", () => {
		expect(KERNEL_INTERRUPT_ESCALATION_MS).toBeGreaterThan(KERNEL_SHUTDOWN_GRACE_MS);
	});

	/** The startup floor this module already owned, asserted here so the three budgets are read together. */
	it("keeps the startup floor the widest of the three", () => {
		expect(DEFAULT_KERNEL_STARTUP_TIMEOUT_MS).toBe(10_000);
		expect(DEFAULT_KERNEL_STARTUP_TIMEOUT_MS).toBeGreaterThan(KERNEL_INTERRUPT_ESCALATION_MS);
	});
});

describe("the IPC trace variable convention", () => {
	/**
	 * The exact names the three languages already used, so the helper is a statement of the existing
	 * convention rather than a new one. A user with `VEYYON_PYTHON_IPC_TRACE` set keeps working.
	 */
	it("produces the name each language already used", () => {
		expect(kernelIpcTraceEnvVar("PYTHON")).toBe("VEYYON_PYTHON_IPC_TRACE");
		expect(kernelIpcTraceEnvVar("RUBY")).toBe("VEYYON_RUBY_IPC_TRACE");
		expect(kernelIpcTraceEnvVar("JULIA")).toBe("VEYYON_JULIA_IPC_TRACE");
	});

	/** The prefix and suffix are the convention, and a fourth language gets them without being told. */
	it("wraps any language in the VEYYON prefix and IPC_TRACE suffix", () => {
		expect(kernelIpcTraceEnvVar("LUA")).toBe("VEYYON_LUA_IPC_TRACE");
	});

	/**
	 * The variable name is uppercase and the directory name is not: the directories are `py`, `rb` and `jl`
	 * while the variables say `PYTHON`, `RUBY` and `JULIA`. Recorded because it is the mistake a fourth
	 * language makes, and the helper cannot catch it.
	 */
	it("takes the uppercase language name, which is not the directory name", () => {
		expect(kernelIpcTraceEnvVar("PYTHON")).not.toBe(kernelIpcTraceEnvVar("PY"));
	});
});

describe("the runner cache directory convention", () => {
	/** The exact directories the three languages already used, so an existing cached runner is still found. */
	it("produces the directory each language already used", () => {
		expect(kernelRunnerCacheDir("/tmp", "python")).toBe(path.join("/tmp", "veyyon-python-runner"));
		expect(kernelRunnerCacheDir("/tmp", "ruby")).toBe(path.join("/tmp", "veyyon-ruby-runner"));
		expect(kernelRunnerCacheDir("/tmp", "julia")).toBe(path.join("/tmp", "veyyon-julia-runner"));
	});

	/**
	 * Joined with `path.join`, not with a slash. The three call sites used `path.join`, and a helper that
	 * concatenated would produce a mixed-separator path on Windows for every kernel at once, which is the
	 * failure mode a unification is supposed to make impossible rather than universal.
	 */
	it("joins with the platform separator rather than a literal slash", () => {
		const joined = kernelRunnerCacheDir(os.tmpdir(), "python");
		expect(joined).toBe(path.join(os.tmpdir(), "veyyon-python-runner"));
		expect(path.basename(joined)).toBe("veyyon-python-runner");
		expect(path.dirname(joined)).toBe(os.tmpdir());
	});

	/** Each language gets its own directory, so two kernels cannot overwrite one another's runner script. */
	it("gives each language a distinct directory", () => {
		const dirs = ["python", "ruby", "julia"].map(language => kernelRunnerCacheDir("/tmp", language));
		expect(new Set(dirs).size).toBe(3);
	});
});

describe("no kernel retypes a shared budget", () => {
	async function evalSources(): Promise<Array<{ file: string; text: string }>> {
		const files = [...new Bun.Glob("**/*.ts").scanSync(EVAL_SRC)]
			.map(file => file.split(path.sep).join("/"))
			.filter(file => !file.startsWith("__tests__/"))
			.sort();
		return await Promise.all(
			files.map(async file => ({ file, text: await Bun.file(path.join(EVAL_SRC, file)).text() })),
		);
	}

	/**
	 * The ratchet. The old names were `SHUTDOWN_GRACE_MS` and `INTERRUPT_ESCALATION_MS`, and the fourth copy
	 * of the first one lived in an EXECUTOR rather than a kernel, which is why this scans the whole `eval`
	 * tree instead of the three kernel files.
	 */
	it("declares neither retired budget name anywhere under eval", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await evalSources()) {
			for (const name of ["SHUTDOWN_GRACE_MS", "INTERRUPT_ESCALATION_MS"]) {
				if (new RegExp(`^\\s*(?:export )?const ${name}\\b`, "m").test(text)) {
					offenders.push(`${file} declares ${name}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The non-vacuity twin: prove the scan reaches the four modules the copies lived in, so a broken glob
	 * cannot satisfy the case above by reading nothing.
	 */
	it("scans the four modules the copies lived in", async () => {
		const files = (await evalSources()).map(entry => entry.file);
		for (const file of [...KERNELS, "jl/executor.ts"]) {
			expect(files).toContain(file);
		}
	});

	/** And each kernel takes both budgets and both helpers from the owner. */
	it("has every kernel importing the owner's budgets and conventions", async () => {
		for (const kernel of KERNELS) {
			const text = await Bun.file(path.join(EVAL_SRC, kernel)).text();
			for (const name of [
				"KERNEL_SHUTDOWN_GRACE_MS",
				"KERNEL_INTERRUPT_ESCALATION_MS",
				"kernelIpcTraceEnvVar",
				"kernelRunnerCacheDir",
			]) {
				expect(text).toContain(name);
			}
			expect(text).toMatch(/from "\.\.\/kernel-base";/);
		}
	});

	/**
	 * The Julia executor's session reset is the copy that was easiest to miss, because nothing about an
	 * executor suggests it holds a kernel lifecycle budget. It is asserted separately so the reason it is
	 * covered survives in the suite.
	 */
	it("has the Julia executor's session reset using the shared shutdown grace", async () => {
		const text = await Bun.file(path.join(EVAL_SRC, "jl/executor.ts")).text();
		expect(text).toContain("KERNEL_SHUTDOWN_GRACE_MS");
		expect(text).toMatch(/from "\.\.\/kernel-base";/);
	});
});
