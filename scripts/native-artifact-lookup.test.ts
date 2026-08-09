/**
 * WHY: one main push costs 56 runner-minutes, and 34 of them are six native
 * builds that a prior push already produced. `native_artifact_lookup` is what
 * skips them, and it used to ask `gh run list --status=success`, so it found
 * nothing whenever main was red or a run had been cancelled: the pushes that
 * come fastest, while someone is fixing a red, each paid for every addon again
 * and queued four macOS/Windows jobs against a ~20-job account ceiling.
 *
 * The class closed here is "the addon cache misses a build that exists". Both
 * halves of the key are driven for real: the compute step runs against a
 * skeleton tree so the hash is proven to move with the native sources and only
 * with them, and the lookup step runs under a `gh` shim so selection is proven
 * against runs that failed, runs missing one artifact, and expired artifacts.
 *
 * Not caught: whether a downloaded addon actually loads (that is the build
 * action's contract and `--smoke-test`'s), and GitHub's artifact retention,
 * which is the cache's real TTL and lives outside this repo.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WORKFLOW_PATH = ".github/workflows/ci.yml";
const LOOKUP_JOB = "native_artifact_lookup";
const COMPUTE_STEP = "Compute native source hash";
const FIND_STEP = "Find prior main build with matching native artifacts";
const REPO_SLUG = "santhreal/veyyon";

/** Every path the compute step hashes, as it names them. */
const HASHED_FILES = [
	"crates/veyyon-natives/src/lib.rs",
	"Cargo.toml",
	"Cargo.lock",
	"rust-toolchain.toml",
	"packages/natives/scripts/native-portability.ts",
	"packages/natives/package.json",
	"scripts/ci-build-native.ts",
	"scripts/host-detect.ts",
	".github/actions/build-native/action.yml",
];

interface WorkflowStep {
	name?: string;
	run?: string;
}

interface Workflow {
	jobs: Record<string, { steps: WorkflowStep[] }>;
}

interface LookupResult {
	exitCode: number;
	stdout: string;
	/** One argv array per `gh` invocation. */
	calls: string[][];
	linuxX64RunId: string;
	crossPlatformRunId: string;
}

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

async function stepScript(name: string): Promise<string> {
	const workflow = Bun.YAML.parse(await fs.promises.readFile(WORKFLOW_PATH, "utf8")) as Workflow;
	const job = workflow.jobs[LOOKUP_JOB];
	if (!job) throw new Error(`${WORKFLOW_PATH} has no ${LOOKUP_JOB} job`);
	const step = job.steps.find(candidate => candidate.name === name);
	if (!step?.run) throw new Error(`${LOOKUP_JOB} has no runnable step named ${name}`);
	return step.run;
}

/** Substitute the two workflow expressions the steps read at run time. */
function expand(script: string, hash: string): string {
	return script
		.replace(/\$\{\{\s*github\.repository\s*\}\}/g, REPO_SLUG)
		.replace(/\$\{\{\s*steps\.compute\.outputs\.source-hash\s*\}\}/g, hash);
}

function githubOutputs(text: string): Record<string, string> {
	const outputs: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const index = line.indexOf("=");
		if (index > 0) outputs[line.slice(0, index)] = line.slice(index + 1);
	}
	return outputs;
}

/** The six artifact names a run uploads for `hash`, in the build matrix's order. */
function allArtifacts(hash: string): string[] {
	return [
		`veyyon-natives-linux-x64-baseline-h${hash}`,
		`veyyon-natives-linux-x64-modern-h${hash}`,
		`veyyon-natives-linux-arm64-h${hash}`,
		`veyyon-natives-darwin-x64-baseline-h${hash}`,
		`veyyon-natives-darwin-arm64-h${hash}`,
		`veyyon-natives-win32-x64-baseline-h${hash}`,
	];
}

/**
 * Run the real lookup step against a fake GitHub. `candidates` is what `gh run
 * list` answers, newest first; `artifacts` maps a run id to the artifact names
 * that run holds, where a name suffixed `!expired` exists but has expired.
 */
async function runLookup(options: {
	hash: string;
	candidates: number[];
	artifacts: Record<number, string[]>;
}): Promise<LookupResult> {
	const root = tempRoot("native-artifact-lookup-");
	const logPath = path.join(root, "gh-calls");
	const outputPath = path.join(root, "github-output");
	const artifactDir = path.join(root, "artifacts");
	fs.mkdirSync(artifactDir);
	fs.writeFileSync(outputPath, "");
	fs.writeFileSync(path.join(root, "runs"), `${options.candidates.join("\n")}\n`);
	for (const [id, names] of Object.entries(options.artifacts)) {
		fs.writeFileSync(path.join(artifactDir, id), names.length > 0 ? `${names.join("\n")}\n` : "");
	}

	// The shim answers the two calls the step makes and records argv one
	// bracketed argument per call, so a filter flag cannot hide in a joined line.
	fs.writeFileSync(
		path.join(root, "gh"),
		`#!/bin/sh
{ for arg in "$@"; do printf '[%s]' "$arg"; done; printf '\\n'; } >> "$FAKE_GH_LOG"
case "$1" in
  run) cat "$FAKE_GH_RUNS" ;;
  api)
    id=$(printf '%s' "$2" | sed -n 's|.*/runs/\\([0-9][0-9]*\\)/artifacts.*|\\1|p')
    file="$FAKE_GH_ARTIFACTS/$id"
    [ -f "$file" ] || exit 0
    case "$*" in
      *"expired == false"*) grep -v '!expired$' "$file" || true ;;
      *) sed 's/!expired$//' "$file" ;;
    esac
    ;;
esac
exit 0
`,
		{ mode: 0o755 },
	);

	const proc = Bun.spawn(["bash", "-c", expand(await stepScript(FIND_STEP), options.hash)], {
		env: {
			...process.env,
			PATH: `${root}:${process.env.PATH ?? ""}`,
			GITHUB_OUTPUT: outputPath,
			FAKE_GH_LOG: logPath,
			FAKE_GH_RUNS: path.join(root, "runs"),
			FAKE_GH_ARTIFACTS: artifactDir,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
	const calls = (await fs.promises.readFile(logPath, "utf8").catch(() => ""))
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => [...line.matchAll(/\[([^\]]*)\]/g)].map(match => match[1] ?? ""));
	const outputs = githubOutputs(await fs.promises.readFile(outputPath, "utf8"));
	return {
		exitCode,
		stdout,
		calls,
		linuxX64RunId: outputs["linux-x64-run-id"] ?? "",
		crossPlatformRunId: outputs["cross-platform-run-id"] ?? "",
	};
}

/** Run the real compute step over a skeleton holding every hashed path. */
async function computeHash(edit?: (root: string) => void): Promise<string> {
	const root = tempRoot("native-source-hash-");
	for (const relative of HASHED_FILES) {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, `${relative}\n`);
	}
	// Not hashed: a file the addons do not build from must not move the key.
	fs.mkdirSync(path.join(root, "packages/coding-agent/src"), { recursive: true });
	fs.writeFileSync(path.join(root, "packages/coding-agent/src/cli.ts"), "cli\n");
	edit?.(root);

	const outputPath = path.join(root, "github-output");
	fs.writeFileSync(outputPath, "");
	const proc = Bun.spawn(["bash", "-c", await stepScript(COMPUTE_STEP)], {
		cwd: root,
		env: { ...process.env, GITHUB_OUTPUT: outputPath },
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	return githubOutputs(await fs.promises.readFile(outputPath, "utf8"))["source-hash"] ?? "";
}

describe("the native addon cache key", () => {
	it("is a short hex digest of the native sources", async () => {
		expect(await computeHash()).toMatch(/^[0-9a-f]{16}$/);
	});

	it("moves when any hashed file changes, and for a new crate file", async () => {
		const base = await computeHash();
		for (const relative of HASHED_FILES) {
			const changed = await computeHash(root => fs.writeFileSync(path.join(root, relative), "changed\n"));
			expect(changed, `${relative} must be part of the key`).not.toBe(base);
		}
		const added = await computeHash(root =>
			fs.writeFileSync(path.join(root, "crates/veyyon-natives/src/new.rs"), "new\n"),
		);
		expect(added).not.toBe(base);
	});

	it("stays put when a file the addons do not build from changes", async () => {
		const base = await computeHash();
		const unrelated = await computeHash(root =>
			fs.writeFileSync(path.join(root, "packages/coding-agent/src/cli.ts"), "edited\n"),
		);
		expect(unrelated).toBe(base);
	});
});

describe("the lookup finds an addon build that exists", () => {
	const hash = "0123456789abcdef";

	it("reuses the addons a run uploaded even though that run went red", async () => {
		const result = await runLookup({ hash, candidates: [1001], artifacts: { 1001: allArtifacts(hash) } });

		expect(result.exitCode).toBe(0);
		expect(result.linuxX64RunId).toBe("1001");
		expect(result.crossPlatformRunId).toBe("1001");
	});

	// The regression itself. `--status=success` hid every red and cancelled run,
	// which is most of them during a fix streak, and the shim cannot answer for a
	// filter the step never sends: the argv is the evidence.
	it("never filters candidate runs by conclusion", async () => {
		const result = await runLookup({ hash, candidates: [1001], artifacts: { 1001: allArtifacts(hash) } });
		const listCall = result.calls.find(call => call[0] === "run" && call[1] === "list");

		expect(listCall).toBeDefined();
		expect(listCall?.some(argument => argument.startsWith("--status"))).toBe(false);
		expect(listCall).toContain("--branch=main");
		expect(listCall).toContain("--event=push");
		expect(listCall).toContain("--workflow=ci.yml");
	});

	it("takes each artifact set from the newest run that carries all of it", async () => {
		const complete = allArtifacts(hash);
		const result = await runLookup({
			hash,
			candidates: [1002, 1001],
			artifacts: { 1002: complete.slice(0, 2), 1001: complete },
		});

		// Neither x64 variant implies the other, so a run holding only the Linux
		// pair still serves the test buckets while the cross-platform set falls back.
		expect(result.linuxX64RunId).toBe("1002");
		expect(result.crossPlatformRunId).toBe("1001");
	});

	it("does not count an expired artifact as present", async () => {
		const names = allArtifacts(hash).map(name => (name.includes("darwin-arm64") ? `${name}!expired` : name));
		const result = await runLookup({ hash, candidates: [1003], artifacts: { 1003: names } });

		expect(result.linuxX64RunId).toBe("1003");
		expect(result.crossPlatformRunId).toBe("");
		expect(result.stdout).toContain("will rebuild");
	});

	it("rebuilds when every candidate holds a different source hash", async () => {
		const result = await runLookup({
			hash,
			candidates: [1004],
			artifacts: { 1004: allArtifacts("fedcba9876543210") },
		});

		expect(result.linuxX64RunId).toBe("");
		expect(result.crossPlatformRunId).toBe("");
		expect(result.stdout).toContain("No cached Linux x64 native artifacts");
		expect(result.stdout).toContain("No cached cross-platform native artifacts");
	});

	it("stops asking once both sets are found", async () => {
		const result = await runLookup({
			hash,
			candidates: [1001, 1000],
			artifacts: { 1001: allArtifacts(hash), 1000: allArtifacts(hash) },
		});
		const queried = result.calls.filter(call => call[0] === "api").map(call => call[1] ?? "");

		expect(queried.some(url => url.includes("/runs/1001/"))).toBe(true);
		expect(queried.some(url => url.includes("/runs/1000/"))).toBe(false);
	});
});
