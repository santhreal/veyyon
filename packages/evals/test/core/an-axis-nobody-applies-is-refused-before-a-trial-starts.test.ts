/**
 * WHY THIS SUITE EXISTS. The variant matrix is a product of five axes, but only the harness
 * and the model reach every backend. A config overlay, a prompt-variant overlay and an arm
 * attachment each need a reader: the in-process backend reads a config overlay and prompt
 * overrides, pier reads a config overlay and stages attachments, harbor reads none of the
 * three. Each harness adapter also declared `promptOverrides` and `armAttachments`, and
 * nothing anywhere read either declaration.
 *
 * So `--prompts a.json,b.json` against a harbor suite expanded the matrix, named the cells
 * apart, ran the identical trial twice, and reported the difference between two identical
 * arms as a result. A run that finishes and lies is worse than one that crashes.
 *
 * THE CLASS: a matrix axis that reaches no applier. Every member of `VARIANT_AXES` is swept
 * here rather than the one reported, both refusing parties are covered (a backend that
 * drops the axis outright and a harness whose capability is false), and the per-backend and
 * per-harness declarations are pinned by exact equality, so a new backend, a new harness or
 * a new axis turns this suite red until someone records what applies it. The ordering is
 * asserted at `executeRun`, whose refusal must land before any preflight runs, and at both
 * CLI paths: the dry run's `axes` verdict line and the real run's refusal.
 *
 * WHAT IT DOES NOT CATCH: whether a backend that claims an axis applies it correctly — that
 * a config overlay reaches the agent's settings is the backend's own suite — and the content
 * of an overlay file, which the backend preflight validates.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { TempDir } from "@veyyon/utils";
import { registerAllBackends } from "../../src/backends";
import { main } from "../../src/cli";
import type {
	EvalSuite,
	ExecutionBackend,
	HarnessCapabilities,
	PreflightVerdict,
	TaskDescriptor,
	TrialArtifacts,
	TrialScore,
	Variant,
	VariantAxis,
} from "../../src/core";
import { requireBackend, requireHarness } from "../../src/core";
import {
	checkVariantSupport,
	UnappliedVariantAxisError,
	VARIANT_AXES,
	VARIANT_AXIS_CAPABILITY,
	VARIANT_AXIS_LABEL,
	variantAxisValue,
	variantSupportQuery,
	variedAxes,
} from "../../src/core/variant-support";
import { registerBuiltinHarnesses } from "../../src/harnesses";
import { buildRunPlan, executeRun } from "../../src/run";

registerBuiltinHarnesses();
registerAllBackends();

const MODEL = "anthropic/claude-sonnet-4-6";

/** Builds a variant that sets exactly one axis, so a sweep can name the axis it varies. */
function variantVarying(axis: VariantAxis | null, harness = "veyyon"): Variant {
	return {
		name: axis === null ? "base" : `varies-${axis}`,
		harness,
		configPath: axis === "config" ? "/overlays/a.yml" : null,
		promptVariantPath: axis === "promptVariant" ? "/overlays/a.json" : null,
		model: MODEL,
		attachments: axis === "attachments" ? ["prompt/extra.prompt.md"] : [],
	};
}

const ALL_TRUE: HarnessCapabilities = {
	replay: true,
	compaction: true,
	armAttachments: true,
	promptOverrides: true,
};

const ALL_FALSE: HarnessCapabilities = {
	replay: false,
	compaction: false,
	armAttachments: false,
	promptOverrides: false,
};

const AXES: VariantAxis[] = [...VARIANT_AXES];

describe("every axis a variant carries", () => {
	it("is set by some field, so an axis cannot be added without a way to vary it", () => {
		expect(AXES.length).toBeGreaterThan(0);
		for (const axis of AXES) {
			expect(variantAxisValue(variantVarying(axis), axis)).not.toBeNull();
			expect(variantAxisValue(variantVarying(null), axis)).toBeNull();
			expect(VARIANT_AXIS_LABEL[axis].length).toBeGreaterThan(0);
		}
	});

	it.each(AXES)("is reported by variedAxes when %s is set and not when it is absent", axis => {
		expect(variedAxes([variantVarying(null), variantVarying(axis)])).toEqual([axis]);
		expect(variedAxes([variantVarying(null)])).toEqual([]);
	});

	it("lists varied axes in declaration order rather than variant order", () => {
		const reversed = [...AXES].reverse().map(axis => variantVarying(axis));
		expect(variedAxes(reversed)).toEqual(AXES);
	});
});

describe("a backend that drops an axis", () => {
	it.each(AXES)("is refused by name for %s", axis => {
		const problems = checkVariantSupport({
			backendId: "drops-everything",
			backendAxes: [],
			variants: [variantVarying(axis)],
			harnessCapabilities: { veyyon: ALL_TRUE },
		});
		expect(problems).toHaveLength(1);
		const problem = problems[0] as UnappliedVariantAxisError;
		expect(problem).toBeInstanceOf(UnappliedVariantAxisError);
		expect(problem.axis).toBe(axis);
		expect(problem.holder).toBe("backend");
		expect(problem.holderName).toBe("drops-everything");
		expect(problem.variant).toBe(`varies-${axis}`);
		expect(problem.message).toContain(VARIANT_AXIS_LABEL[axis]);
	});

	it("says nothing about an axis no variant varies", () => {
		expect(
			checkVariantSupport({
				backendId: "drops-everything",
				backendAxes: [],
				variants: [variantVarying(null)],
				harnessCapabilities: { veyyon: ALL_FALSE },
			}),
		).toEqual([]);
	});
});

describe("a harness that cannot apply an axis the backend reads", () => {
	it.each(AXES)("is refused by name for %s only when the axis needs a capability", axis => {
		const problems = checkVariantSupport({
			backendId: "reads-everything",
			backendAxes: AXES,
			variants: [variantVarying(axis)],
			harnessCapabilities: { veyyon: ALL_FALSE },
		});
		if (VARIANT_AXIS_CAPABILITY[axis] === null) {
			expect(problems).toEqual([]);
			return;
		}
		expect(problems).toHaveLength(1);
		const problem = problems[0] as UnappliedVariantAxisError;
		expect(problem.holder).toBe("harness");
		expect(problem.holderName).toBe("veyyon");
		expect(problem.axis).toBe(axis);
	});

	it.each(AXES)("is accepted for %s when the harness declares the capability", axis => {
		expect(
			checkVariantSupport({
				backendId: "reads-everything",
				backendAxes: AXES,
				variants: [variantVarying(axis)],
				harnessCapabilities: { veyyon: ALL_TRUE },
			}),
		).toEqual([]);
	});

	it("names the backend rather than the harness when both would refuse", () => {
		const axis = AXES.find(candidate => VARIANT_AXIS_CAPABILITY[candidate] !== null);
		expect(axis).toBeDefined();
		const problems = checkVariantSupport({
			backendId: "drops-everything",
			backendAxes: [],
			variants: [variantVarying(axis as VariantAxis)],
			harnessCapabilities: { veyyon: ALL_FALSE },
		});
		expect(problems).toHaveLength(1);
		expect((problems[0] as UnappliedVariantAxisError).holder).toBe("backend");
	});

	it("refuses a harness the registry does not hold rather than treating it as capable", () => {
		const axis = AXES.find(candidate => VARIANT_AXIS_CAPABILITY[candidate] !== null) as VariantAxis;
		const problems = checkVariantSupport({
			backendId: "reads-everything",
			backendAxes: AXES,
			variants: [variantVarying(axis, "not-registered")],
			harnessCapabilities: {},
		});
		expect(problems).toHaveLength(1);
		expect((problems[0] as UnappliedVariantAxisError).holder).toBe("harness");
	});
});

/**
 * What each shipped backend applies. Pinned by exact equality: a new backend, or a change to
 * what one reads, has to be recorded here with the code that makes it true.
 */
const BACKEND_AXES: Record<string, VariantAxis[]> = {
	"in-process": ["config", "promptVariant"],
	pier: ["config", "attachments"],
	harbor: [],
};

/** What each shipped harness declares, pinned the same way. */
const HARNESS_CAPABILITIES: Record<string, Record<string, boolean>> = {
	veyyon: { armAttachments: true, promptOverrides: true },
	omp: { armAttachments: false, promptOverrides: false },
	factory: { armAttachments: false, promptOverrides: false },
	hermes: { armAttachments: false, promptOverrides: false },
};

describe("every shipped declaration", () => {
	it.each(Object.keys(BACKEND_AXES))("is recorded for backend %s", id => {
		expect([...requireBackend(id).appliesVariantAxes]).toEqual(BACKEND_AXES[id] as VariantAxis[]);
	});

	it.each(Object.keys(HARNESS_CAPABILITIES))("is recorded for harness %s", name => {
		const capabilities = requireHarness(name).capabilities;
		const recorded = HARNESS_CAPABILITIES[name] as Record<string, boolean>;
		const observed: Record<string, boolean> = {};
		for (const axis of AXES) {
			const capability = VARIANT_AXIS_CAPABILITY[axis];
			if (capability === null) continue;
			const value = capabilities[capability];
			// A capability left undefined read as "cannot", which silently refused a run instead
			// of stating a decision. Every adapter answers every axis.
			expect(typeof value).toBe("boolean");
			observed[capability] = value as boolean;
		}
		expect(observed).toEqual(recorded);
	});

	it("covers every axis that asks something of a harness", () => {
		const asked = AXES.map(axis => VARIANT_AXIS_CAPABILITY[axis]).filter(capability => capability !== null);
		for (const recorded of Object.values(HARNESS_CAPABILITIES)) {
			expect(Object.keys(recorded).sort()).toEqual([...asked].sort());
		}
	});
});

describe("variantSupportQuery", () => {
	it("asks the registry once per harness and reads the backend's own declaration", () => {
		const asked: string[] = [];
		const query = variantSupportQuery(
			requireBackend("harbor"),
			[variantVarying("config"), variantVarying("promptVariant"), variantVarying(null, "omp")],
			harness => {
				asked.push(harness);
				return requireHarness(harness).capabilities;
			},
		);
		expect(asked).toEqual(["veyyon", "omp"]);
		expect(query.backendId).toBe("harbor");
		expect([...query.backendAxes]).toEqual([]);
		expect(Object.keys(query.harnessCapabilities).sort()).toEqual(["omp", "veyyon"]);
	});
});

/** A backend that records every question asked of it, so an ordering claim can be proven. */
function recordingBackend(seen: string[], axes: VariantAxis[]): ExecutionBackend {
	return {
		id: "in-process",
		appliesVariantAxes: axes,
		async preflight(): Promise<PreflightVerdict> {
			seen.push("backend.preflight");
			return { ok: true };
		},
		async prepare(): Promise<void> {
			seen.push("backend.prepare");
		},
		async runTrial(): Promise<TrialArtifacts> {
			seen.push("backend.runTrial");
			throw new Error("no trial should ever start");
		},
		async cleanup(): Promise<void> {
			seen.push("backend.cleanup");
		},
	};
}

function recordingSuite(seen: string[]): EvalSuite {
	return {
		name: "axis-recording",
		version: "1.0.0",
		displayName: "Axis Recording",
		description: "a suite that records whether its preflight ran",
		backend: "in-process",
		async discoverTasks(): Promise<readonly string[]> {
			return ["only-task"];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return { id: taskId, path: null, timeBudgetSec: 1, instructionPath: null, metadata: {} };
		},
		async scoreTrial(): Promise<TrialScore> {
			seen.push("suite.scoreTrial");
			return { reward: null, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight(): Promise<PreflightVerdict> {
			seen.push("suite.preflight");
			return { ok: true };
		},
		async provenance() {
			return { suite: "axis-recording", version: "1.0.0" };
		},
	};
}

describe("executeRun", () => {
	it.each(AXES)("refuses %s before any preflight runs", async axis => {
		const temp = await TempDir.create("@evals-test-axis-execute-");
		try {
			const seen: string[] = [];
			const suite = recordingSuite(seen);
			const plan = await buildRunPlan({
				suite,
				selection: {
					harnesses: ["veyyon"],
					models: [MODEL],
					configs: axis === "config" ? ["/overlays/a.yml"] : undefined,
					promptVariants: axis === "promptVariant" ? ["/overlays/a.json"] : undefined,
					attachments: axis === "attachments" ? ["prompt/extra.prompt.md"] : undefined,
				},
				context: { workDir: temp.path() },
			});

			await expect(
				executeRun({
					plan,
					backend: recordingBackend(seen, []),
					workDir: temp.path(),
					runsDir: temp.join("runs"),
				}),
			).rejects.toThrow(UnappliedVariantAxisError);
			expect(seen).toEqual([]);
		} finally {
			await temp.remove();
		}
	});

	it("runs when the backend applies every axis the plan varies", async () => {
		const temp = await TempDir.create("@evals-test-axis-execute-ok-");
		try {
			const seen: string[] = [];
			const plan = await buildRunPlan({
				suite: recordingSuite(seen),
				selection: { harnesses: ["veyyon"], models: [MODEL], configs: ["/overlays/a.yml"] },
				context: { workDir: temp.path() },
			});
			await executeRun({
				plan,
				backend: recordingBackend(seen, ["config"]),
				workDir: temp.path(),
				runsDir: temp.join("runs"),
			});
			expect(seen).toContain("backend.preflight");
			expect(seen).toContain("backend.runTrial");
		} finally {
			await temp.remove();
		}
	});
});

/** Captures what the CLI wrote to a stream, without letting it reach the terminal. */
function capture(stream: "stdout" | "stderr"): { text: () => string } {
	const chunks: string[] = [];
	spyOn(process[stream], "write").mockImplementation(chunk => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	});
	return { text: () => chunks.join("") };
}

/** A suite whose backend applies nothing, so the CLI can be driven to the refusal. */
const HARBOR_SUITE = "terminal-bench";
const HARBOR_TASK = "atrx-vep-crispr";

describe("the CLI", () => {
	it("states an axes verdict on a dry run and refuses one nobody applies", async () => {
		const stdout = capture("stdout");
		const stderr = capture("stderr");
		try {
			const code = await main([
				"--suite",
				HARBOR_SUITE,
				"--tasks",
				HARBOR_TASK,
				"--model",
				MODEL,
				"--prompts",
				"/overlays/a.json",
				"--dry-run",
			]);
			expect(code).toBe(1);
			expect(stdout.text()).toContain("axes       REFUSED");
			expect(stdout.text()).toContain("--prompts");
			expect(stdout.text()).toContain("backend harbor does not apply it");
			// The refusal short-circuits, so no preflight verdict is stated for a run that cannot
			// happen. Without that, an environment where the backend also refuses would return 1
			// for the wrong reason and this case would pass while the axis check did nothing.
			expect(stdout.text()).not.toContain("  suite      ");
			expect(stdout.text()).not.toContain("  backend    ok");
			expect(stdout.text()).not.toContain("DRY RUN — nothing was executed.");
			expect(stderr.text()).toBe("");
		} finally {
			spyOn(process.stdout, "write").mockRestore();
			spyOn(process.stderr, "write").mockRestore();
		}
	});

	it("states `axes ok` when every varied axis has an applier", async () => {
		const stdout = capture("stdout");
		const stderr = capture("stderr");
		try {
			await main(["--suite", HARBOR_SUITE, "--tasks", HARBOR_TASK, "--model", MODEL, "--dry-run"]);
			expect(stdout.text()).toContain("axes       ok");
			expect(stdout.text()).toContain("  suite      ");
		} finally {
			spyOn(process.stdout, "write").mockRestore();
			spyOn(process.stderr, "write").mockRestore();
			expect(stderr.text()).toBe("");
		}
	});

	it("refuses a real run on stderr before a trial starts", async () => {
		const temp = await TempDir.create("@evals-test-axis-cli-");
		const stdout = capture("stdout");
		const stderr = capture("stderr");
		try {
			const code = await main([
				"--suite",
				HARBOR_SUITE,
				"--tasks",
				HARBOR_TASK,
				"--model",
				MODEL,
				"--prompts",
				"/overlays/a.json",
				"--runs-dir",
				temp.join("runs"),
			]);
			expect(code).toBe(1);
			expect(stderr.text()).toContain("backend harbor does not apply it");
			expect(stdout.text()).not.toContain("preflight:");
		} finally {
			spyOn(process.stdout, "write").mockRestore();
			spyOn(process.stderr, "write").mockRestore();
			await temp.remove();
		}
	});
});
