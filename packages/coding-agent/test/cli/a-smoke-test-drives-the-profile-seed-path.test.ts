import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { smokeTestProfileSeed } from "../../src/cli/profile-seed-smoke";
import * as workerClient from "../../src/subprocess/worker-client";

/**
 * `veyyon --smoke-test` runs the profile seed path through the shipped artifact.
 *
 * WHY THIS SUITE EXISTS. 1.4.1 shipped `profile new` broken (`awaitPromise is not defined`, a
 * dynamic `import("bun")` the minifier fused) while `--version`, `--help` and the worker probes
 * all passed: the profile chunk is loaded by none of them. The smoke now re-enters the CLI as
 * `profile new <name> --json` against a scratch config root and checks the copied settings file.
 *
 * CLASS. A smoke probe that reports success without having executed the path it stands for. The
 * rows here pin that the probe runs the real child, that it fails when the child exits non-zero,
 * and that it fails when the child prints something other than the created profile.
 *
 * DOES NOT CATCH. The bundler defect itself: this runs the source entry, not a compiled binary.
 * `scripts/install-tests/run-ci.sh` drives `profile new` against the built artifact.
 */

describe("the smoke test drives the profile seed path", () => {
	afterEach(() => {
		spyOn(workerClient, "resolveWorkerSpawnCmd").mockRestore();
	});

	it("creates the profile through a real `profile new` child and clears the copied display name", async () => {
		await expect(smokeTestProfileSeed()).resolves.toBeUndefined();
	}, 60_000);

	it("fails when the child exits non-zero, quoting its stderr", async () => {
		spyOn(workerClient, "resolveWorkerSpawnCmd").mockReturnValue({
			cmd: [process.execPath, "-e", 'process.stderr.write("seed exploded"); process.exit(7);'],
		});
		await expect(smokeTestProfileSeed()).rejects.toThrow("`profile new` exited 7: seed exploded");
	});

	it("fails when the child prints something other than the created profile", async () => {
		spyOn(workerClient, "resolveWorkerSpawnCmd").mockReturnValue({
			cmd: [process.execPath, "-e", 'process.stdout.write("{\\"name\\":\\"other\\"}");'],
		});
		await expect(smokeTestProfileSeed()).rejects.toThrow("unexpected `profile new --json` output");
	});
});
