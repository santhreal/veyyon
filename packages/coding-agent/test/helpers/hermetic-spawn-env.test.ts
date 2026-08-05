/**
 * Guard: every test file that references the real CLI entry (src/cli.ts) must
 * isolate the spawned process from the developer's real ~/.veyyon — a bare
 * spawn inherits HOME, and runCli's legacy-layout migration can MUTATE the
 * real config tree from inside a test run. Isolation counts as any of:
 * hermeticSpawnEnv, an explicit HOME override, or a config-dir env redirect.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { XDG_BASE_DIRS } from "../../../utils/test/helpers/isolated-config-root";
import { hermeticSpawnEnv } from "./hermetic-spawn-env";

const testRoot = path.resolve(import.meta.dir, "..");

// Only LIVE isolation mechanisms count. The legacy PI_/OMP_ env vars are no
// longer read by dirs.ts — a file "isolating" through them hits the real home,
// so they deliberately do not appear here.
const ISOLATION_MARKERS = [
	"hermeticSpawnEnv",
	"HOME:",
	'"HOME"',
	"VEYYON_CODING_AGENT_DIR",
	"VEYYON_CONFIG_DIR",
	"stripDirOverrides",
] as const;

describe("hermetic spawn env", () => {
	it("strips config redirects, swaps HOME, and honors extras", () => {
		// Set, and PUT BACK, every variable this case moves. Deleting `VEYYON_PROFILE`
		// unconditionally in the `finally` is what this used to do, and on any machine that
		// actually runs with a named profile (which is every machine running veyyon: the
		// harness exports `VEYYON_PROFILE`) that handed an unset profile to every test file
		// scheduled after this one in the same process. They then resolved under
		// `profiles/default/` instead, so a suite could pass alone and fail in a full run
		// with nothing in its own source to blame.
		const previous = (["VEYYON_PROFILE", "VEYYON_CONFIG_DIR"] as const).map(key => [key, process.env[key]] as const);
		process.env.VEYYON_PROFILE = "guard-test-profile";
		process.env.VEYYON_CONFIG_DIR = ".veyyon-guard-test";
		try {
			const { home, env, cleanup } = hermeticSpawnEnv({ VEYYON_CODING_AGENT_DIR: "/x/agent" });
			expect(env.HOME).toBe(home);
			expect(env.HOME).not.toBe(process.env.HOME);
			expect(env.VEYYON_PROFILE).toBeUndefined();
			// The other config-root variable, and the one the test name promises. This line was
			// a verbatim copy of the `VEYYON_PROFILE` assertion above it, so "strips config
			// redirects" was asserted once and counted twice, and `VEYYON_CONFIG_DIR` reaching
			// a child would not have failed anything. Both are set above so neither assertion
			// can pass on a variable that was absent to begin with.
			expect(env.VEYYON_CONFIG_DIR).toBeUndefined();
			expect(env.VEYYON_CODING_AGENT_DIR).toBe("/x/agent");
			expect(env.NO_COLOR).toBe("1");
			cleanup();
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	/**
	 * The XDG bases have to go too, and a temp HOME does not remove them.
	 *
	 * `DirResolver` resolves the `data`, `state` and `cache` categories under `XDG_DATA_HOME`,
	 * `XDG_STATE_HOME` and `XDG_CACHE_HOME` in preference to the config root, so a developer running
	 * with any of them set handed every spawned CLI a root inside their real tree — where `runCli`'s
	 * legacy-layout migration can then MUTATE it. This helper named only the three veyyon variables;
	 * it now imports the same two lists `enterIsolatedConfigRoot` clears, so the in-process and
	 * child-process answers cannot drift apart.
	 */
	it("strips every XDG base directory, which outranks the config root per category", () => {
		const previous = XDG_BASE_DIRS.map(key => [key, process.env[key]] as const);
		for (const key of XDG_BASE_DIRS) process.env[key] = `/real/${key}`;
		try {
			const { env, cleanup } = hermeticSpawnEnv();

			for (const key of XDG_BASE_DIRS) expect(env[key], key).toBeUndefined();
			cleanup();
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	/**
	 * An explicit extra still wins, including for an XDG base. Stripping is the default, not a
	 * prohibition: a suite that wants the child to write its state somewhere it can inspect passes
	 * the base in and must get it.
	 */
	it("lets an explicit extra override a stripped variable", () => {
		const { env, cleanup } = hermeticSpawnEnv({ XDG_STATE_HOME: "/chosen/state" });

		expect(env.XDG_STATE_HOME).toBe("/chosen/state");
		cleanup();
	});

	it("every spawn-CLI and -e probe test file isolates HOME or the config dir", async () => {
		const glob = new Bun.Glob("**/*.test.ts");
		const offenders: string[] = [];
		for await (const rel of glob.scan(testRoot)) {
			const file = path.join(testRoot, rel);
			const text = await Bun.file(file).text();
			if (!text.includes("Bun.spawn")) continue;
			// Files that spawn the real CLI entry point, plus `-e` probe scripts
			// that import package sources (those resolve dirs.ts against the
			// inherited env exactly like the CLI does).
			const spawnsCli = /src[/\\", ]+cli\.ts/.test(text) || text.includes("cliEntry") || text.includes("cliPath");
			const spawnsProbe =
				/spawnSync?\(\s*\[[^\]]*"-e"/.test(text) || (text.includes('"-e"') && text.includes("process.execPath"));
			if (!spawnsCli && !spawnsProbe) continue;
			if (!ISOLATION_MARKERS.some(marker => text.includes(marker))) {
				offenders.push(rel);
			}
		}
		expect(offenders).toEqual([]);
	});
});
