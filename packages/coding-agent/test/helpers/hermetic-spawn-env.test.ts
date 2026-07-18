/**
 * Guard: every test file that references the real CLI entry (src/cli.ts) must
 * isolate the spawned process from the developer's real ~/.veyyon — a bare
 * spawn inherits HOME, and runCli's legacy-layout migration can MUTATE the
 * real config tree from inside a test run. Isolation counts as any of:
 * hermeticSpawnEnv, an explicit HOME override, or a config-dir env redirect.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
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
		process.env.VEYYON_PROFILE = "guard-test-profile";
		try {
			const { home, env, cleanup } = hermeticSpawnEnv({ VEYYON_CODING_AGENT_DIR: "/x/agent" });
			expect(env.HOME).toBe(home);
			expect(env.HOME).not.toBe(process.env.HOME);
			expect(env.VEYYON_PROFILE).toBeUndefined();
			expect(env.VEYYON_PROFILE).toBeUndefined();
			expect(env.VEYYON_CODING_AGENT_DIR).toBe("/x/agent");
			expect(env.NO_COLOR).toBe("1");
			cleanup();
		} finally {
			delete process.env.VEYYON_PROFILE;
		}
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
