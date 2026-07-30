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

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function runInstallStep(runnerOs: "Linux" | "Windows"): Promise<string> {
	const action = Bun.YAML.parse(await Bun.file(".github/actions/bun-install/action.yml").text()) as CompositeAction;
	const step = action.runs.steps.find(candidate => candidate.name === "Install bun when absent");
	if (!step?.run) throw new Error("bun-install action has no executable install step");

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bun-install-action-"));
	tempRoots.push(root);
	const outputPath = path.join(root, "github-path");
	const curlPath = path.join(root, "curl");
	await Bun.write(curlPath, "#!/bin/sh\nprintf '#!/bin/sh\\nexit 0\\n'\n");
	fs.chmodSync(curlPath, 0o755);

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
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	if (exitCode !== 0) throw new Error(`install step exited ${exitCode}: ${stderr}`);
	return (await Bun.file(outputPath).text()).trim();
}

describe("bun-install composite action PATH serialization", () => {
	/** A native Windows Bun child must receive a Win32 path, not Git Bash's MSYS spelling. */
	it("writes a native Windows Bun directory to GITHUB_PATH", async () => {
		expect(await runInstallStep("Windows")).toBe("C:\\Users\\runner\\.bun\\bin");
	});

	/** Unix runners keep the direct HOME-relative Bun directory and never need path translation. */
	it("keeps the POSIX Bun directory on Linux", async () => {
		expect(await runInstallStep("Linux")).toBe("/home/runner/.bun/bin");
	});
});
