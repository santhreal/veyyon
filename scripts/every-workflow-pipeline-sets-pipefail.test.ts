/**
 * Every shell pipeline in a GitHub Actions step runs with `pipefail` set.
 *
 * A `run:` step with no `shell:` is executed as `bash -e {0}`. Naming the shell
 * (`shell: bash`) is what makes the runner use
 * `bash --noprofile --norc -eo pipefail {0}` instead. The two differ by exactly
 * one option, and it is the one that decides whether a pipeline can lie: under
 * `-e` alone a pipeline reports the exit status of its LAST command, so
 * `curl ... | tar ...` or `gh api ... | jq ...` exits 0 whenever the left side
 * died but the right side was happy with what little it got.
 *
 * docs.yml's `Install mdbook` step piped a GitHub release download straight
 * into `tar` under the default shell. It was the only step in the repo standing
 * in that gap, and the gap is the same class of hole that stalled six releases:
 * a step that reports success for work it did not do. The fix was one line,
 * `shell: bash`, which is why nothing stops it from being dropped again.
 *
 * So this reads every workflow and composite action AS YAML DATA, resolves each
 * step's shell the way the runner does, finds the real pipeline operators in the
 * script, and fails when a bash-family step composes commands with a pipe and
 * neither the shell nor the script has turned `pipefail` on.
 *
 * If this regresses, a setup step downloads nothing, reports green, and the
 * failure surfaces several steps later as something unrelated - or does not
 * surface at all, when the right-hand side of the pipe tolerates empty input.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");
const ACTIONS_DIR = path.join(REPO_ROOT, ".github", "actions");

interface ActionsStep {
	name?: string;
	run?: string;
	shell?: string;
	uses?: string;
}

interface ActionsDefaults {
	run?: { shell?: string };
}

interface ActionsJob {
	steps?: ActionsStep[];
	defaults?: ActionsDefaults;
}

interface ActionsDocument {
	defaults?: ActionsDefaults;
	jobs?: Record<string, ActionsJob>;
	runs?: { steps?: ActionsStep[] };
}

/** One `run:` step, with everything needed to judge its pipelines. */
interface RunStep {
	/** `ci.yml` or `actions/build-native`, for a failure message that locates itself. */
	file: string;
	job: string;
	name: string;
	/** As resolved by the runner: `""` means the step named no shell. */
	shell: string;
	script: string;
}

/** A pipe that composes two commands, as opposed to one that is data. */
interface Pipeline {
	/** 1-based line within the step's script. */
	line: number;
	text: string;
}

/** A step that pipes without `pipefail`. This is the whole finding. */
interface Violation {
	step: string;
	shell: string;
	pipeline: string;
}

/**
 * Does this step run with `pipefail` in effect?
 *
 * Three ways to get it, and the first is the one that is easy to miss: the bare
 * word `bash` is not the default shell, it is a REQUEST for
 * `--noprofile --norc -eo pipefail`. A custom template (`bash -o pipefail {0}`)
 * says so itself, and a script may simply `set -o pipefail`.
 */
function hasPipefail(shell: string, script: string): boolean {
	if (shell === "bash") return true;
	if (shell.includes("pipefail")) return true;
	return /(^|[;&\n])\s*set\s+-[A-Za-z]*o\s+pipefail(\s|$|;)/m.test(script);
}

/**
 * The pipeline operators in a script, ignoring every `|` that is not one.
 *
 * Four shapes have to be told apart, and all four are in this repo:
 *   - `||`, which is a logical OR
 *   - a `|` inside quotes, such as a `--jq '.[] | .name'` filter
 *   - a `|` in a `case` arm pattern, such as `""|"."|".."` before the paren
 *   - a `|` inside a comment
 * Getting any of them wrong turns this gate into noise, and the response to a
 * noisy gate is to delete it.
 */
function pipelines(script: string): Pipeline[] {
	const found: Pipeline[] = [];
	const lines = script.split("\n");
	let caseDepth = 0;
	let awaitingCaseIn = false;
	let inCasePattern = false;
	for (const [index, line] of lines.entries()) {
		let word = "";
		let previous = "";
		let quote: '"' | "'" | null = null;
		const flush = () => {
			if (word === "case") {
				caseDepth += 1;
				awaitingCaseIn = true;
			} else if (word === "in" && awaitingCaseIn) {
				awaitingCaseIn = false;
				inCasePattern = true;
			} else if (word === "esac" && caseDepth > 0) {
				caseDepth -= 1;
				inCasePattern = false;
			}
			word = "";
		};
		for (let i = 0; i < line.length; i++) {
			const ch = line[i]!;
			if (quote) {
				// A backslash escapes inside "" but is literal inside ''.
				if (ch === "\\" && quote === '"') i += 1;
				else if (ch === quote) quote = null;
				continue;
			}
			if (ch === "\\") {
				i += 1;
				previous = "";
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				previous = ch;
				continue;
			}
			if (ch === "#" && (i === 0 || /[\s;&(]/.test(previous))) break;
			if (ch === "|") {
				flush();
				if (line[i + 1] === "|") {
					i += 1;
					previous = "|";
					continue;
				}
				// `>|` overrides noclobber; the pipe belongs to the redirect.
				if (previous !== ">" && !inCasePattern) found.push({ line: index + 1, text: line.trim() });
				previous = "|";
				continue;
			}
			if (ch === ";") {
				flush();
				if (line[i + 1] === ";") {
					i += 1;
					if (caseDepth > 0) inCasePattern = true;
				}
				previous = ";";
				continue;
			}
			if (ch === ")") {
				flush();
				if (inCasePattern) inCasePattern = false;
				previous = ")";
				continue;
			}
			if (/[\s&(]/.test(ch)) {
				flush();
				previous = ch;
				continue;
			}
			word += ch;
			previous = ch;
		}
		flush();
	}
	return found;
}

/** Every `run:` step in a workflow document, with its shell already resolved. */
function workflowSteps(file: string, doc: ActionsDocument): RunStep[] {
	const found: RunStep[] = [];
	for (const [job, definition] of Object.entries(doc.jobs ?? {})) {
		for (const step of definition.steps ?? []) {
			if (typeof step.run !== "string") continue;
			found.push({
				file,
				job,
				name: step.name ?? "(unnamed)",
				shell: step.shell ?? definition.defaults?.run?.shell ?? doc.defaults?.run?.shell ?? "",
				script: step.run,
			});
		}
	}
	return found;
}

/**
 * Every `run:` step in a composite action. GitHub requires `shell:` on each one,
 * so these cannot inherit the `bash -e` default, but they can still name a shell
 * that has no `pipefail` - and they run inside the same jobs.
 */
function compositeSteps(name: string, doc: ActionsDocument): RunStep[] {
	return (doc.runs?.steps ?? [])
		.filter(step => typeof step.run === "string")
		.map(step => ({
			file: `actions/${name}`,
			job: "runs",
			name: step.name ?? "(unnamed)",
			shell: step.shell ?? "",
			script: step.run as string,
		}));
}

function violations(steps: RunStep[]): Violation[] {
	const found: Violation[] = [];
	for (const step of steps) {
		// `pwsh` and `python` steps have their own error handling (the Windows
		// verify steps check `$LASTEXITCODE` explicitly) and no `pipefail` to set,
		// so they are a different question. An unnamed shell is `bash -e {0}`.
		if (step.shell !== "" && !/^(bash|sh)(\s|$)/.test(step.shell)) continue;
		if (hasPipefail(step.shell, step.script)) continue;
		for (const pipeline of pipelines(step.script)) {
			found.push({
				step: `${step.file}::${step.job}::${step.name}`,
				shell: step.shell === "" ? "(unspecified: bash -e, no pipefail)" : step.shell,
				pipeline: pipeline.text,
			});
		}
	}
	return found;
}

/** Run the checker over a workflow written inline. */
function check(yaml: string, file = "fixture.yml"): Violation[] {
	return violations(workflowSteps(file, Bun.YAML.parse(yaml) as ActionsDocument));
}

const workflowText = (name: string) => fs.readFileSync(path.join(WORKFLOWS_DIR, name), "utf8");

const REAL_STEPS: RunStep[] = [
	...fs
		.readdirSync(WORKFLOWS_DIR)
		.filter(name => name.endsWith(".yml") || name.endsWith(".yaml"))
		.sort()
		.flatMap(name => workflowSteps(name, Bun.YAML.parse(workflowText(name)) as ActionsDocument)),
	...fs
		.readdirSync(ACTIONS_DIR, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort()
		.flatMap(name => {
			const manifest = path.join(ACTIONS_DIR, name, "action.yml");
			if (!fs.existsSync(manifest)) return [];
			return compositeSteps(name, Bun.YAML.parse(fs.readFileSync(manifest, "utf8")) as ActionsDocument);
		}),
];

describe("every pipeline in .github runs with pipefail", () => {
	it("holds across every workflow and composite action in the repo", () => {
		expect(violations(REAL_STEPS)).toEqual([]);
	});

	/**
	 * Proves the clean result above is earned rather than vacuous, twice over: a
	 * checker that parsed nothing would report no steps, and one that had stopped
	 * recognising a pipe would report no pipelines.
	 */
	it("actually parsed the workflows and found their pipelines", () => {
		expect(REAL_STEPS.length).toBeGreaterThan(100);
		const piping = REAL_STEPS.filter(step => pipelines(step.script).length > 0);
		expect(piping.map(step => `${step.file}::${step.job}::${step.name}`).sort()).toEqual([
			"actions/bun-install::runs::Install bun when absent",
			"actions/ensure-rust-toolchain::runs::(unnamed)",
			"checks.yml::secrets::Install gitleaks",
			"ci.yml::native_artifact_lookup::Compute native source hash",
			"ci.yml::native_artifact_lookup::Find prior main build with matching native artifacts",
			"ci.yml::release_github::Create or resume the immutable draft release",
			"ci.yml::release_github_publish::Publish the exact verified draft",
			"ci.yml::release_github_verify_windows::Launch the published windows-x64 binary (forces native-addon load)",
			"ci.yml::release_metadata::Detect release tag at HEAD",
			"ci.yml::release_train_alert::File or clear the pinned release-train issue",
			"docs.yml::book-staleness::Install mdbook",
		]);
	});

	/**
	 * The real regression, replayed against the real file. Delete the one line
	 * that was added to fix the mdbook download and the gate names that step and
	 * only that step.
	 */
	it("flags the real mdbook download the moment its shell goes unnamed again", () => {
		const unfixed = workflowText("docs.yml").replace(/^ +shell: bash\n/m, "");
		expect(unfixed).not.toEqual(workflowText("docs.yml"));
		expect(check(unfixed, "docs.yml")).toEqual([
			{
				step: "docs.yml::book-staleness::Install mdbook",
				shell: "(unspecified: bash -e, no pipefail)",
				pipeline: '| tar -xz -C "$HOME/.local/bin"',
			},
		]);
	});
});

describe("the checker", () => {
	const piping = (extra: string) => `name: fixture
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - name: Install a tool
${extra}
        run: |
          mkdir -p "$HOME/bin"
          curl -fsSL https://example.invalid/tool.tar.gz | tar -xz -C "$HOME/bin"
`;

	it("catches a download piped into an extractor under the default shell", () => {
		expect(check(piping(""))).toEqual([
			{
				step: "fixture.yml::setup::Install a tool",
				shell: "(unspecified: bash -e, no pipefail)",
				pipeline: 'curl -fsSL https://example.invalid/tool.tar.gz | tar -xz -C "$HOME/bin"',
			},
		]);
	});

	it("accepts the same script once the step names bash", () => {
		expect(check(piping("        shell: bash"))).toEqual([]);
	});

	it("accepts a default-shell script that sets pipefail itself", () => {
		expect(
			check(`name: fixture
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - name: Install a tool
        run: |
          set -euo pipefail
          curl -fsSL https://example.invalid/tool.tar.gz | tar -xz
`),
		).toEqual([]);
	});

	it("accepts a custom shell template that spells pipefail out", () => {
		expect(check(piping("        shell: bash --noprofile --norc -eo pipefail {0}"))).toEqual([]);
	});

	it("honours a shell named once in the job or workflow defaults", () => {
		const jobDefault = `name: fixture
defaults:
  run:
    shell: bash
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsSL https://example.invalid/x | tar -xz
`;
		expect(check(jobDefault)).toEqual([]);
	});

	it("leaves pwsh steps alone, because pipefail is not a thing they have", () => {
		expect(
			check(`name: fixture
jobs:
  verify:
    runs-on: windows-latest
    steps:
      - name: Read the version
        shell: pwsh
        run: |
          $actual = (& .\\tool.exe --version | Out-String).Trim()
          if ($LASTEXITCODE -ne 0) { throw "failed" }
`),
		).toEqual([]);
	});

	/** `||` is two pipes and no pipeline. Splitting on `|` would see one. */
	it("does not mistake a logical OR for a pipeline", () => {
		expect(
			check(`name: fixture
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: |
          [ -f "$f" ] || exit 1
          [ "$a" != true ] || [ "$b" != true ] || echo both
`),
		).toEqual([]);
	});

	/** A `--jq` filter is data. This is the shape that is everywhere in ci.yml. */
	it("does not mistake a quoted jq filter for a pipeline", () => {
		expect(
			check(`name: fixture
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: |
          id="$(gh api "repos/$R/releases" --jq '.[] | select(.draft) | .id')"
          echo "$id"
`),
		).toEqual([]);
	});

	/** `case` arms alternate patterns with `|`. ci.yml's publish step does exactly this. */
	it("does not mistake case-arm alternation for a pipeline", () => {
		expect(
			check(`name: fixture
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: |
          case "$name" in
            ""|"."|".."|*/*)
              echo "unsafe"
              exit 1
              ;;
            *.sha256|*.asc)
              echo sidecar
              ;;
          esac
`),
		).toEqual([]);
	});

	/** ...but a real pipe in a case ARM BODY is still a pipeline. */
	it("still sees a pipeline inside a case arm body", () => {
		expect(
			check(`name: fixture
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: |
          case "$name" in
            *.tar.gz|*.tgz)
              cat "$name" | tar -tz
              ;;
          esac
`),
		).toEqual([
			{
				step: "fixture.yml::setup::(unnamed)",
				shell: "(unspecified: bash -e, no pipefail)",
				pipeline: 'cat "$name" | tar -tz',
			},
		]);
	});

	it("does not read a pipe out of a comment", () => {
		expect(
			check(`name: fixture
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: |
          # Do not write this as curl | tar; capture the file first.
          curl -fsSL https://example.invalid/x -o x.tgz
          tar -xzf x.tgz
`),
		).toEqual([]);
	});
});
