/**
 * WHY: after a SIGINT or SIGTERM, postmortem exits the process 10 s later whatever is still running.
 * A local-cli trial's teardown after a cancel was bounded by the normal limits: 5 s for the agent to
 * exit on SIGTERM, 2 s of output drain and 30 s for the suite's finish. A suite whose finish was slow
 * held the teardown past the 10 s, the process exited in the middle of it, and the trial's scratch,
 * with its copy of the model provider's sign-in, stayed on disk.
 *
 * The case runs one trial of a hanging agent under `runUnderSignals` in a child process, with a suite
 * whose finish never returns, sends the process SIGTERM once the agent is up, and asserts the process
 * exits with SIGTERM's code and the scratch is gone.
 *
 * Not caught: a teardown step with no bound of its own that outlasts the 10 s.
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TempDir } from "@veyyon/utils";

const EVALS = path.join(import.meta.dirname, "..", "..", "..");

/** An agent that states its pid in its working directory and never finishes. */
const HUNG = `import * as fs from "node:fs";
fs.writeFileSync("agent.pid", String(process.pid));
setInterval(() => {}, 1000);
`;

/** One trial under `runUnderSignals`, whose suite's finish never returns. Prints the trial's scratch. */
function script(root: string, tree: string): string {
	return `import { LocalCliBackend, localTrialLayout } from ${JSON.stringify(path.join(EVALS, "backends", "local-cli", "main.ts"))};
import { runUnderSignals } from ${JSON.stringify(path.join(EVALS, "engine", "run", "interrupt.ts"))};
import { oneTrialRun, probeHarness } from ${JSON.stringify(path.join(import.meta.dirname, "probe-fixtures.ts"))};
await runUnderSignals(
	"slow-finish-probe",
	async signal => {
		const { context, cell } = oneTrialRun({
			root: ${JSON.stringify(root)},
			suite: "slow-finish-probe",
			harness: probeHarness(${JSON.stringify(tree)}, "hang.ts"),
			build: ${JSON.stringify(tree)},
			signal,
			finish: () => Promise.withResolvers<Record<string, never>>().promise,
		});
		const layout = localTrialLayout(context.runsDir, context.runId, cell);
		console.log(JSON.stringify({ scratch: layout.scratch, workspace: layout.workspace }));
		await new LocalCliBackend().runTrial(cell, context).catch(() => {});
	},
	() => {},
);
`;
}

describe("a local trial whose run is signalled", () => {
	it.skipIf(process.platform === "win32")(
		"removes its scratch before the process exits, however slow the suite's finish",
		async () => {
			await using dir = await TempDir.create("@evals-local-cli-signalled-");
			const tree = dir.join("tree");
			await fs.mkdir(tree, { recursive: true });
			await fs.writeFile(path.join(tree, "hang.ts"), HUNG);
			const file = dir.join("run.ts");
			await fs.writeFile(file, script(dir.path(), tree));

			const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] });
			const exited = Promise.withResolvers<number | null>();
			child.on("close", code => exited.resolve(code));
			const stated = Promise.withResolvers<{ scratch: string; workspace: string }>();
			let printed = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				printed += chunk;
				const line = printed.split("\n").find(entry => entry.startsWith("{"));
				if (line) stated.resolve(JSON.parse(line));
			});
			const { scratch, workspace } = await stated.promise;
			// Bounded, so an agent that never starts fails here rather than hanging the suite.
			let started = false;
			for (let waited = 0; waited < 30_000 && !started; waited += 100) {
				started = (await fs.stat(path.join(workspace, "agent.pid")).catch(() => null)) !== null;
				if (!started) await sleep(100);
			}
			expect(started).toBe(true);

			child.kill("SIGTERM");

			expect(await exited.promise).toBe(143);
			expect(await fs.stat(scratch).catch(() => null)).toBeNull();
		},
	);
});
