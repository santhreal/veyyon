/**
 * WHY: the ensure-rust-toolchain composite action splits its `components` input
 * itself, and a caller writing the ordinary YAML spelling `clippy, rustfmt` once
 * reached rustup as the component " rustfmt". rustup answered `toolchain ... does
 * not contain component ' rustfmt'; did you mean 'rustfmt'?` and the whole Rust
 * gate went red on a leading space no type checker or linter can see.
 *
 * The class closed here is "the action mangles its component list". Every caller
 * in the repo is discovered from the workflow and action YAML at run time and
 * driven through the real step script under a rustup shim, so a new caller with a
 * new spelling is covered without anyone remembering to add a case, and a parsing
 * regression turns this file red rather than a CI job twenty minutes later.
 *
 * Not caught: whether the requested names are real rustup components (only rustup
 * knows that), and anything the action does once it has a genuine toolchain.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ACTION_PATH = ".github/actions/ensure-rust-toolchain/action.yml";
const ACTION_USES = "./.github/actions/ensure-rust-toolchain";
const TOOLCHAIN = "nightly-2026-04-29";

interface CompositeStep {
	name?: string;
	run?: string;
	uses?: string;
	with?: Record<string, string>;
}

interface CompositeAction {
	runs: { steps: CompositeStep[] };
}

interface WorkflowFile {
	jobs?: Record<string, { steps?: CompositeStep[] }>;
}

interface ActionRun {
	exitCode: number;
	/** Every rustup invocation, one array of argv per call, whitespace preserved. */
	calls: string[][];
	pathOutput: string;
	stderr: string;
}

interface RunOptions {
	components?: string;
	target?: string;
	installedComponents?: string[];
	installedTargets?: string[];
}

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function stepScript(): Promise<string> {
	const action = Bun.YAML.parse(await fs.promises.readFile(ACTION_PATH, "utf8")) as CompositeAction;
	const step = action.runs.steps.find(candidate => candidate.run);
	if (!step?.run) throw new Error(`${ACTION_PATH} has no executable step`);
	return step.run;
}

/**
 * Run the action's real script with rustup and rustc replaced by shims. The rustup
 * shim records argv one bracketed argument per call, so a stray space inside an
 * argument is visible instead of being swallowed by a joined command line.
 */
async function runAction(options: RunOptions = {}): Promise<ActionRun> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-rust-toolchain-"));
	tempRoots.push(root);
	const logPath = path.join(root, "rustup-calls");
	const pathFile = path.join(root, "github-path");
	const cargoPath = path.join(root, "toolchain", "bin", "cargo");

	fs.writeFileSync(
		path.join(root, "rustup"),
		`#!/bin/sh
{ for arg in "$@"; do printf '[%s]' "$arg"; done; printf '\\n'; } >> "$FAKE_RUSTUP_LOG"
case "$1 $2" in
  "component list") printf '%s' "$FAKE_INSTALLED_COMPONENTS" ;;
  "target list") printf '%s' "$FAKE_INSTALLED_TARGETS" ;;
esac
if [ "$1" = "which" ]; then printf '%s\\n' "$FAKE_CARGO_PATH"; fi
exit 0
`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(path.join(root, "rustc"), "#!/bin/sh\nprintf 'rustc 1.99.0-nightly\\n'\nexit 0\n", {
		mode: 0o755,
	});

	const proc = Bun.spawn(["bash", "-c", await stepScript()], {
		env: {
			...process.env,
			PATH: `${root}:${process.env.PATH ?? ""}`,
			TOOLCHAIN,
			COMPONENTS: options.components ?? "",
			TARGET: options.target ?? "",
			GITHUB_PATH: pathFile,
			FAKE_RUSTUP_LOG: logPath,
			FAKE_INSTALLED_COMPONENTS: (options.installedComponents ?? []).join("\n"),
			FAKE_INSTALLED_TARGETS: (options.installedTargets ?? []).join("\n"),
			FAKE_CARGO_PATH: cargoPath,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	const rawLog = await fs.promises.readFile(logPath, "utf8").catch(() => "");
	const calls = rawLog
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => [...line.matchAll(/\[([^\]]*)\]/g)].map(match => match[1] ?? ""));
	const pathOutput = await fs.promises.readFile(pathFile, "utf8").catch(() => "");
	return { exitCode, calls, pathOutput: pathOutput.trim(), stderr };
}

/** The component names the action asked rustup to install, in request order. */
function requestedComponents(run: ActionRun): string[] {
	const add = run.calls.find(call => call[0] === "component" && call[1] === "add");
	if (!add) return [];
	const toolchainAt = add.indexOf("--toolchain");
	return add.slice(toolchainAt + 2);
}

/** Every `components:` value handed to this action anywhere in the repo. */
async function declaredComponentInputs(): Promise<{ source: string; components: string }[]> {
	const found: { source: string; components: string }[] = [];
	const workflows = fs.readdirSync(".github/workflows").filter(name => /\.ya?ml$/.test(name));
	for (const name of workflows) {
		const file = Bun.YAML.parse(
			await fs.promises.readFile(path.join(".github/workflows", name), "utf8"),
		) as WorkflowFile;
		for (const [jobId, job] of Object.entries(file.jobs ?? {})) {
			for (const step of job.steps ?? []) {
				if (step.uses !== ACTION_USES) continue;
				found.push({ source: `${name}::${jobId}`, components: step.with?.components ?? "" });
			}
		}
	}
	const actionDirs = fs.readdirSync(".github/actions", { withFileTypes: true }).filter(entry => entry.isDirectory());
	for (const dir of actionDirs) {
		const file = path.join(".github/actions", dir.name, "action.yml");
		if (!fs.existsSync(file)) continue;
		const action = Bun.YAML.parse(await fs.promises.readFile(file, "utf8")) as CompositeAction;
		for (const step of action.runs?.steps ?? []) {
			if (step.uses !== ACTION_USES) continue;
			found.push({ source: `actions/${dir.name}`, components: step.with?.components ?? "" });
		}
	}
	return found;
}

describe("ensure-rust-toolchain component parsing", () => {
	/** The spelling every YAML author writes must reach rustup as two clean names. */
	it("trims the space after a comma", async () => {
		const run = await runAction({ components: "clippy, rustfmt" });
		expect(run.exitCode).toBe(0);
		expect(requestedComponents(run)).toEqual(["clippy", "rustfmt"]);
	});

	/** The compact spelling is not a different feature; both parse identically. */
	it("parses the compact spelling the same way", async () => {
		const run = await runAction({ components: "clippy,rustfmt" });
		expect(requestedComponents(run)).toEqual(["clippy", "rustfmt"]);
	});

	/** Sloppy separators are the author's habit, not a toolchain request. */
	it("drops empty fields from ragged separators", async () => {
		const run = await runAction({ components: "  clippy ,, rustfmt  " });
		expect(requestedComponents(run)).toEqual(["clippy", "rustfmt"]);
	});

	/** No requested name may carry surrounding whitespace, whatever the input. */
	it("never asks rustup for a name with surrounding whitespace", async () => {
		for (const input of ["clippy, rustfmt", "clippy,rustfmt", " clippy , rustfmt ", "rust-src, clippy, rustfmt"]) {
			const requested = requestedComponents(await runAction({ components: input }));
			expect(requested.length).toBeGreaterThan(0);
			for (const name of requested) expect(name).toBe(name.trim());
		}
	});

	/** An installed component must not be reinstalled on every job. */
	it("adds only the components the toolchain is missing", async () => {
		const run = await runAction({ components: "clippy, rustfmt", installedComponents: ["clippy"] });
		expect(requestedComponents(run)).toEqual(["rustfmt"]);
	});

	/** A component whose installed name carries a target suffix still counts as present. */
	it("treats a target-suffixed installed name as present", async () => {
		const run = await runAction({
			components: "clippy, rustfmt",
			installedComponents: ["clippy-x86_64-unknown-linux-gnu", "rustfmt-x86_64-unknown-linux-gnu"],
		});
		expect(requestedComponents(run)).toEqual([]);
	});

	/** A caller that wants no components must not trigger a component install at all. */
	it("asks for no components when the input is empty", async () => {
		const run = await runAction();
		expect(run.exitCode).toBe(0);
		expect(run.calls.some(call => call[0] === "component" && call[1] === "add")).toBe(false);
	});

	/** The point of the action is the PATH entry; parsing must not cost it. */
	it("puts the toolchain bin directory on the job PATH", async () => {
		const run = await runAction({ components: "clippy, rustfmt" });
		expect(run.pathOutput).toMatch(/[/\\]toolchain[/\\]bin$/);
	});

	/** A target is installed only when it is absent, by the same present-or-add rule. */
	it("adds a missing target and skips an installed one", async () => {
		const missing = await runAction({ target: "aarch64-apple-darwin" });
		expect(missing.calls.some(call => call[0] === "target" && call[1] === "add")).toBe(true);
		const present = await runAction({
			target: "aarch64-apple-darwin",
			installedTargets: ["aarch64-apple-darwin"],
		});
		expect(present.calls.some(call => call[0] === "target" && call[1] === "add")).toBe(false);
	});
});

describe("every caller of ensure-rust-toolchain", () => {
	/** A caller must exist, or this file's derived coverage is vacuous. */
	it("is discovered from the repository, not a hardcoded list", async () => {
		const callers = await declaredComponentInputs();
		expect(callers.length).toBeGreaterThan(0);
		expect(callers.some(caller => caller.components.length > 0)).toBe(true);
	});

	/** Whatever spelling a caller uses, rustup receives exactly the names meant. */
	it("reaches rustup as the names its YAML lists", async () => {
		for (const caller of await declaredComponentInputs()) {
			const expected = caller.components
				.split(/[,\s]+/)
				.map(name => name.trim())
				.filter(name => name.length > 0);
			const run = await runAction({ components: caller.components });
			expect(run.exitCode, `${caller.source} failed the action script`).toBe(0);
			expect(requestedComponents(run), `${caller.source} requested the wrong components`).toEqual(expected);
		}
	});
});
