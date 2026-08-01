import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const tempRoots: string[] = [];

afterAll(() => {
	for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

interface DispatchStep {
	id?: string;
	run?: string;
}

interface ReleaseWorkflow {
	jobs: {
		release: {
			steps: DispatchStep[];
		};
	};
}

interface RunEvidence {
	path?: string;
	event?: string;
	branch?: string;
	sha?: string;
	title?: string;
}

interface FixtureOptions {
	checksDelayPolls?: number;
	failRunId?: string;
	checksCollision?: boolean;
	checksEvidence?: RunEvidence;
}

async function dispatchScript(): Promise<string> {
	const workflow = Bun.YAML.parse(
		await Bun.file(path.join(repoRoot, ".github", "workflows", "release.yml")).text(),
	) as ReleaseWorkflow;
	const script = workflow.jobs.release.steps.find(step => step.id === "dispatch")?.run;
	if (!script) throw new Error("release workflow has no executable dispatch step");
	return script;
}

async function runFixture(options: FixtureOptions = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-dispatch-correlation-"));
	tempRoots.push(root);
	const binDir = path.join(root, "bin");
	const stateDir = path.join(root, "state");
	const callsPath = path.join(root, "calls");
	const outputPath = path.join(root, "github-output");
	fs.mkdirSync(binDir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(callsPath, "");
	fs.writeFileSync(outputPath, "");

	const gitPath = path.join(binDir, "git");
	fs.writeFileSync(
		gitPath,
		`#!/bin/sh
case "$*" in
  "tag --points-at HEAD") printf 'v1.2.3\\n' ;;
  "rev-parse HEAD") printf 'release-sha\\n' ;;
  *) printf 'unexpected git invocation: %s\\n' "$*" >&2; exit 88 ;;
esac
`,
	);

	const ghPath = path.join(binDir, "gh");
	fs.writeFileSync(
		ghPath,
		`#!/bin/bash
set -u
printf '%s\\n' "$*" >> "$CALLS"

emit_run_ids() {
  key="$1"
  old_id="$2"
  new_id="$3"
  delay="$4"
  count_file="$STATE_DIR/$key"
  count=0
  if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$count_file"
  printf '%s\\n' "$old_id"
  if [ "$key" = checks ] && [ "$CHECKS_COLLISION" = 1 ] && [ "$count" -gt 1 ]; then
    printf '301\\n'
  fi
  if [ "$count" -gt $((delay + 1)) ]; then printf '%s\\n' "$new_id"; fi
}

case "$1" in
  workflow)
    case "$*" in
      "workflow run checks.yml --ref v1.2.3 -f release_nonce=9001-2-checks" | \
      "workflow run ci.yml --ref v1.2.3") ;;
      *) printf 'unexpected gh workflow invocation: %s\\n' "$*" >&2; exit 88 ;;
    esac
    ;;
  api)
    case "$2" in
      *"/actions/workflows/checks.yml/runs?head_sha=release-sha&event=workflow_dispatch&per_page=100")
        emit_run_ids checks 101 201 "$CHECKS_DELAY_POLLS"
        ;;
      *"/actions/runs/201")
        printf '%s|%s|%s|%s|%s\\n' "$CHECKS_PATH" "$CHECKS_EVENT" "$CHECKS_BRANCH" "$CHECKS_SHA" "$CHECKS_TITLE"
        ;;
      *"/actions/runs/301")
        printf '.github/workflows/checks.yml|workflow_dispatch|v1.2.3|release-sha|Checks release gate competing-dispatch\\n'
        ;;
      *) printf 'unexpected gh api invocation: %s\\n' "$*" >&2; exit 88 ;;
    esac
    ;;
  run)
    if [ "$2" != "watch" ] || [ "$4" != "--exit-status" ]; then
      printf 'unexpected gh run invocation: %s\\n' "$*" >&2
      exit 88
    fi
    if [ -n "$FAIL_RUN_ID" ] && [ "$3" = "$FAIL_RUN_ID" ]; then exit 23; fi
    ;;
  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 88 ;;
esac
`,
	);

	const sleepPath = path.join(binDir, "sleep");
	fs.writeFileSync(sleepPath, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(gitPath, 0o755);
	fs.chmodSync(ghPath, 0o755);
	fs.chmodSync(sleepPath, 0o755);

	const evidence = options.checksEvidence ?? {};
	const proc = Bun.spawn(["bash", "-c", await dispatchScript()], {
		cwd: repoRoot,
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			CALLS: callsPath,
			STATE_DIR: stateDir,
			GITHUB_OUTPUT: outputPath,
			GITHUB_REPOSITORY: "owner/repo",
			GITHUB_RUN_ID: "9001",
			GITHUB_RUN_ATTEMPT: "2",
			GH_TOKEN: "test-token",
			CHECKS_DELAY_POLLS: String(options.checksDelayPolls ?? 1),
			FAIL_RUN_ID: options.failRunId ?? "",
			CHECKS_COLLISION: options.checksCollision ? "1" : "0",
			CHECKS_PATH: evidence.path ?? ".github/workflows/checks.yml",
			CHECKS_EVENT: evidence.event ?? "workflow_dispatch",
			CHECKS_BRANCH: evidence.branch ?? "v1.2.3",
			CHECKS_SHA: evidence.sha ?? "release-sha",
			CHECKS_TITLE: evidence.title ?? "Checks release gate 9001-2-checks",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return {
		exitCode,
		stdout,
		stderr,
		calls: fs.readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean),
		output: fs.readFileSync(outputPath, "utf8"),
	};
}

describe("release dispatch run correlation", () => {
	/** A pre-existing green run cannot mask the delayed red run created by this dispatch. */
	it("waits for and fails on the newly dispatched run instead of watching an old success", async () => {
		const result = await runFixture({ checksDelayPolls: 1, failRunId: "201" });

		expect(result.exitCode).toBe(23);
		expect(result.calls.filter(call => call === "run watch 201 --exit-status")).toHaveLength(1);
		expect(result.calls).not.toContain("run watch 101 --exit-status");
		expect(result.calls).not.toContain("workflow run ci.yml --ref v1.2.3");
		expect(result.output).toBe("");
	});

	/** A delayed successful Checks run is watched once before the single tagged CI dispatch. */
	it("preserves sequential Checks, then CI dispatch for a new successful run", async () => {
		const result = await runFixture({ checksDelayPolls: 2 });

		expect(result.exitCode).toBe(0);
		expect(result.calls.filter(call => call.startsWith("workflow run "))).toEqual([
			"workflow run checks.yml --ref v1.2.3 -f release_nonce=9001-2-checks",
			"workflow run ci.yml --ref v1.2.3",
		]);
		expect(result.calls.filter(call => call.startsWith("run watch "))).toEqual(["run watch 201 --exit-status"]);
		expect(result.output).toBe("tag=v1.2.3\n");
	});
	/** A concurrent exact-SHA dispatch cannot steal correlation without the cutter's unique nonce. */
	it("ignores a competing new run and watches its own correlated dispatch", async () => {
		const result = await runFixture({ checksCollision: true, checksDelayPolls: 1 });

		expect(result.exitCode).toBe(0);
		expect(result.calls).toContain(
			'api repos/owner/repo/actions/runs/301 --jq [.path, .event, .head_branch, .head_sha, .display_title] | join("|")',
		);
		expect(result.calls).not.toContain("run watch 301 --exit-status");
		expect(result.calls).toContain("run watch 201 --exit-status");
	});

	/** Every immutable-run identity field is mandatory and is validated before any watch or later dispatch. */
	it("fails closed on wrong workflow, event, tag ref, or SHA evidence", async () => {
		const cases: Array<[string, RunEvidence]> = [
			["workflow", { path: ".github/workflows/ci.yml" }],
			["event", { event: "push" }],
			["tag ref", { branch: "main" }],
			["SHA", { sha: "older-sha" }],
			["correlation title", { title: "Checks release gate another-cutter" }],
		];

		for (const [field, checksEvidence] of cases) {
			const result = await runFixture({ checksDelayPolls: 0, checksEvidence });
			expect(result.exitCode, `${field} evidence must fail`).not.toBe(0);
			expect(
				result.calls.filter(call => call.startsWith("run watch ")),
				field,
			).toEqual([]);
			expect(result.calls, field).not.toContain("workflow run ci.yml --ref v1.2.3");
		}
	});

	/** The nonce is usable only when the dispatched Checks workflow binds it into its run identity. */
	it("declares the correlation input and run name on the release gate", async () => {
		const workflow = Bun.YAML.parse(
			await Bun.file(path.join(repoRoot, ".github", "workflows", "checks.yml")).text(),
		) as {
			"run-name": string;
			on: { workflow_dispatch: { inputs: { release_nonce: { required: boolean; type: string } } } };
		};

		expect(workflow.on.workflow_dispatch.inputs.release_nonce).toMatchObject({
			required: false,
			type: "string",
		});
		expect(workflow["run-name"]).toContain("inputs.release_nonce");
		expect(workflow["run-name"]).toContain("format('{0} release gate {1}'");
	});
});
