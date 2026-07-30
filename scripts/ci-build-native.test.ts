import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "..");

async function runCiNativeDryRun(env: Record<string, string | undefined> = {}): Promise<string> {
	const result = await $`bun scripts/ci-build-native.ts --dry-run`
		.cwd(repoRoot)
		.quiet()
		.env({
			...process.env,
			PCRE2_SYS_STATIC: "0",
			RUSTFLAGS: "",
			TARGET_VARIANT: "",
			TARGET_VARIANTS: "",
			...env,
		})
		.nothrow();
	expect(result.exitCode).toBe(0);
	return result.text();
}

describe("ci native build environment", () => {
	it("prints static PCRE2 env for the default native build dry run", async () => {
		await expect(runCiNativeDryRun()).resolves.toBe(
			"DRY RUN bun --cwd=packages/natives run build [default] PCRE2_SYS_STATIC=1\n",
		);
	});

	it("prints static PCRE2 env without dropping x64 variant settings", async () => {
		await expect(runCiNativeDryRun({ TARGET_VARIANTS: "baseline" })).resolves.toBe(
			'DRY RUN bun --cwd=packages/natives run build [baseline] PCRE2_SYS_STATIC=1 TARGET_VARIANT=baseline RUSTFLAGS="-C target-cpu=x86-64-v2"\n',
		);
	});
});

interface CompositeActionStep {
	name?: string;
	run?: string;
}

interface CompositeAction {
	runs: { steps: CompositeActionStep[] };
}

interface SccacheStepResult {
	exitCode: number;
	attempts: number;
	githubEnv: string;
	stderr: string;
}

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function runSccacheStep(failuresBeforeSuccess: number): Promise<SccacheStepResult> {
	const action = Bun.YAML.parse(await Bun.file(".github/actions/build-native/action.yml").text()) as CompositeAction;
	const step = action.runs.steps.find(candidate => candidate.name === "Enable sccache for cargo");
	if (!step?.run) throw new Error("build-native action has no executable sccache enable step");

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-sccache-action-"));
	tempRoots.push(root);
	const githubEnvPath = path.join(root, "github-env");
	const countPath = path.join(root, "sccache-count");
	await Bun.write(
		path.join(root, "rustup"),
		'#!/bin/sh\n[ "$*" = "which rustc" ] || exit 9\nprintf \'/fake/rustc\\n\'\n',
	);
	await Bun.write(
		path.join(root, "sccache"),
		`#!/bin/sh
count=0
if [ -f "$FAKE_SCCACHE_COUNT" ]; then
  count="$(cat "$FAKE_SCCACHE_COUNT")"
fi
count=$((count + 1))
printf '%s\\n' "$count" > "$FAKE_SCCACHE_COUNT"
[ "$count" -gt "$FAKE_SCCACHE_FAILURES" ]
`,
	);
	await Bun.write(path.join(root, "sleep"), "#!/bin/sh\nexit 0\n");
	for (const command of ["rustup", "sccache", "sleep"]) fs.chmodSync(path.join(root, command), 0o755);

	const proc = Bun.spawn(["bash", "-c", step.run], {
		cwd: repoRoot,
		env: {
			...process.env,
			PATH: `${root}:${process.env.PATH ?? ""}`,
			GITHUB_ENV: githubEnvPath,
			FAKE_SCCACHE_COUNT: countPath,
			FAKE_SCCACHE_FAILURES: String(failuresBeforeSuccess),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	const [githubEnv, attemptsText] = await Promise.all([Bun.file(githubEnvPath).text(), Bun.file(countPath).text()]);
	return { exitCode, attempts: Number(attemptsText.trim()), githubEnv, stderr };
}

describe("native sccache availability", () => {
	/** A healthy cache remains the Rust compiler wrapper and does not spend a retry. */
	it("enables the GitHub Actions backend after a successful preflight", async () => {
		const result = await runSccacheStep(0);
		expect(result.exitCode).toBe(0);
		expect(result.attempts).toBe(1);
		expect(result.githubEnv).toBe("CARGO_INCREMENTAL=0\nRUSTC_WRAPPER=sccache\nSCCACHE_GHA_ENABLED=true\n");
	});

	/** A short DNS or cache-service interruption must recover before the native build begins. */
	it("retries transient sccache backend failures", async () => {
		const result = await runSccacheStep(2);
		expect(result.exitCode).toBe(0);
		expect(result.attempts).toBe(3);
		expect(result.githubEnv).toContain("RUSTC_WRAPPER=sccache\n");
		expect(result.stderr).toContain("cache preflight failed on attempt 2; retrying");
	});

	/** A cache outage cannot become a compiler outage because uncached Cargo remains valid. */
	it("disables sccache after three failed preflights and lets the build continue", async () => {
		const result = await runSccacheStep(3);
		expect(result.exitCode).toBe(0);
		expect(result.attempts).toBe(3);
		expect(result.githubEnv).toBe("CARGO_INCREMENTAL=0\nSCCACHE_GHA_ENABLED=false\n");
		expect(result.stderr).toContain("compiling without sccache");
	});
});
