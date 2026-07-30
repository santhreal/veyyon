import { afterEach, expect, it } from "bun:test";
import * as path from "node:path";
import { disposeJuliaKernelSessionsByOwner, executeJulia } from "@veyyon/coding-agent/eval/jl/executor";
import { disposeKernelSessionsByOwner, executePython } from "@veyyon/coding-agent/eval/py/executor";
import { TempDir } from "@veyyon/utils";
import { describeRequiringTool } from "../../../utils/test/helpers/requires-tool";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

const PYTHON_OWNER = "kernel-crash-recovery-python";
const JULIA_OWNER = "kernel-crash-recovery-julia";

afterEach(async () => {
	await Promise.all([disposeKernelSessionsByOwner(PYTHON_OWNER), disposeJuliaKernelSessionsByOwner(JULIA_OWNER)]);
}, 30_000);

describeRequiringTool("python3", "Python session kernel crash recovery", () => {
	/**
	 * A runtime process can die between accepting a cell and returning its result. The session must replace
	 * that dead process and replay the cell once, or an ordinary transient crash is mislabeled as cancellation.
	 */
	it("replaces an unexpectedly exited kernel and replays the cell once", async () => {
		using tempDir = TempDir.createSync("@veyyon-python-kernel-recovery-");
		const marker = path.join(tempDir.path(), "first-process-crashed");
		const result = await executePython(
			`from pathlib import Path\nimport os\nmarker = Path(${JSON.stringify(marker)})\nif not marker.exists():\n    marker.write_text("crashed")\n    os._exit(17)\nprint("RECOVERED")`,
			{
				cwd: tempDir.path(),
				sessionId: `python-kernel-recovery:${crypto.randomUUID()}`,
				kernelOwnerId: PYTHON_OWNER,
				reset: true,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		expect(result.output).toBe("RECOVERED\n");
		expect(await Bun.file(marker).text()).toBe("crashed");
	}, 60_000);
});

describeRequiringTool("julia", "Julia session kernel crash recovery", () => {
	/**
	 * Julia uses the same shared kernel-exit classifier as Python. This locks the original CI regression:
	 * a dead Julia process must be recreated instead of returning exitCode undefined as if the user aborted.
	 */
	it("replaces an unexpectedly exited kernel and replays the cell once", async () => {
		using tempDir = TempDir.createSync("@veyyon-julia-kernel-recovery-");
		const marker = path.join(tempDir.path(), "first-process-crashed");
		const result = await executeJulia(
			`marker = ${JSON.stringify(marker)}\nif !isfile(marker)\n    write(marker, "crashed")\n    exit(17)\nend\nprintln("RECOVERED")`,
			{
				cwd: tempDir.path(),
				sessionId: `julia-kernel-recovery:${crypto.randomUUID()}`,
				kernelOwnerId: JULIA_OWNER,
				reset: true,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		expect(result.output).toBe("RECOVERED\n");
		expect(await Bun.file(marker).text()).toBe("crashed");
	}, 90_000);
});
