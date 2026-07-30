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

interface NativeLookupWorkflowStep {
	id?: string;
	run?: string;
}

interface NativeLookupWorkflow {
	jobs: {
		native_artifact_lookup: {
			steps: NativeLookupWorkflowStep[];
		};
	};
}

async function nativeLookupScript(stepId: "compute" | "find"): Promise<string> {
	const workflow = Bun.YAML.parse(
		await Bun.file(path.join(repoRoot, ".github", "workflows", "ci.yml")).text(),
	) as NativeLookupWorkflow;
	const script = workflow.jobs.native_artifact_lookup.steps.find(step => step.id === stepId)?.run;
	if (!script) throw new Error(`native_artifact_lookup has no executable ${stepId} step`);
	return script;
}

async function runScript(
	script: string,
	cwd: string,
	env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bash", "-c", script], {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

function outputValue(contents: string, key: string): string {
	const prefix = `${key}=`;
	const line = contents.split("\n").find(candidate => candidate.startsWith(prefix));
	if (line === undefined) throw new Error(`missing ${key} in step output`);
	return line.slice(prefix.length);
}

async function writeNativeHashFixture(root: string): Promise<void> {
	const files: Record<string, string> = {
		"crates/example.rs": "native source\n",
		"Cargo.toml": "[workspace]\n",
		"Cargo.lock": "version = 4\n",
		"rust-toolchain.toml": '[toolchain]\nchannel = "stable"\n',
		"packages/natives/scripts/build.ts": "export {};\n",
		"packages/natives/package.json": "{}\n",
		"scripts/ci-build-native.ts": "export {};\n",
		"scripts/host-detect.ts": "export {};\n",
		".github/actions/build-native/action.yml": "name: fixture recipe\n",
	};
	for (const [relativePath, contents] of Object.entries(files)) {
		const target = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		await Bun.write(target, contents);
	}
}

async function computeNativeFixtureHash(root: string, outputName: string): Promise<string> {
	const outputPath = path.join(root, outputName);
	const result = await runScript(await nativeLookupScript("compute"), root, { GITHUB_OUTPUT: outputPath });
	if (result.exitCode !== 0) {
		throw new Error(`native hash step failed: ${result.stderr || result.stdout}`);
	}
	return outputValue(await Bun.file(outputPath).text(), "source-hash");
}

async function runNativeLookupFixture(hash: string, artifactNames: string[]): Promise<Record<string, string>> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-artifact-lookup-"));
	tempRoots.push(root);
	const binDir = path.join(root, "bin");
	fs.mkdirSync(binDir);
	const namesPath = path.join(root, "artifact-names");
	const outputPath = path.join(root, "github-output");
	await Bun.write(namesPath, artifactNames.length > 0 ? `${artifactNames.join("\n")}\n` : "");
	const ghPath = path.join(binDir, "gh");
	await Bun.write(
		ghPath,
		`#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  printf '%s\\n' "$FAKE_RUN_ID"
  exit 0
fi
if [ "$1" = "api" ]; then
  cat "$FAKE_ARTIFACT_NAMES"
  exit 0
fi
exit 64
`,
	);
	fs.chmodSync(ghPath, 0o755);

	const script = (await nativeLookupScript("find"))
		// biome-ignore lint/suspicious/noTemplateCurlyInString: exact GitHub Actions expression is fixture input
		.replaceAll("${{ steps.compute.outputs.source-hash }}", hash)
		// biome-ignore lint/suspicious/noTemplateCurlyInString: exact GitHub Actions expression is fixture input
		.replaceAll("${{ github.repository }}", "fixture/repository");
	const result = await runScript(script, root, {
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		GITHUB_OUTPUT: outputPath,
		GH_TOKEN: "fixture-token",
		FAKE_RUN_ID: "4242",
		FAKE_ARTIFACT_NAMES: namesPath,
	});
	if (result.exitCode !== 0) {
		throw new Error(`native artifact lookup failed: ${result.stderr || result.stdout}`);
	}
	const contents = await Bun.file(outputPath).text();
	return {
		"linux-x64-run-id": outputValue(contents, "linux-x64-run-id"),
		"cross-platform-run-id": outputValue(contents, "cross-platform-run-id"),
	};
}

describe("native artifact lookup workflow contract", () => {
	/** Changing the composite native build recipe must invalidate old artifacts, not reuse binaries built by stale action steps. */
	it("includes the build-native action in the native source identity", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-source-hash-"));
		tempRoots.push(root);
		await writeNativeHashFixture(root);
		const before = await computeNativeFixtureHash(root, "output-before");
		await Bun.write(
			path.join(root, ".github", "actions", "build-native", "action.yml"),
			"name: fixture recipe\nruns:\n  using: composite\n",
		);
		const after = await computeNativeFixtureHash(root, "output-after");
		expect(after).not.toBe(before);
	});

	/** A lone modern artifact must not suppress either required rebuild, and reuse starts only when each output's exact artifact set is present. */
	it("requires both Linux x64 variants for ordinary and cross-platform reuse", async () => {
		const hash = "fixturehash";
		const baseline = `veyyon-natives-linux-x64-baseline-h${hash}`;
		const modern = `veyyon-natives-linux-x64-modern-h${hash}`;
		const emptyRunIds = {
			"linux-x64-run-id": "",
			"cross-platform-run-id": "",
		};

		await expect(runNativeLookupFixture(hash, [modern])).resolves.toEqual(emptyRunIds);
		await expect(runNativeLookupFixture(hash, [baseline])).resolves.toEqual(emptyRunIds);
		await expect(runNativeLookupFixture(hash, [baseline, modern])).resolves.toEqual({
			"linux-x64-run-id": "4242",
			"cross-platform-run-id": "",
		});
		await expect(
			runNativeLookupFixture(hash, [
				baseline,
				modern,
				`veyyon-natives-linux-arm64-h${hash}`,
				`veyyon-natives-darwin-x64-baseline-h${hash}`,
				`veyyon-natives-darwin-arm64-h${hash}`,
				`veyyon-natives-win32-x64-baseline-h${hash}`,
			]),
		).resolves.toEqual({
			"linux-x64-run-id": "4242",
			"cross-platform-run-id": "4242",
		});
	});
});
