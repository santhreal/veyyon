/**
 * WHY: `VEYYON_TIMING=x veyyon` prints the startup timing tree and exits. The launch card's terminal
 * routes stderr into the log file while it holds the screen, and the tree is printed after the card
 * paints, so the run exited with the card on screen, the tree in the log and nothing on the terminal
 * it was requested on. `scripts/bench-startup.ts` reads its `ready:load` and `ready:boot` arms from
 * that output and reported no samples.
 *
 * The class: a diagnostic printed after the card paints, by a run that then gives the terminal up.
 * The case paints the real card on a pty from a hermetic home, so the routing is active, and asserts
 * the tree, its `Total` row and the exit status on the terminal output. The card's composer row is
 * asserted too: without it the run never took the terminal and the assertion would pass for the
 * wrong reason.
 *
 * Not covered: a run that keeps the TUI (`VEYYON_TIMING=1`), whose tree is appended to the log by
 * design, and `VEYYON_DEBUG_STARTUP` markers written while the card holds the terminal, which the
 * same routing sends to the log.
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@veyyon/natives";
import { ptyWrapper } from "../../../../../scripts/bench-startup";
import { BUN_CACHE_ENV, denyHostProviderAccess } from "../../helpers/hermetic-spawn-env";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");

test("an interactive VEYYON_TIMING=x run prints the timing tree on the terminal and exits 0", async () => {
	const parent = path.join(repoRoot, ".captures", "timing-exit-tests");
	await mkdir(parent, { recursive: true });
	const root = await mkdtemp(path.join(parent, "case-"));
	const exited = Promise.withResolvers<number | null>();
	let output = "";
	let target: Process | null = null;
	let deadline: NodeJS.Timeout | undefined;
	try {
		const home = path.join(root, "home");
		const config = path.join(root, "config");
		const project = path.join(root, "project");
		await mkdir(path.join(config, "profiles", "default", "agent"), { recursive: true });
		await mkdir(project);
		await mkdir(home);
		await writeFile(
			path.join(config, "config.yml"),
			"onboardingVersion: 1\nstartup:\n  checkUpdate: false\n  autoUpdate: false\n",
		);
		const env: Record<string, string | undefined> = {
			PATH: process.env.PATH,
			...BUN_CACHE_ENV,
			HOME: home,
			VEYYON_CONFIG_DIR: config,
			VEYYON_PROFILE: "",
			VEYYON_FIRST_FRAME_CACHE: path.join(root, "frame.json"),
			VEYYON_TIMING: "x",
			XDG_CONFIG_HOME: path.join(home, ".config"),
			XDG_CACHE_HOME: path.join(home, ".cache"),
			XDG_DATA_HOME: path.join(home, ".local/share"),
			XDG_STATE_HOME: path.join(home, ".local/state"),
			TERM: "xterm-256color",
			LANG: "C.UTF-8",
		};
		denyHostProviderAccess(env);
		const wrapper = ptyWrapper(
			process.execPath,
			[path.join(repoRoot, "packages/coding-agent/src/cli.ts"), "--no-session"],
			{ columns: 120, rows: 40 },
		);
		const child = spawn(wrapper.command, wrapper.args, { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
		child.once("error", exited.reject);
		child.once("close", code => exited.resolve(code));
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			output += chunk;
		});
		if (child.pid) target = Process.fromPid(child.pid);
		// A real deadline: the CLI is a separate process, which fake timers in this one cannot advance,
		// and a run that never exits has to fail with its output rather than outlive the test.
		deadline = setTimeout(() => exited.reject(new Error(`The timing run did not exit:\n${output}`)), 25000);

		expect(await exited.promise).toBe(0);
		expect(output).toContain("ask anything");
		expect(output).toContain("--- Startup timings (hierarchical) ---");
		expect(output).toMatch(/Total: [0-9.]+ms \(since first marker\)/);
	} finally {
		clearTimeout(deadline);
		if (target) await target.terminate({ gracefulMs: 500, timeoutMs: 2000 });
		await rm(root, { recursive: true, force: true });
	}
}, 30000);
