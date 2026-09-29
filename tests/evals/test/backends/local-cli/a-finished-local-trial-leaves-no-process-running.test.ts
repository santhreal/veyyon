/**
 * WHY: a local-cli trial runs its agent in a process group of its own. A deadline and a cancel end
 * that group, but an agent that exited on its own left whatever it had started running: a server on
 * a port the next trial binds, a shell loop, a process holding the trial's sandbox. It outlived the
 * trial and the scratch it worked in, and the next trial could reach it. A process the agent started
 * in a session of its own (a browser a launcher detaches, a kernel that calls setsid) left the group
 * and escaped every group signal.
 *
 * The cases run the real backend with a harness whose command starts a long-running child, states
 * the child's pid, answers, and exits 0: once with the child in the agent's group, and once with the
 * child in a new session, which the Landlock launcher reaps as the trial's subreaper. Each asserts the
 * trial settles and the child is gone.
 *
 * A host without Landlock runs the same launcher with no rules, so the session case is also driven
 * through the launch line `sandboxedLaunch` builds for such a host.
 *
 * Not caught: a host with no python3, where no launcher runs at all.
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { $which, TempDir } from "@veyyon/utils";
import { LocalCliBackend, localTrialLayout } from "../../../backends/local-cli/main";
import { landlockSandbox, sandboxedLaunch } from "../../../backends/local-cli/sandbox";
import { oneTrialRun, probeHarness } from "./probe-fixtures";

/** Starts a child, in the agent's group or a session of its own, states its pid, answers, and exits. */
function leavesAChild(detached: boolean): string {
	return `import { spawn } from "node:child_process";
import * as fs from "node:fs";
const child = spawn("sleep", ["600"], { stdio: "ignore", detached: ${detached} });
child.unref();
fs.writeFileSync("child.pid", String(child.pid));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1 } } }));
`;
}

/** Whether `pid` is a live process. A zombie waiting on its reaper has already died. */
function running(pid: number): boolean {
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return false;
	}
	// The state follows the parenthesised command name, which may hold parentheses itself.
	const state = stat.charAt(stat.lastIndexOf(")") + 2);
	return state !== "Z" && state !== "X";
}

describe("a local trial whose agent exits on its own", () => {
	for (const [where, detached, skip] of [
		["in its group", false, process.platform !== "linux"],
		["in a session of its own", true, !landlockSandbox().usable],
	] as const) {
		it.skipIf(skip)(`ends a process the agent left ${where}`, async () => {
			await using dir = await TempDir.create("@evals-local-cli-orphan-");
			const tree = dir.join("tree");
			await fs.mkdir(tree, { recursive: true });
			await fs.writeFile(path.join(tree, "agent.ts"), leavesAChild(detached));
			const { context, cell } = oneTrialRun({
				root: dir.path(),
				suite: "orphan-probe",
				harness: probeHarness(tree, "agent.ts"),
				build: tree,
			});
			const layout = localTrialLayout(context.runsDir, context.runId, cell);

			const artifacts = await new LocalCliBackend().runTrial(cell, context);

			expect(artifacts.extra?.exitCode).toBe(0);
			const child = Number(await fs.readFile(path.join(layout.trialDir, "workspace", "child.pid"), "utf8"));
			expect(child).toBeGreaterThan(0);
			try {
				// Bounded: a survivor keeps this loop to its limit and fails below.
				for (let waited = 0; waited < 2_000 && running(child); waited += 20) await sleep(20);
				expect(running(child)).toBe(false);
			} finally {
				if (running(child)) process.kill(child, "SIGKILL");
			}
		});
	}
});

describe("an agent launched on a host without Landlock", () => {
	const python = process.platform === "linux" ? $which("python3") : null;
	it.skipIf(!python)("still has the process it left in a session of its own ended", async () => {
		await using dir = await TempDir.create("@evals-local-cli-no-rules-");
		const agent = dir.join("agent.ts");
		await fs.writeFile(agent, leavesAChild(true));
		const launch = sandboxedLaunch(
			{ usable: false, reason: "no Landlock", python: python ?? "" },
			[],
			process.execPath,
			[agent],
		);
		const child = spawn(launch.command, [...launch.args], { cwd: dir.path(), stdio: ["ignore", "pipe", "ignore"] });
		const exited = Promise.withResolvers<number | null>();
		child.on("close", code => exited.resolve(code));

		expect(await exited.promise).toBe(0);
		const orphan = Number(await fs.readFile(dir.join("child.pid"), "utf8"));
		expect(orphan).toBeGreaterThan(0);
		try {
			// Bounded: a survivor keeps this loop to its limit and fails below.
			for (let waited = 0; waited < 2_000 && running(orphan); waited += 20) await sleep(20);
			expect(running(orphan)).toBe(false);
		} finally {
			if (running(orphan)) process.kill(orphan, "SIGKILL");
		}
	});
});
