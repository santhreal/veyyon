/**
 * WHY: every backend derived its own path segments from an untrusted name with the same inline
 * filter, `replace(/[^a-zA-Z0-9._-]/g, "_")`. That character class contains `.`, so `.` and `..`
 * pass through unchanged and resolve to the directory above. The in-process backend joined a
 * variant segment and a task segment into a trial directory and rebuilt the same expression a
 * second time in `cleanup`, where `fs.rm(trialDir, { recursive: true, force: true })` then removed
 * whatever `..` had resolved to — a directory beside the run, or above the runs directory.
 *
 * The class this closes is every derived path segment in the package, not the one input: the
 * in-process trial directory, harbor's run directory and job prefix, pier's run directory and job
 * name, the typescript-edit conversation dump path, the manager's stored trace path, and a
 * variant's staging directory. `pathSegmentFrom` in `src/paths.ts` is the one rule they share, and
 * `src/core/trial-naming.ts` is the one place a trial's directory and job name are spelled, so the
 * cleanup and the run can no longer disagree.
 *
 * What this suite does not catch: a backend that writes a fresh inline expression and exports
 * nothing is invisible to the export sweep below, and harbor and pier need containers to create a
 * trial, so only their cleanup paths are driven here. The manager's trace path is covered through
 * the owner sweep alone; the traces controller separately refuses a resolved path outside the job
 * directory.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { registerAllBackends } from "../../src/backends";
import * as harborBackendModule from "../../src/backends/harbor/backend";
import { HarborBackend } from "../../src/backends/harbor/backend";
import * as inProcessBackendModule from "../../src/backends/in-process/backend";
import { InProcessBackend } from "../../src/backends/in-process/backend";
import * as pierBackendModule from "../../src/backends/pier/backend";
import { PierExecutionBackend } from "../../src/backends/pier/backend";
import { listBackendIds } from "../../src/core/backend-registry";
import {
	DEFAULT_RUN_SEGMENT,
	DEFAULT_TASK_SEGMENT,
	DEFAULT_VARIANT_SEGMENT,
	runDirFor,
	sanitizeVariantName,
	trialDirFor,
	trialJobName,
	trialSegments,
} from "../../src/core/trial-naming";
import type {
	EvalSuite,
	RunContext,
	SuiteProvenance,
	TaskDescriptor,
	TrialCell,
	TrialScore,
	Variant,
} from "../../src/core/types";
import { registerBuiltinHarnesses } from "../../src/harnesses/index";
import { pathSegmentFrom, UnsafePathSegmentError } from "../../src/paths";
import * as telemetryModule from "../../src/suites/typescript-edit/adapter/runner/telemetry";

/** Names a segment is derived from, generated at run time so a dot run of any length is covered. */
function adversarialNames(): string[] {
	const dots = Array.from({ length: 6 }, (_, i) => ".".repeat(i + 1));
	return [
		...dots,
		"",
		"   ",
		" . ",
		"./",
		"../..",
		"..\\..",
		"/",
		"\\",
		"a/b",
		"a\\b",
		"/etc/passwd",
		"..%2f..",
		"\0",
		"a\0b",
		"~",
		"~/.ssh",
		"a b",
		" pad ",
		"task-1",
		"task_1.v2",
		"café",
		"日本語",
		":",
		"*",
		"-".repeat(300),
	];
}

function probeSuite(): EvalSuite {
	return {
		name: "naming-probe-suite",
		version: "1.0.0",
		displayName: "Naming Probe Suite",
		description: "Suite used to drive trial directory naming",
		backend: "in-process",
		async discoverTasks() {
			return ["sibling"];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return {
				id: taskId,
				path: null,
				timeBudgetSec: 30,
				instructionPath: null,
				metadata: { prompt: "Do the task", files: [] },
			};
		},
		async provenance(): Promise<SuiteProvenance> {
			return { suite: "naming-probe-suite", version: "1.0.0" };
		},
		async scoreTrial(): Promise<TrialScore> {
			return { reward: 1, partial: 1, error: null, usage: null, extra: {} };
		},
		async preflight() {
			return { ok: true };
		},
	};
}

/** A variant literally named `..`, which is what the trial directory used to be built from. */
const CLIMBING_VARIANT: readonly Variant[] = [
	{
		name: "..",
		harness: "veyyon",
		configPath: null,
		promptVariantPath: null,
		model: "anthropic/claude-sonnet-4-6",
		attachments: [],
	},
];

function silentClient() {
	return {
		async start() {},
		async prompt() {},
		async getSessionStats() {
			return { tokens: { input: 1, output: 1, total: 2 }, assistantMessages: 1, cost: 0 };
		},
		async getLastAssistantText() {
			return "done";
		},
		abort() {},
		async dispose() {},
	};
}

describe("pathSegmentFrom is the one rule a derived segment follows", () => {
	it("never yields a segment that leaves the directory it is joined into", () => {
		const base = path.resolve("/base/dir");
		for (const name of adversarialNames()) {
			const segment = pathSegmentFrom(name, "fallback");
			const resolved = path.resolve(base, segment);
			expect({ name, segment, ok: resolved.startsWith(`${base}${path.sep}`) }).toEqual({
				name,
				segment,
				ok: true,
			});
			expect(path.basename(segment)).toBe(segment);
			expect(segment).not.toBe(".");
			expect(segment).not.toBe("..");
			expect(segment.length).toBeGreaterThan(0);
			expect(segment.includes("/")).toBe(false);
			expect(segment.includes("\\")).toBe(false);
			expect(segment.includes("\0")).toBe(false);
		}
	});

	it("rewrites a dot run instead of returning it, and keeps distinct names distinct", () => {
		expect(pathSegmentFrom(".", "fallback")).toBe("_.");
		expect(pathSegmentFrom("..", "fallback")).toBe("_..");
		expect(pathSegmentFrom("...", "fallback")).toBe("_...");
		expect(pathSegmentFrom(".", "fallback")).not.toBe(pathSegmentFrom("..", "fallback"));
	});

	it("keeps a name that is already a segment and replaces only what a path cannot hold", () => {
		expect(pathSegmentFrom("task-1", "fallback")).toBe("task-1");
		expect(pathSegmentFrom("task_1.v2", "fallback")).toBe("task_1.v2");
		expect(pathSegmentFrom("a b", "fallback")).toBe("a_b");
		expect(pathSegmentFrom("a/b", "fallback")).toBe("a_b");
		expect(pathSegmentFrom(" pad ", "fallback")).toBe("pad");
		expect(pathSegmentFrom(".hidden", "fallback")).toBe(".hidden");
	});

	it("falls back only for a name with nothing left, and refuses an unsafe fallback", () => {
		expect(pathSegmentFrom("", "the-fallback")).toBe("the-fallback");
		expect(pathSegmentFrom("   ", "the-fallback")).toBe("the-fallback");
		expect(() => pathSegmentFrom("", "..")).toThrow(UnsafePathSegmentError);
		expect(() => pathSegmentFrom("", "a/b")).toThrow(UnsafePathSegmentError);
	});

	it("names a variant's staging directory through the same rule", () => {
		expect(sanitizeVariantName("baseline")).toBe("baseline");
		expect(sanitizeVariantName("  ")).toBe(DEFAULT_VARIANT_SEGMENT);
		expect(sanitizeVariantName("..")).toBe("_..");
		expect(sanitizeVariantName("cfg a/b")).toBe("cfg_a_b");
	});

	it("names a conversation dump inside the dump directory", () => {
		const dumpDir = path.resolve("/dumps");
		for (const taskId of ["..", ".", "a/b", ""]) {
			const file = telemetryModule.getConversationDumpPath(dumpDir, taskId, 0);
			expect(file.startsWith(`${dumpDir}${path.sep}`)).toBe(true);
			expect(path.dirname(path.dirname(file))).toBe(dumpDir);
		}
		expect(telemetryModule.getConversationDumpPath(dumpDir, "task-9", 1)).toBe(
			path.join(dumpDir, "task-9", "run-2.md"),
		);
	});
});

interface NamingCase {
	readonly label: string;
	readonly runId: string;
	readonly cell: TrialCell;
}

const NAMING_CASES: NamingCase[] = [
	{
		label: "an ordinary cell",
		runId: "run-1",
		cell: { suite: "s", variant: "baseline", task: "task-1", repeat: 0 },
	},
	{ label: "a task named ..", runId: "run-1", cell: { suite: "s", variant: "baseline", task: "..", repeat: 0 } },
	{ label: "a variant named ..", runId: "run-1", cell: { suite: "s", variant: "..", task: "task-1", repeat: 0 } },
	{ label: "both named ..", runId: "run-1", cell: { suite: "s", variant: "..", task: "..", repeat: 1 } },
	{ label: "a run named ..", runId: "..", cell: { suite: "s", variant: "baseline", task: "task-1", repeat: 0 } },
	{ label: "an empty task", runId: "run-1", cell: { suite: "s", variant: "baseline", task: "", repeat: 0 } },
	{ label: "an empty variant", runId: "run-1", cell: { suite: "s", variant: "", task: "task-1", repeat: 0 } },
	{
		label: "separators everywhere",
		runId: "../run",
		cell: { suite: "s", variant: "a/b", task: "../../etc", repeat: 2 },
	},
];

describe("one rule spells a trial's directory and its job name", () => {
	it.each(NAMING_CASES)("files $label under its own run directory", ({ runId, cell }) => {
		const runsDir = path.resolve("/runs");
		const runDir = runDirFor(runsDir, runId);
		const trialDir = trialDirFor(runsDir, runId, cell);

		expect(runDir.startsWith(`${runsDir}${path.sep}`)).toBe(true);
		expect(path.dirname(runDir)).toBe(runsDir);
		expect(trialDir.startsWith(`${runDir}${path.sep}`)).toBe(true);
		expect(path.relative(runDir, trialDir).split(path.sep)).toHaveLength(3);
	});

	it.each(NAMING_CASES)("spells $label as one job name segment", ({ runId, cell }) => {
		const jobName = trialJobName(runId, cell);
		const segments = trialSegments(runId, cell);

		expect(path.basename(jobName)).toBe(jobName);
		expect(jobName).toBe(`${segments.run}__${segments.variant}__${segments.task}__r${segments.repeat}`);
		expect(path.resolve("/runs", jobName)).toBe(path.join("/runs", jobName));
	});

	it("takes the default segment for a part with nothing left", () => {
		const segments = trialSegments("", { suite: "s", variant: "", task: "", repeat: 0 });

		expect(segments).toEqual({
			run: DEFAULT_RUN_SEGMENT,
			variant: DEFAULT_VARIANT_SEGMENT,
			task: DEFAULT_TASK_SEGMENT,
			repeat: 0,
		});
	});

	it("counts a repeat only when it is a positive whole number", () => {
		const cell = (repeat: number): TrialCell => ({ suite: "s", variant: "v", task: "t", repeat });

		expect(trialSegments("r", cell(3)).repeat).toBe(3);
		expect(trialSegments("r", cell(0)).repeat).toBe(0);
		expect(trialSegments("r", cell(-4)).repeat).toBe(0);
		expect(trialSegments("r", cell(1.5)).repeat).toBe(0);
		expect(trialSegments("r", cell(Number.NaN)).repeat).toBe(0);
		expect(trialJobName("r", { suite: "s", variant: "v", task: "t", repeat: 2 })).toBe("r__v__t__r2");
	});
});

/**
 * Every registered backend states how its trial naming is exercised here. A new backend turns this
 * red until someone records the decision, because a backend that spells its own paths is the defect
 * this suite exists for.
 */
const NAMING_COVERAGE: Readonly<Record<string, string>> = {
	"in-process": "runTrial and cleanup drive trialDirFor end to end",
	harbor: "cleanup removes the job directory trialJobName names",
	pier: "cleanup names the containers trialJobName names",
};

describe("no backend spells a trial path of its own", () => {
	beforeAll(() => {
		registerAllBackends();
		registerBuiltinHarnesses();
	});

	it("covers every registered backend", () => {
		expect([...listBackendIds()].sort()).toEqual(Object.keys(NAMING_COVERAGE).sort());
	});

	it("exports no naming rule beside the owner's", () => {
		const owned = ["pathSegmentFrom", "trialSegments", "trialJobName", "trialDirFor", "runDirFor"];
		const modules: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
			"in-process": inProcessBackendModule,
			harbor: harborBackendModule,
			pier: pierBackendModule,
			telemetry: telemetryModule,
		};

		for (const [id, mod] of Object.entries(modules)) {
			const redeclared = Object.keys(mod).filter(name => owned.includes(name));
			expect({ id, redeclared }).toEqual({ id, redeclared: [] });
		}
	});

	it("writes an in-process trial inside its run and removes only that trial", async () => {
		const temp = await TempDir.create("@evals-test-trial-naming-");
		try {
			const runsDir = temp.join("runs");
			const runId = "naming-run";
			const cell: TrialCell = { suite: "naming-probe-suite", variant: "..", task: "sibling", repeat: 0 };

			// Where the pre-fix formula resolved a variant named `..` to: beside the run directory.
			const escaped = path.join(runsDir, "sibling", "repeat-0");
			await fs.mkdir(escaped, { recursive: true });
			await fs.writeFile(path.join(escaped, "precious.txt"), "another run's artifact", "utf8");

			const backend = new InProcessBackend({ clientFactory: () => silentClient() });
			const context: RunContext = {
				runId,
				suite: probeSuite(),
				workDir: temp.absolute(),
				runsDir,
				options: { variants: CLIMBING_VARIANT, cleanup: true },
			};

			const artifacts = await backend.runTrial(cell, context);
			const expected = trialDirFor(runsDir, runId, cell);
			const createdInsideRun = (artifacts.trialDir ?? "").startsWith(`${runDirFor(runsDir, runId)}${path.sep}`);
			const existedBeforeCleanup = await fs.exists(expected);

			await backend.cleanup(cell, context);

			// The removal the pre-fix formula performed: a directory beside the run, holding another
			// run's artifacts, because a variant named `..` climbed out of the run directory.
			expect(await fs.readFile(path.join(escaped, "precious.txt"), "utf8")).toBe("another run's artifact");
			expect({ trialDir: artifacts.trialDir, createdInsideRun, existedBeforeCleanup }).toEqual({
				trialDir: expected,
				createdInsideRun: true,
				existedBeforeCleanup: true,
			});
			expect(await fs.exists(expected)).toBe(false);
		} finally {
			await temp.remove();
		}
	});

	it("removes the harbor job directory its own job name spells, and no other", async () => {
		const temp = await TempDir.create("@evals-test-harbor-naming-");
		try {
			const runsDir = temp.join("runs");
			const runId = "harbor-run";
			const cell: TrialCell = { suite: "s", variant: "..", task: "..", repeat: 0 };
			const runDir = runDirFor(runsDir, runId);
			const mine = path.join(runDir, `${trialJobName(runId, cell)}_1717`);
			const other = path.join(runDir, `${trialJobName(runId, { ...cell, task: "other" })}_1717`);
			await fs.mkdir(mine, { recursive: true });
			await fs.mkdir(other, { recursive: true });
			await fs.writeFile(path.join(other, "keep.json"), "{}", "utf8");

			const context: RunContext = {
				runId,
				suite: probeSuite(),
				workDir: temp.absolute(),
				runsDir,
				// apple-container skips the docker container sweep, so no container runtime is reached.
				options: { cleanup: true, envType: "apple-container" },
			};

			await new HarborBackend().cleanup(cell, context);

			expect(await fs.exists(mine)).toBe(false);
			expect(await fs.readFile(path.join(other, "keep.json"), "utf8")).toBe("{}");
		} finally {
			await temp.remove();
		}
	});

	it("names pier's containers with the job name the trial was filed under", async () => {
		const runId = "pier-run";
		const cell: TrialCell = { suite: "s", variant: "..", task: "task 1", repeat: 0 };
		const jobName = trialJobName(runId, cell);
		const calls: string[][] = [];
		const backend = new PierExecutionBackend({
			exec: async (file, args) => {
				calls.push([file, ...args]);
				if (args[0] === "ps") {
					return {
						stdout: [`mine\t${jobName}-agent\t${jobName}`, `theirs\tother-agent\tother-project`].join("\n"),
						stderr: "",
					};
				}
				if (args[0] === "network") return { stdout: `net-mine\t${jobName}_default\t${jobName}`, stderr: "" };
				return { stdout: "", stderr: "" };
			},
		});

		await backend.cleanup(cell, {
			runId,
			suite: probeSuite(),
			workDir: "/unused",
			runsDir: "/unused/runs",
		});

		expect(calls).toContainEqual(["docker", "rm", "-f", "mine"]);
		expect(calls).toContainEqual(["docker", "network", "rm", "net-mine"]);
		for (const call of calls) {
			expect(call).not.toContain("theirs");
		}
	});
});
