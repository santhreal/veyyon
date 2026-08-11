import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface CompositeActionStep {
	name?: string;
	run?: string;
}

interface CompositeAction {
	runs: { steps: CompositeActionStep[] };
}

interface InstallStepResult {
	exitCode: number;
	pathOutput: string;
	attempts: number;
	stderr: string;
}

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * The version the step installs comes from `packageManager`, so the expectation
 * does too. A literal here would be one more copy of the pin to bump, which is
 * the drift `scripts/the-bun-pin-has-one-owner.test.ts` exists to stop.
 */
function pinnedBunVersion(): string {
	const manifest = JSON.parse(fs.readFileSync("package.json", "utf8")) as { packageManager?: string };
	const match = /^bun@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "");
	if (!match) throw new Error(`package.json packageManager is not a bun pin: ${manifest.packageManager}`);
	return match[1];
}

async function runInstallStep(runnerOs: "Linux" | "Windows", failuresBeforeSuccess = 0): Promise<InstallStepResult> {
	const action = Bun.YAML.parse(await Bun.file(".github/actions/bun-install/action.yml").text()) as CompositeAction;
	const step = action.runs.steps.find(candidate => candidate.name === "Install bun when absent");
	if (!step?.run) throw new Error("bun-install action has no executable install step");

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bun-install-action-"));
	tempRoots.push(root);
	const outputPath = path.join(root, "github-path");
	const countPath = path.join(root, "curl-count");
	const curlPath = path.join(root, "curl");
	await Bun.write(
		curlPath,
		`#!/bin/sh
count=0
if [ -f "$FAKE_CURL_COUNT" ]; then
  count="$(cat "$FAKE_CURL_COUNT")"
fi
count=$((count + 1))
printf '%s\\n' "$count" > "$FAKE_CURL_COUNT"
if [ "$count" -le "$FAKE_CURL_FAILURES" ]; then
  printf '#!/bin/sh\\nexit 1\\n'
else
  printf '#!/bin/sh\\nexit 0\\n'
fi
`,
	);
	fs.chmodSync(curlPath, 0o755);

	const sleepPath = path.join(root, "sleep");
	await Bun.write(sleepPath, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(sleepPath, 0o755);

	const cygpathPath = path.join(root, "cygpath");
	await Bun.write(
		cygpathPath,
		'#!/bin/sh\n[ "$*" = "-w /home/runner/.bun/bin" ] || exit 9\nprintf \'C:\\\\Users\\\\runner\\\\.bun\\\\bin\\n\'\n',
	);
	fs.chmodSync(cygpathPath, 0o755);

	const proc = Bun.spawn(["bash", "-c", step.run], {
		env: {
			...process.env,
			PATH: `${root}:${process.env.PATH ?? ""}`,
			HOME: "/home/runner",
			RUNNER_OS: runnerOs,
			GITHUB_PATH: outputPath,
			FAKE_CURL_COUNT: countPath,
			FAKE_CURL_FAILURES: String(failuresBeforeSuccess),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	const [pathOutput, attemptsText] = await Promise.all([
		Bun.file(outputPath)
			.text()
			.catch(() => ""),
		Bun.file(countPath).text(),
	]);
	return {
		exitCode,
		pathOutput: pathOutput.trim(),
		attempts: Number(attemptsText.trim()),
		stderr,
	};
}

describe("bun-install composite action PATH serialization", () => {
	/** A native Windows Bun child must receive a Win32 path, not Git Bash's MSYS spelling. */
	it("writes a native Windows Bun directory to GITHUB_PATH", async () => {
		const result = await runInstallStep("Windows");
		expect(result.exitCode).toBe(0);
		expect(result.attempts).toBe(1);
		expect(result.pathOutput).toBe("C:\\Users\\runner\\.bun\\bin");
	});

	/** Unix runners keep the direct HOME-relative Bun directory and never need path translation. */
	it("keeps the POSIX Bun directory on Linux", async () => {
		const result = await runInstallStep("Linux");
		expect(result.exitCode).toBe(0);
		expect(result.attempts).toBe(1);
		expect(result.pathOutput).toBe("/home/runner/.bun/bin");
	});

	/** A transient GitHub asset failure must not discard an otherwise healthy Windows CI job. */
	it("retries the complete Bun installer after transient download failures", async () => {
		const result = await runInstallStep("Windows", 2);
		expect(result.exitCode).toBe(0);
		expect(result.attempts).toBe(3);
		expect(result.pathOutput).toBe("C:\\Users\\runner\\.bun\\bin");
		expect(result.stderr).toContain("install failed on attempt 2; retrying");
	});

	/** A persistent outage stays bounded and leaves no unusable directory on the job PATH. */
	it("fails after three attempts when every Bun download fails", async () => {
		const result = await runInstallStep("Windows", 3);
		expect(result.exitCode).toBe(1);
		expect(result.attempts).toBe(3);
		expect(result.pathOutput).toBe("");
		expect(result.stderr).toContain(`failed to install bun-v${pinnedBunVersion()} after 3 attempts`);
	});
});
