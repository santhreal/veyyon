/**
 * `veyyon setup status` has to answer in its exit code, not only on screen.
 *
 * It printed "1 errors" in its own summary and exited 0 anyway, so a script that
 * ran it to gate a deploy passed on a machine where veyyon does not work — the
 * one situation the check exists to catch. `veyyon plugin doctor` had always
 * exited non-zero on an error and the handbook described both the same way, so
 * this was a silent disagreement between two commands and their documentation.
 *
 * Driven as a real child process rather than by calling the handler: the contract
 * under test IS the process exit code, and a handler that returns normally would
 * satisfy an in-process assertion while the shipped command still exited 0.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const CLI = path.join(REPO_ROOT, "packages/coding-agent/src/cli.ts");

/**
 * Run `setup status` with a PATH we control, so the machine cannot decide the result.
 *
 * THROUGH `hermeticSpawnEnv`, not `{ ...process.env }`. Passing the ambient environment let the child
 * resolve its config against the developer's real `HOME` and honour any `VEYYON_CONFIG_DIR` or
 * `VEYYON_CODING_AGENT_DIR` already exported in the shell, so a local profile could change what
 * `setup status` reports and flip these assertions on one machine and not another. Controlling `PATH`
 * and leaving the rest inherited controls one input out of several. The
 * `helpers/hermetic-spawn-env.test.ts` guard exists for exactly this and named this file.
 */
function runStatus(pathValue: string): { exitCode: number; stdout: string } {
	const { env, cleanup } = hermeticSpawnEnv({ PATH: pathValue });
	try {
		const result = Bun.spawnSync([process.execPath, CLI, "setup", "status"], {
			cwd: REPO_ROOT,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		return { exitCode: result.exitCode, stdout: result.stdout.toString() };
	} finally {
		cleanup();
	}
}

/** The directory holding the runtime, which the child needs to start at all. */
const RUNTIME_DIR = path.dirname(process.execPath);

describe.skipIf(process.platform === "win32")("veyyon setup status reports failure in its exit code", () => {
	it("exits non-zero when a check reports an error", () => {
		// No veyyon on PATH is the simplest real error: the shell cannot run the
		// command at all. `git` stays reachable so the failure under test is the one
		// named, not an unrelated second error.
		const { exitCode, stdout } = runStatus(`${RUNTIME_DIR}:/usr/bin:/bin`);

		expect(exitCode).toBe(1);
		expect(stdout).toContain("does not resolve on PATH");
		expect(stdout).toContain("1 check failed");
	});

	/**
	 * The other half, and the one that keeps the change honest: a warning must NOT
	 * fail. Making every imperfection non-zero would turn the check into noise
	 * nobody gates on, which is how it ends up ignored again.
	 *
	 * The stub is a working veyyon: it reports this build's version and answers a
	 * search, so every install check passes. What it deliberately lacks is the
	 * `vey` alias beside it, which is a warning and nothing more.
	 */
	it("exits zero when the worst result is a warning", () => {
		const version = (
			JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages/coding-agent/package.json"), "utf8")) as {
				version: string;
			}
		).version;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-status-warn-"));
		try {
			const stub = path.join(dir, "veyyon");
			fs.writeFileSync(
				stub,
				[
					"#!/bin/sh",
					'if [ "$1" = "grep" ]; then',
					"  shift",
					'  [ "$1" = "--help" ] && exit 0',
					'  pattern="$1"; shift',
					'  exec grep -rl "$pattern" "$@"',
					"fi",
					`echo "veyyon/${version}"`,
					"",
				].join("\n"),
				{ mode: 0o755 },
			);

			const { exitCode, stdout } = runStatus(`${dir}:${RUNTIME_DIR}:/usr/bin:/bin`);

			expect(stdout).toContain("Everything works");
			expect(stdout).toContain("vey alias");
			expect(exitCode).toBe(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
