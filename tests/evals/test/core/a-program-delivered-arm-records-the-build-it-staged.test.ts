/**
 * WHY: pier wrote `binary_sha: (options.binarySha) ?? stagedVeyBinary ?? "nosha"` for every
 * arm, and a program-delivered arm reaches neither of the first two: it stages its own
 * binary through its container program and never touches the vey binary. The nine-trial
 * comparison therefore recorded `"nosha"` for all three omp trials, and the report's arm
 * provenance row read `unrecorded` — three finished trials that could not say which build
 * they measured, next to two veyyon arms that could.
 *
 * CLASS: an arm whose recorded build provenance is not the bytes it ran. The sweep
 * enumerates the harness registry at run time and stages each container program from the
 * program's own asset list, so a second program-delivered harness turns this suite red until
 * it names the asset holding its build. The opt-out set is pinned by exact equality, so a
 * harness that declares no build is a recorded decision rather than a silent gap.
 *
 * NOT CAUGHT: harbor records no build provenance for any harness, program-delivered or
 * bespoke, so there is nothing there to be wrong yet; this suite covers pier's job config
 * and the core staging rule. It also does not prove the container ran the bytes that were
 * hashed — no container starts here.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PierExecutionBackend } from "../../backends/pier/main";
import * as pierRunner from "../../backends/pier/runner";
import {
	CONTAINER_PROGRAM_VERSION,
	type ContainerProgram,
	ContainerProgramError,
	containerProgramPath,
	type ProgramFile,
	programBinarySha,
	programDirFor,
	stageContainerProgram,
	validateContainerProgram,
} from "../../engine/container-program";
import type { EvalSuite, HarnessAdapter, RunContext, TrialCell, Variant } from "../../engine/contracts";
import { harnesses } from "../../engine/loaded-members";

const RUN_ID = "records-the-build";
const MODEL = "vendor/model-x";

/** Harnesses that ship a container program and so stage their own build. */
function programHarnesses(): readonly HarnessAdapter[] {
	return harnesses.list().filter(harness => harness.containerProgram !== undefined);
}

/** Distinct bytes per asset, so a digest of the wrong file is a visible mismatch. */
function fixtureBytes(harness: string, file: string): string {
	return `staged bytes for ${harness}/${file}\n`;
}

function sha256Of(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Stages a harness's program with synthetic bytes for every required asset.
 *
 * The harness's own file sourcing wants a real binary on the host, which a sweep cannot
 * supply for an arbitrary harness. Staging the program's declared asset list instead keeps
 * the sweep generic: what is under test is the rule that the recorded digest is the digest
 * of the staged asset the program names.
 */
function stageWithFixtures(harness: HarnessAdapter, dir: string): ContainerProgram {
	const built = harness.containerProgram?.({ model: MODEL, options: {} });
	if (!built) throw new Error(`harness ${harness.id} declares no container program`);
	const files: ProgramFile[] = built.program.assets
		.filter(asset => !asset.optional)
		.map(asset => ({ file: asset.file, source: { text: fixtureBytes(harness.id, asset.file) } }));
	stageContainerProgram(dir, { program: built.program, files });
	return built.program;
}

function stubSuite(): EvalSuite {
	return {
		id: "provenance-suite",
		version: "1.0.0",
		displayName: "Provenance",
		description: "Stub suite for the build-provenance sweep.",
		backend: "pier",
		async discoverTasks() {
			return ["record-the-build"];
		},
		async describeTask(taskId: string) {
			return {
				id: taskId,
				path: "/dataset/record-the-build",
				timeBudgetSec: 600,
				instructionPath: null,
				metadata: {},
			};
		},
		async provenance() {
			return { suite: "provenance-suite", version: "1.0.0", sha: "stub" };
		},
		async scoreTrial() {
			return { reward: 0, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight() {
			return { ok: true };
		},
	};
}

let runsDir = "";
let workDir = "";

function variantFor(harness: string, name: string): Variant {
	return { name, harness, configPath: null, promptVariantPath: null, attachments: [], model: MODEL };
}

function contextFor(harness: string, options: Record<string, unknown> = {}): RunContext {
	return {
		runId: RUN_ID,
		suite: stubSuite(),
		workDir,
		runsDir,
		harnesses,
		options: {
			variants: [variantFor(harness, "baseline")],
			install: "published",
			...options,
		},
	};
}

function cellFor(variant: string): TrialCell {
	return { variant, suite: "provenance-suite", task: "record-the-build", repeat: 1 };
}

/** The `binary_sha` kwarg pier wrote into the config for `jobName`'s arm. */
function recordedBinarySha(variant = "baseline"): string {
	const configsDir = path.join(runsDir, RUN_ID, "configs");
	const names = fs.readdirSync(configsDir).filter(name => name.includes(`__${variant}__`));
	expect(names.length).toBe(1);
	const text = fs.readFileSync(path.join(configsDir, names[0] as string), "utf8");
	const match = /^\s+binary_sha:\s*"([^"]*)"$/m.exec(text);
	if (!match) throw new Error(`no binary_sha kwarg in pier config:\n${text}`);
	return match[1] as string;
}

/** Runs trials with pier's own subprocess stubbed out, leaving their configs on disk. */
async function runTrialsForConfig(
	context: RunContext,
	variants: readonly string[] = ["baseline"],
	backend = new PierExecutionBackend(),
): Promise<void> {
	const trialDir = path.join(runsDir, RUN_ID, "jobs", "job");
	const runStub = spyOn(pierRunner, "runPierTrial").mockResolvedValue({
		exitCode: 0,
		stdout: "",
		stderr: "",
		trialDirPath: trialDir,
		durationMs: 1,
		timedOut: false,
		error: null,
	});
	const artifactsStub = spyOn(pierRunner, "trialArtifactsFromExecution").mockReturnValue({
		logPaths: [],
		trialDir,
	});
	try {
		for (const variant of variants) {
			await backend.runTrial(cellFor(variant), context).catch(() => {});
		}
	} finally {
		runStub.mockRestore();
		artifactsStub.mockRestore();
	}
}

function minimalProgram(overrides: Partial<ContainerProgram> = {}): ContainerProgram {
	return {
		version: CONTAINER_PROGRAM_VERSION,
		harness: "omp",
		containerDir: "/agent",
		assets: [
			{ file: "agent", dest: "/agent/agent", mode: "0755" },
			{ file: "extras", dest: "/agent/extras", optional: true },
		],
		setup: [],
		command: "{{assets}}/agent {{instruction}}",
		logPath: "/logs/agent/agent.txt",
		sessions: { sources: ["/tmp/sessions"], pattern: "*.jsonl" },
		allowedDomains: [],
		usage: "omp",
		...overrides,
	};
}

describe("a program-delivered arm records the build it staged", () => {
	beforeEach(() => {
		runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-provenance-runs-"));
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-provenance-work-"));
	});

	afterEach(() => {
		fs.rmSync(runsDir, { recursive: true, force: true });
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("every harness with a container program names the asset holding its build", () => {
		const harnesses = programHarnesses();
		expect(harnesses.length).toBeGreaterThan(0);

		const declaring: string[] = [];
		const silent: string[] = [];
		for (const harness of harnesses) {
			const built = harness.containerProgram?.({ model: MODEL, options: {} });
			const asset = built?.program.binaryAsset;
			if (asset === undefined) {
				silent.push(harness.id);
				continue;
			}
			declaring.push(harness.id);
			const named = built?.program.assets.find(candidate => candidate.file === asset);
			expect(named, `${harness.id} names ${asset}, which it does not declare as an asset`).toBeDefined();
			expect(named?.optional ?? false).toBe(false);

			// A digest of bytes the command never invokes is provenance for something else.
			const invocations = [`{{assets}}/${asset}`, named?.dest ?? ""];
			expect(
				invocations.some(form => form !== "" && built?.program.command.includes(form)),
				`${harness.id} names ${asset} as its build but runs ${built?.program.command}`,
			).toBe(true);
		}

		expect(declaring).toEqual(["omp"]);
		// A harness whose agent is installed by its setup lines has no staged build to hash.
		// Adding one is a decision recorded here, not a row that quietly reads "nosha".
		expect(silent).toEqual([]);
	});

	it("reads the digest off the staged bytes, for every program harness", () => {
		for (const harness of programHarnesses()) {
			const dir = path.join(runsDir, "staged", harness.id);
			const program = stageWithFixtures(harness, dir);
			const asset = program.binaryAsset as string;

			const recorded = programBinarySha(dir);

			expect(recorded).toBe(sha256Of(fixtureBytes(harness.id, asset)));
			expect(recorded).toMatch(/^[0-9a-f]{64}$/);
			expect(recorded).not.toBe("nosha");
		}
	});

	it("follows the staged bytes when they change under the same path", () => {
		const harness = programHarnesses()[0] as HarnessAdapter;
		const dir = path.join(runsDir, "rebuilt", harness.id);
		const program = stageWithFixtures(harness, dir);
		const first = programBinarySha(dir);

		fs.writeFileSync(path.join(dir, program.binaryAsset as string), "a different build\n");

		const second = programBinarySha(dir);
		expect(second).toBe(sha256Of("a different build\n"));
		expect(second).not.toBe(first);
	});

	it("declares no build when the program names none", () => {
		const dir = path.join(runsDir, "no-binary-asset");
		stageContainerProgram(dir, {
			program: minimalProgram({ binaryAsset: undefined }),
			files: [{ file: "agent", source: { text: "bytes\n" } }],
		});

		expect(programBinarySha(dir)).toBeNull();
	});

	it("refuses a program whose named build is not an asset it declares", () => {
		expect(() => validateContainerProgram(minimalProgram({ binaryAsset: "not-declared" }))).toThrow(
			ContainerProgramError,
		);
		expect(() => validateContainerProgram(minimalProgram({ binaryAsset: "not-declared" }))).toThrow(
			/names no declared asset/,
		);
	});

	it("refuses a program whose named build is optional", () => {
		expect(() => validateContainerProgram(minimalProgram({ binaryAsset: "extras" }))).toThrow(
			/names an optional asset/,
		);
	});

	it("refuses a staged directory that is missing the build it declares", () => {
		const dir = path.join(runsDir, "missing-build");
		stageContainerProgram(dir, {
			program: minimalProgram({ binaryAsset: "agent" }),
			files: [{ file: "agent", source: { text: "bytes\n" } }],
		});
		fs.rmSync(path.join(dir, "agent"));

		expect(() => programBinarySha(dir)).toThrow(/was never staged/);
	});

	it("reports no build for a directory holding no staged program", () => {
		const dir = path.join(runsDir, "nothing-staged");
		fs.mkdirSync(dir, { recursive: true });

		// A trial whose staging never ran fails on the program its agent cannot load.
		// Provenance answers null there instead of deciding the trial's outcome.
		expect(programBinarySha(dir)).toBeNull();
	});

	it("records no build, and still runs, when a program arm was never staged", async () => {
		const harness = programHarnesses().find(candidate => candidate.backends.pier) as HarnessAdapter;

		await runTrialsForConfig(contextFor(harness.id));

		expect(recordedBinarySha()).toBe("nosha");
	});

	it("writes the staged digest into the trial's pier config, for every program harness", async () => {
		for (const harness of programHarnesses()) {
			if (!harness.backends.pier) continue;
			fs.rmSync(path.join(runsDir, RUN_ID), { recursive: true, force: true });
			const assetsDir = path.join(runsDir, RUN_ID, "assets");
			const program = stageWithFixtures(harness, programDirFor(assetsDir, harness.id, "baseline"));

			await runTrialsForConfig(contextFor(harness.id));

			expect(recordedBinarySha()).toBe(sha256Of(fixtureBytes(harness.id, program.binaryAsset as string)));
		}
	});

	it("keeps a program arm's own digest when the run also names a vey binary", async () => {
		const harness = programHarnesses().find(candidate => candidate.backends.pier) as HarnessAdapter;
		const assetsDir = path.join(runsDir, RUN_ID, "assets");
		const program = stageWithFixtures(harness, programDirFor(assetsDir, harness.id, "baseline"));
		const veySha = "f".repeat(64);

		// A mixed run stages a vey binary for its veyyon arms and passes its digest in the
		// options. Stamping that digest onto a program arm records a build it never ran.
		await runTrialsForConfig(contextFor(harness.id, { binarySha: veySha }));

		const recorded = recordedBinarySha();
		expect(recordedBinarySha()).toBe(sha256Of(fixtureBytes(harness.id, program.binaryAsset as string)));
		expect(recorded).not.toBe(veySha);
	});

	it("still records the run's binary for a bespoke arm", async () => {
		const veySha = "a".repeat(64);

		await runTrialsForConfig(contextFor("veyyon", { binarySha: veySha }));

		expect(recordedBinarySha()).toBe(veySha);
	});

	it("names the staged program in the config it wrote", async () => {
		const harness = programHarnesses().find(candidate => candidate.backends.pier) as HarnessAdapter;
		const programDir = programDirFor(path.join(runsDir, RUN_ID, "assets"), harness.id, "baseline");
		stageWithFixtures(harness, programDir);

		await runTrialsForConfig(contextFor(harness.id));

		const configsDir = path.join(runsDir, RUN_ID, "configs");
		const text = fs.readFileSync(path.join(configsDir, fs.readdirSync(configsDir)[0] as string), "utf8");
		expect(text).toContain(JSON.stringify(containerProgramPath(programDir)));
	});

	it("records each arm's own build when one backend runs two of them", async () => {
		const harness = programHarnesses().find(candidate => candidate.backends.pier) as HarnessAdapter;
		const assetsDir = path.join(runsDir, RUN_ID, "assets");
		const program = stageWithFixtures(harness, programDirFor(assetsDir, harness.id, "baseline"));
		const asset = program.binaryAsset as string;
		const secondDir = programDirFor(assetsDir, harness.id, "second");
		stageWithFixtures(harness, secondDir);
		fs.writeFileSync(path.join(secondDir, asset), "the second arm's build\n");

		// One backend instance runs every trial in a run, so a digest cached per run instead
		// of per staged program would stamp the first arm's build onto the second.
		const context = contextFor(harness.id, {
			variants: [variantFor(harness.id, "baseline"), variantFor(harness.id, "second")],
		});
		await runTrialsForConfig(context, ["baseline", "second"]);

		expect(recordedBinarySha("baseline")).toBe(sha256Of(fixtureBytes(harness.id, asset)));
		expect(recordedBinarySha("second")).toBe(sha256Of("the second arm's build\n"));
	});
});
