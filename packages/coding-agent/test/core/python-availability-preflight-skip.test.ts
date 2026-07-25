/**
 * `checkPythonKernelAvailability`: when the interpreter preflight is skipped, and why
 * no test needs to set `VEYYON_PYTHON_SKIP_CHECK` to get that.
 *
 * Why this suite exists: six test files used to set `VEYYON_PYTHON_SKIP_CHECK=1` on
 * the process environment so their fake kernels would not be blocked by a real
 * interpreter probe. Every one of those writes was redundant, because the same
 * function already short-circuits under `bun test`, and every one of them leaked the
 * flag into whatever file ran next in the same process (`scripts/find-test-leaks.ts`
 * reported `left behind env.VEYYON_PYTHON_SKIP_CHECK: (unset) -> 1` for all six). The
 * writes are gone; this suite is what keeps them from coming back, by pinning the
 * behaviour they were compensating for.
 *
 * Both inputs to the short-circuit are asserted, because deleting the flag writes is
 * only safe if the runtime signal really is sufficient, and the flag itself is a
 * documented operator escape hatch (`docs/environment-variables.md`) that must keep
 * working for someone who is not running tests at all.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { checkPythonKernelAvailability } from "@veyyon/coding-agent/eval/py/kernel";

/**
 * An interpreter path that cannot exist, so a real probe is guaranteed to fail. Any
 * `ok: true` for this path proves the probe was skipped rather than merely lucky:
 * the developer's machine having a working `python3` cannot make this pass.
 */
const IMPOSSIBLE_INTERPRETER = "/nonexistent/veyyon-preflight-skip-probe/python3";

const nodeEnvBefore = process.env.NODE_ENV;
const bunEnvBefore = process.env.BUN_ENV;
const flagBefore = process.env.VEYYON_PYTHON_SKIP_CHECK;

/**
 * This suite is the one place allowed to move these variables, and it puts all three
 * back after every test. A suite that pins "do not leak a global" would be absurd if
 * it leaked one itself, and `scripts/find-test-leaks.ts` runs over this file too.
 */
afterEach(() => {
	restore("NODE_ENV", nodeEnvBefore);
	restore("BUN_ENV", bunEnvBefore);
	restore("VEYYON_PYTHON_SKIP_CHECK", flagBefore);
});

function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** Makes the process look like ordinary (non-test) operation to `isBunTestRuntime`. */
function leaveTestRuntime(): void {
	delete process.env.NODE_ENV;
	delete process.env.BUN_ENV;
}

describe("checkPythonKernelAvailability under the test runtime", () => {
	/**
	 * The claim that made deleting six flag writes safe: with the flag absent, an
	 * interpreter that cannot possibly work is still reported available, because
	 * `bun test` sets `NODE_ENV=test` and the probe never runs.
	 */
	it("reports available without probing when no flag is set", async () => {
		delete process.env.VEYYON_PYTHON_SKIP_CHECK;
		expect(process.env.NODE_ENV).toBe("test");

		const result = await checkPythonKernelAvailability(os.tmpdir(), IMPOSSIBLE_INTERPRETER);

		expect(result).toEqual({ ok: true });
	});

	/**
	 * The short-circuit returns exactly `{ ok: true }` and nothing else. A caller that
	 * read `result.pythonPath` or `result.runtime` would get `undefined` here, so the
	 * shape is part of the contract rather than an accident of one code path.
	 */
	it("returns no interpreter path or runtime with the short-circuit result", async () => {
		delete process.env.VEYYON_PYTHON_SKIP_CHECK;

		const result = await checkPythonKernelAvailability(os.tmpdir());

		expect(result.ok).toBe(true);
		expect(result.pythonPath).toBeUndefined();
		expect(result.runtime).toBeUndefined();
		expect(result.reason).toBeUndefined();
		expect(Object.keys(result)).toEqual(["ok"]);
	});

	/** Setting the flag on top of the test runtime is simply redundant, not different:
	 *  the six files that did it got the identical result they would have got anyway. */
	it("gives the identical result whether or not the flag is set", async () => {
		delete process.env.VEYYON_PYTHON_SKIP_CHECK;
		const withoutFlag = await checkPythonKernelAvailability(os.tmpdir(), IMPOSSIBLE_INTERPRETER);

		process.env.VEYYON_PYTHON_SKIP_CHECK = "1";
		const withFlag = await checkPythonKernelAvailability(os.tmpdir(), IMPOSSIBLE_INTERPRETER);

		expect(withFlag).toEqual(withoutFlag);
	});
});

describe("checkPythonKernelAvailability outside the test runtime", () => {
	/**
	 * The flag's real job, for the operator the docs describe: with neither `NODE_ENV`
	 * nor `BUN_ENV` saying `test`, `VEYYON_PYTHON_SKIP_CHECK=1` still bypasses the
	 * probe. Deleting the test-only writes must not quietly retire the escape hatch.
	 */
	it("honours the flag when the runtime is not a test runtime", async () => {
		leaveTestRuntime();
		process.env.VEYYON_PYTHON_SKIP_CHECK = "1";

		const result = await checkPythonKernelAvailability(os.tmpdir(), IMPOSSIBLE_INTERPRETER);

		expect(result).toEqual({ ok: true });
	});

	/**
	 * The negative twin, which is what makes the two positives above mean anything: with
	 * the runtime signal gone AND the flag absent, the impossible interpreter is probed
	 * for real and reported unavailable with a reason. If this test ever passed as
	 * `ok: true`, the short-circuit would be unconditional and every assertion in this
	 * file would be vacuous.
	 */
	it("probes and fails closed with a reason when neither signal is present", async () => {
		leaveTestRuntime();
		delete process.env.VEYYON_PYTHON_SKIP_CHECK;

		const result = await checkPythonKernelAvailability(os.tmpdir(), IMPOSSIBLE_INTERPRETER);

		expect(result.ok).toBe(false);
		expect(result.reason).toBeTruthy();
		expect(result.pythonPath).toBeUndefined();
	});

	/** `0`, empty, and any non-truthy value are not "skip": a flag parsed loosely would
	 *  turn an operator's `VEYYON_PYTHON_SKIP_CHECK=0` into a silent bypass. */
	it("does not treat a falsy flag value as skip", async () => {
		leaveTestRuntime();
		process.env.VEYYON_PYTHON_SKIP_CHECK = "0";

		const result = await checkPythonKernelAvailability(os.tmpdir(), IMPOSSIBLE_INTERPRETER);

		expect(result.ok).toBe(false);
	});
});
