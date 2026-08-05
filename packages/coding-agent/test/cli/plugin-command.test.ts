/**
 * `veyyon plugin` offline e2e: empty listing, doctor health check, and the
 * not-installed error paths. Pins the fail-closed uninstall — a never-installed
 * package must NOT report "Uninstalled" (bun uninstall exits 0 for it).
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirs("veyyon-plugin-home-");

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

function makeEnv(): Record<string, string | undefined> {
	const home = makeTempDir();
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1" };
	for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) {
		delete env[key];
	}
	return env;
}

interface PluginRun {
	stdout: string;
	stderr: string;
	exitCode: number;
	/** The argv the child was given, so a failure names the command without the test repeating it. */
	args: readonly string[];
}

async function runPlugin(env: Record<string, string | undefined>, args: string[]): Promise<PluginRun> {
	const proc = Bun.spawn(["bun", cliPath, "plugin", ...args], {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode, args };
}

/**
 * Assert the child's exit code, quoting the child's OWN output when it disagrees.
 *
 * WHY THIS EXISTS rather than a bare `expect(exitCode).toBe(0)`: on 2026-07-27 the doctor case below
 * failed once during a saturated workspace-wide run and passed five times in isolation. All the
 * failure said was "expected 0, received 1", which is not enough to tell the two candidate causes
 * apart. `doctor` on a fresh `HOME` cannot report an error check at all (with no plugins
 * `package.json` the node_modules check is `ok` and the per-plugin loop has nothing to iterate), so
 * either a health check errored for a reason the fresh-home assumption misses, or the CLI died
 * before printing its report. The child's stdout and stderr distinguish those immediately: a health
 * check failure has a "Plugin Health Check" report above it, and a startup crash has a stack in
 * stderr and no report at all. Retrying until green would hide whichever it is, so the diagnosis
 * travels with the assertion instead.
 */
function expectExit(run: PluginRun, expected: number): void {
	if (run.exitCode === expected) return;
	throw new Error(
		[
			`veyyon plugin ${run.args.join(" ")} exited ${run.exitCode}, expected ${expected}.`,
			`--- stdout (${run.stdout.length} bytes) ---`,
			run.stdout.trimEnd() || "(empty)",
			`--- stderr (${run.stderr.length} bytes) ---`,
			run.stderr.trimEnd() || "(empty)",
		].join("\n"),
	);
}

describe("veyyon plugin offline surfaces", () => {
	it("list reports no plugins (human and JSON)", async () => {
		const env = makeEnv();
		const human = await runPlugin(env, ["list"]);
		expectExit(human, 0);
		expect(human.stdout).toContain("No plugins installed");
		const json = await runPlugin(env, ["list", "--json"]);
		expectExit(json, 0);
		expect(JSON.parse(json.stdout)).toEqual({ npm: [], marketplace: [] });
	}, 30_000);

	it("uninstall of a never-installed package fails closed with exit 1", async () => {
		const run = await runPlugin(makeEnv(), ["uninstall", "ghost-package"]);
		expectExit(run, 1);
		expect(run.stdout).not.toContain("Uninstalled ghost-package");
		expect(run.stderr).toContain("Plugin ghost-package is not installed");
		expect(run.stderr).toContain("veyyon plugin list");
	}, 30_000);

	it("enable/disable of an unknown plugin exit 1", async () => {
		const env = makeEnv();
		const enable = await runPlugin(env, ["enable", "ghost-package"]);
		expectExit(enable, 1);
		expect(enable.stderr).toContain('No plugin named "ghost-package" is installed');
		expect(enable.stderr).toContain("veyyon plugin list");
		const disable = await runPlugin(env, ["disable", "ghost-package"]);
		expectExit(disable, 1);
	}, 30_000);

	/**
	 * A fresh `HOME` has no plugins, so every check is `ok` and the command exits 0.
	 *
	 * The report is asserted BEFORE the exit code, because the report is what says why the exit code
	 * is what it is. Asserting the code first meant the one failure this test has ever had (a
	 * saturated workspace run, 2026-07-27) reported "expected 0, received 1" and threw the report
	 * away, when the report distinguishes a health check that errored from a CLI that never got far
	 * enough to print one. `expectExit` quotes both streams for the same reason.
	 */
	it("doctor sets up and passes on a fresh home", async () => {
		const run = await runPlugin(makeEnv(), ["doctor"]);
		expect(run.stdout).toContain("Plugin Health Check");
		expect(run.stdout).toContain("0 errors");
		expectExit(run, 0);
	}, 30_000);

	it("rejects an unknown action with the canonical action list", async () => {
		const run = await runPlugin(makeEnv(), ["frobnicate"]);
		expectExit(run, 2);
		expect(run.stderr).toContain("Expected action to be one of");
	}, 30_000);
});
