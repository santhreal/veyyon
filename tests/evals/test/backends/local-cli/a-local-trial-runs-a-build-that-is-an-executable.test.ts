/**
 * WHY: `--build` names a source tree or an executable, and the veyyon harness runs a file as the
 * executable itself. The sandbox hid `<build>/tests` whatever the build was, and granting a file
 * with a hidden path beneath its name listed the file as a directory: every trial of an executable
 * build failed with ENOTDIR before its agent started, on every host, sandboxed or not.
 *
 * The case runs the real backend and the real veyyon harness with a build that is an executable
 * script standing in for a compiled binary. It prints one answered request whatever arguments the
 * harness passes, and the trial is asserted to run it and grade what it printed.
 *
 * A build the harness cannot run is refused by the backend's preflight, before a trial pays for it:
 * a tree without the CLI a tree runs, and a file that is not executable.
 *
 * Not caught: a compiled binary that needs files beside it the sandbox does not grant.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { LocalCliBackend, localTrialLayout } from "../../../backends/local-cli/main";
import { LOCAL_TRIAL_FILES } from "../../../engine/run/layout";
import { veyyonAdapter } from "../../../harnesses/veyyon";
import { oneTrialRun } from "./probe-fixtures";

const ANSWER = {
	type: "message_end",
	message: {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "ran the executable" }],
		usage: { input: 3, output: 2 },
	},
};

describe("a local trial whose build is an executable", () => {
	it.skipIf(process.platform === "win32")("runs it and grades what it printed", async () => {
		await using dir = await TempDir.create("@evals-local-cli-executable-");
		const executable = dir.join("vey");
		await fs.writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(ANSWER)}'\n`, { mode: 0o755 });
		const { context, cell } = oneTrialRun({
			root: dir.path(),
			suite: "executable-probe",
			harness: veyyonAdapter,
			build: executable,
		});
		const backend = new LocalCliBackend();
		expect(await backend.preflight(context)).toEqual({ ok: true });

		const artifacts = await backend.runTrial(cell, context);

		expect(artifacts.extra?.build).toBe(executable);
		expect(artifacts.usage?.extra).toEqual({ turns: 1, toolCalls: 0 });
		const layout = localTrialLayout(context.runsDir, context.runId, cell);
		expect(await fs.readFile(path.join(layout.trialDir, LOCAL_TRIAL_FILES.answer), "utf8")).toBe(
			"ran the executable",
		);
	});
});

describe("a build the harness cannot run", () => {
	for (const [label, shape, reason] of [
		["a tree without the CLI", "tree", "without packages/coding-agent/src/cli.ts"],
		["a file that is not executable", "file", "not executable"],
	] as const) {
		it.skipIf(process.platform === "win32")(`is refused before a trial starts: ${label}`, async () => {
			await using dir = await TempDir.create("@evals-local-cli-bad-build-");
			const build = dir.join("build");
			if (shape === "tree") await fs.mkdir(path.join(build, "packages"), { recursive: true });
			else await fs.writeFile(build, "#!/bin/sh\n", { mode: 0o644 });
			const { context } = oneTrialRun({ root: dir.path(), suite: "bad-build-probe", harness: veyyonAdapter, build });

			const verdict = await new LocalCliBackend().preflight(context);

			expect(verdict).toEqual({
				ok: false,
				reason: expect.stringContaining(reason),
				missingRequirements: ["build"],
			});
		});
	}
});
