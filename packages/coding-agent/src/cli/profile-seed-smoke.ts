import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_PROFILE_DIR_NAME, PROFILES_DIR_NAME } from "@veyyon/utils/dirs";
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import { YAML } from "bun";
import { resolveWorkerSpawnCmd, SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";

/**
 * Distribution smoke for the profile seed path (`veyyon --smoke-test`).
 *
 * `profile new <name>` at defaults copies the active profile and rewrites the
 * copied settings file. That chunk of the compiled binary is one `--version`,
 * `--help` and the worker probes never load, so a bundler regression confined
 * to it (a dynamic `import("bun")` the minifier fused into `awaitPromise`, a
 * static import the tree-shaker dropped) shipped in a release whose smoke test
 * passed. Running the real CLI as a child against a scratch config root loads
 * and executes that chunk on the shipped artifact.
 *
 * The scratch default profile carries `profile.displayName`, so the copied
 * settings file exists and the YAML parse/rewrite runs; the check asserts the
 * new profile was created and did not inherit the name.
 */
export async function smokeTestProfileSeed(): Promise<void> {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-profile-smoke-"));
	try {
		const sourceAgentDir = path.join(scratch, PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR_NAME, "agent");
		await fs.mkdir(sourceAgentDir, { recursive: true });
		await fs.writeFile(path.join(sourceAgentDir, "config.yml"), "profile:\n  displayName: smoke source\n");
		const home = path.join(scratch, "home");
		await fs.mkdir(home, { recursive: true });

		const env = workerEnvFromParent({ VEYYON_CONFIG_DIR: scratch, HOME: home, USERPROFILE: home });
		delete env.VEYYON_PROFILE;
		delete env.VEYYON_CODING_AGENT_DIR;
		const spawn = resolveWorkerSpawnCmd("profile");
		const [executable, ...prefix] = spawn.cmd;
		const args = [...prefix, "new", "smoke-seed", "--json"];

		const { promise, resolve } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
		execFile(
			executable,
			args,
			{ cwd: spawn.cwd, env, timeout: SMOKE_TEST_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? null : 0;
				resolve({ code, stdout: String(stdout), stderr: String(stderr) });
			},
		);
		const result = await promise;
		if (result.code !== 0) {
			throw new Error(
				`profile seed smoke failed: \`profile new\` exited ${result.code ?? "abnormally"}: ${result.stderr.trim()}`,
			);
		}

		let created: unknown;
		try {
			created = JSON.parse(result.stdout);
		} catch (error) {
			throw new Error(`profile seed smoke failed: \`profile new --json\` printed no JSON (${errorMessage(error)})`);
		}
		if (!isRecord(created) || created.name !== "smoke-seed" || typeof created.agentDir !== "string") {
			throw new Error(`profile seed smoke failed: unexpected \`profile new --json\` output ${result.stdout.trim()}`);
		}
		const copied = await fs.readFile(path.join(created.agentDir, "config.yml"), "utf8");
		const parsed: unknown = YAML.parse(copied);
		const profile = isRecord(parsed) ? parsed.profile : undefined;
		if (isRecord(profile) && "displayName" in profile) {
			throw new Error("profile seed smoke failed: the copied settings file still carries profile.displayName");
		}
	} finally {
		await fs.rm(scratch, { recursive: true, force: true });
	}
}
