/**
 * WHY: a local-cli trial runs its agent in a process group of its own, in a scratch directory that
 * holds the model provider's credential. A run that is cancelled mid-trial must end that group, keep
 * what the agent printed, and delete the scratch; a trial that returned early instead left a Chrome
 * and an agent running against the provider, and a credential copy on disk.
 *
 * The case runs the real backend with a harness whose command states its pid and never finishes,
 * cancels the run's signal once the agent is up, and asserts the trial reports the cancellation, the
 * agent is gone, its output is in the record, and the scratch is not on disk.
 *
 * Not caught: a descendant that leaves the agent's process group (a daemon that calls setsid), which
 * no group signal reaches.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TempDir } from "@veyyon/utils";
import { LocalCliBackend, localTrialLayout } from "../../../backends/local-cli/main";
import { landlockSandbox } from "../../../backends/local-cli/sandbox";
import type { RunContext, Variant } from "../../../engine/contracts";
import { kitTask } from "../../../engine/kit/catalog";
import { defineSuite } from "../../../engine/kit/suite";
import { LOCAL_TRIAL_FILES } from "../../../engine/run/layout";
import { lookup, probeHarness, writeCredentials } from "./probe-fixtures";

/** An agent that states its pid on stdout and in its working directory, then never finishes. */
const HUNG = `import * as fs from "node:fs";
console.log(JSON.stringify({ type: "agent_pid", pid: process.pid }));
fs.writeFileSync("agent.pid", String(process.pid));
setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("a cancelled local trial", () => {
	it.skipIf(process.platform === "win32")("ends its agent, keeps its output and deletes its scratch", async () => {
		await using dir = await TempDir.create("@evals-local-cli-cancel-");
		const tree = dir.join("tree");
		await fs.mkdir(tree, { recursive: true });
		await fs.writeFile(path.join(tree, "hang.ts"), HUNG);
		const authDb = dir.join("agent.db");
		writeCredentials(authDb);
		const runsDir = dir.join("runs");
		const runId = `cancel-${path.basename(dir.path())}`;
		const cell = { variant: "arm", suite: "cancel-probe", task: "hang", repeat: 1 };
		const layout = localTrialLayout(runsDir, runId, cell);

		const task = kitTask<Record<string, never>>({
			id: "hang",
			title: "hang",
			capabilities: ["probe"],
			difficulty: "easy",
			start: async () => ({ instruction: "hang", solve: async () => "", finish: async () => ({}) }),
			checks: [{ id: "never", description: "never", pass: () => false }],
		});
		const variant: Variant = {
			name: "arm",
			harness: "probe",
			configPath: null,
			promptVariantPath: null,
			model: "probe/model",
			attachments: [],
			build: tree,
		};
		const controller = new AbortController();
		const context: RunContext = {
			runId,
			suite: defineSuite({
				id: "cancel-probe",
				version: "1.0.0",
				displayName: "Cancel probe",
				description: "one task whose agent hangs",
				sourceDir: tree,
				capabilities: { probe: "probe" },
				tasks: [task],
				tools: [],
				defaultTimeBudgetSec: 120,
			}),
			workDir: dir.path(),
			runsDir,
			signal: controller.signal,
			harnesses: lookup(probeHarness(tree, "hang.ts")),
			options: { variants: [variant], authDb, ...(landlockSandbox().usable ? {} : { unsandboxed: true }) },
		};

		const trial = new LocalCliBackend().runTrial(cell, context);
		const outcome = trial.then(
			() => "returned",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		// Bounded, so a trial that never starts fails here rather than hanging the suite.
		let pid = "";
		for (let waited = 0; waited < 30_000 && !pid; waited += 100) {
			pid = await fs.readFile(path.join(layout.workspace, "agent.pid"), "utf8").catch(() => "");
			if (!pid) await sleep(100);
		}
		expect(pid).not.toBe("");
		controller.abort();

		expect(await outcome).toContain("aborted");
		expect(alive(Number(pid))).toBe(false);
		const events = await fs.readFile(path.join(layout.trialDir, LOCAL_TRIAL_FILES.events), "utf8");
		expect(JSON.parse(events.split("\n")[0] ?? "{}")).toEqual({ type: "agent_pid", pid: Number(pid) });
		expect(await fs.readFile(path.join(layout.trialDir, "workspace", "agent.pid"), "utf8")).toBe(pid);
		expect(await fs.stat(layout.scratch).catch(() => null)).toBeNull();
	});
});
