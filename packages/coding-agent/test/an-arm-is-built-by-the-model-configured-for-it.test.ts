/**
 * WHY: an autoswarm arm is written by the session model, so two arms differ in
 * model only if something switches the session between them. `start_arm` is
 * that seam, and every rule it carries is invisible to a type check: which arm
 * a spec lands on, whether the session gets its model back, whether an
 * unresolvable spec stops the arm or silently runs it on the wrong model.
 *
 * The class this closes is an arm attributed to a model that did not write it.
 * Its members: an off-by-one between the comma list and the arm index, a spec
 * that resolves to nothing and falls back, a restore that never happens so
 * every later arm inherits the first arm's model, an arm id past the configured
 * breadth, and a stale session row from before the column existed.
 *
 * What it does not catch: that the provider actually answers on the switched
 * model. `pi.setModel` is the product's own model switch and is observed here
 * as the call it is; a provider that accepts the switch and serves another
 * model is beyond any client-side assertion.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@veyyon/ai";
import { closeModels, enterArm, leaveArm } from "@veyyon/coding-agent/autoresearch/arm-model";
import { type ConsoleHost, LoopConsoleModel, parseArmModels } from "@veyyon/coding-agent/autoresearch/console";
import { renderRunDetail } from "@veyyon/coding-agent/autoresearch/screen";
import { SetupFormComponent } from "@veyyon/coding-agent/autoresearch/setup-form";
import { createExperimentState, createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import { AutoresearchStorage } from "@veyyon/coding-agent/autoresearch/storage";
import { MAX_BREADTH, MIN_SWARM_BREADTH } from "@veyyon/coding-agent/autoresearch/swarm";
import { createLogExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/log-experiment";
import { createRunExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/run-experiment";
import { createStartArmTool } from "@veyyon/coding-agent/autoresearch/tools/start-arm";
import type {
	AutoresearchRuntime,
	AutoresearchToolFactoryOptions,
	ExperimentResult,
} from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionAPI, ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";
import { stripAnsi } from "@veyyon/utils";
import {
	type AutoresearchHarness,
	createCtx,
	dashboardStub,
	logRun,
	openExperiment,
	seedMeasuredRun,
	useAutoresearchRepo,
} from "./helpers/autoresearch-session";
import { useTruecolorTheme } from "./helpers/theme-assertions";

const freshRepo = useAutoresearchRepo("arm-model");
// The run detail paints through the active theme, so the screen assertions
// below need one installed.
useTruecolorTheme("dark");

/**
 * The `sessions` table exactly as the previous schema version wrote it: every
 * column of SCHEMA_VERSION 2, and no `arm_models_json`. Restated here rather
 * than imported, because the point is to reproduce a shape the source no
 * longer produces.
 */
const LEGACY_SESSIONS_DDL = `CREATE TABLE sessions (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	goal TEXT,
	primary_metric TEXT NOT NULL,
	metric_unit TEXT NOT NULL DEFAULT '',
	direction TEXT NOT NULL DEFAULT 'lower',
	preferred_command TEXT,
	branch TEXT,
	baseline_commit TEXT,
	current_segment INTEGER NOT NULL DEFAULT 0,
	max_iterations INTEGER,
	scope_paths_json TEXT NOT NULL DEFAULT '[]',
	off_limits_json TEXT NOT NULL DEFAULT '[]',
	constraints_json TEXT NOT NULL DEFAULT '[]',
	secondary_metrics_json TEXT NOT NULL DEFAULT '[]',
	notes TEXT NOT NULL DEFAULT '',
	breadth INTEGER NOT NULL DEFAULT 1,
	attempts INTEGER NOT NULL DEFAULT 1,
	max_parallel INTEGER NOT NULL DEFAULT 8,
	certify INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	closed_at INTEGER
)`;

/**
 * The `runs` table as SCHEMA_VERSION 3 wrote it: `arm` and `certified_by`
 * present, no `model`. A run logged by that build is the stale row the read
 * path has to survive.
 */
const LEGACY_RUNS_DDL = `CREATE TABLE runs (
	id INTEGER PRIMARY KEY,
	session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	segment INTEGER NOT NULL,
	command TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	completed_at INTEGER,
	duration_ms INTEGER,
	exit_code INTEGER,
	timed_out INTEGER NOT NULL DEFAULT 0,
	parsed_primary REAL,
	parsed_metrics_json TEXT,
	parsed_asi_json TEXT,
	pre_run_dirty_paths_json TEXT NOT NULL DEFAULT '[]',
	log_path TEXT NOT NULL,
	status TEXT,
	description TEXT,
	metric REAL,
	metrics_json TEXT,
	asi_json TEXT,
	commit_hash TEXT,
	confidence REAL,
	modified_paths_json TEXT,
	scope_deviations_json TEXT,
	justification TEXT,
	flagged INTEGER NOT NULL DEFAULT 0,
	flagged_reason TEXT,
	arm TEXT,
	certified_by TEXT,
	logged_at INTEGER,
	abandoned_at INTEGER
)`;

function modelNamed(id: string): Model {
	// A provider, because a run records `provider/id`: without one the stored
	// value would read `undefined/gpt-5` and the assertion would pass on it.
	return { id, name: id.toUpperCase(), api: "anthropic-messages", provider: "acme" } as unknown as Model;
}
/** Every model this session can reach, by the spec that names it. */
const CATALOG: Record<string, Model> = {
	sonnet: modelNamed("sonnet"),
	"gpt-5": modelNamed("gpt-5"),
	glm: modelNamed("glm"),
};

function stubHost(overrides: Partial<ConsoleHost> = {}): ConsoleHost {
	return {
		situation: () => ({
			session: null,
			harness: false,
			modeOn: false,
			busy: false,
			interrupted: false,
			pausedOnBranch: null,
			baseline: false,
		}),
		modelExists: (spec: string) => spec in CATALOG,
		presets: () => [],
		savePreset: () => "saved",
		deletePreset: () => true,
		apply: () => {},
		act: () => "stay",
		...overrides,
	};
}

/** The setup form over `model` with the ring on the Models row, as the launcher presents it. */
function modelsRow(model: LoopConsoleModel): SetupFormComponent {
	const form = new SetupFormComponent({ model, onAction: () => {}, onCancel: () => {} });
	form.focus("models");
	return form;
}

interface Switcher {
	api: ExtensionAPI;
	ctx: ExtensionContext;
	/** Every model `setModel` was asked for, oldest first. */
	calls: string[];
	/** The model the session is on, as `models.current()` reports it. */
	current(): Model | undefined;
	/**
	 * Refuse every later `setModel`, as a session does when the model it started
	 * on loses its key mid-run. The enter succeeds and the restore is refused,
	 * which one constructor-time flag cannot express.
	 */
	refuseFromNowOn(): void;
}

/**
 * The session model as a live value: `setModel` moves it and `models.current()`
 * reads it back, so a restore is observed as the session arriving where it
 * started rather than as a call count.
 */
function switcher(cwd: string, start: Model | undefined = modelNamed("session-default"), accept = true): Switcher {
	let current = start;
	const calls: string[] = [];
	const api = {
		appendEntry: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getActiveTools: () => [],
		setActiveTools: async () => {},
		setModel: async (model: Model) => {
			calls.push(model.id);
			if (!accept) return false;
			current = model;
			return true;
		},
	} as unknown as ExtensionAPI;
	const ctx = createCtx(cwd, "arm-model-session", {
		current: () => current,
		resolve: (spec: string) => CATALOG[spec],
	});
	return { api, ctx, calls, current: () => current, refuseFromNowOn: () => (accept = false) };
}

async function startArm(
	harness: AutoresearchHarness,
	switching: Switcher,
	arm: string,
): Promise<{ text: string; runtime: AutoresearchRuntime }> {
	const options: AutoresearchToolFactoryOptions = {
		dashboard: dashboardStub(),
		getRuntime: () => harness.runtime,
		pi: switching.api,
	};
	const result = await createStartArmTool(options).execute(
		"call-start-arm",
		{ arm } as never,
		new AbortController().signal,
		() => {},
		switching.ctx,
	);
	return {
		text: result.content.map(part => (part.type === "text" ? part.text : "")).join(""),
		runtime: harness.runtime,
	};
}

/**
 * `run_experiment` driven through the same switcher the arm was started on. The
 * model is recorded on the measurement, so the real tool is the only way to
 * observe it: `seedMeasuredRun` inserts a row directly and records none.
 */
async function measureArm(harness: AutoresearchHarness, switching: Switcher, arm?: string): Promise<string> {
	fs.writeFileSync(path.join(harness.dir, "autoresearch.sh"), "#!/usr/bin/env bash\necho METRIC ms=10\n");
	const params: Record<string, unknown> = { timeout_seconds: 30 };
	// arktype rejects an optional key present with an `undefined` value.
	if (arm !== undefined) params.arm = arm;
	const result = await createRunExperimentTool({ ...harness.options, pi: switching.api }).execute(
		"call-run",
		params as never,
		new AbortController().signal,
		() => {},
		switching.ctx,
	);
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

/** A swarm session whose arms are assigned the given specs. */
async function swarmWith(armModels: string[], breadth = armModels.length): Promise<AutoresearchHarness> {
	const harness = await openExperiment(freshRepo(), { name: "arm models", breadth });
	harness.storage.updateSession(harness.session.id, { armModels });
	const refreshed = harness.storage.getSessionById(harness.session.id);
	if (!refreshed) throw new Error("session vanished");
	return { ...harness, session: refreshed };
}

/**
 * `log_experiment` driven through the same switcher the arm was started on, so
 * the model the tool reads is the one the arm actually left the session on.
 * The shared `logRun` helper builds its own context with no model registry.
 */
async function logArm(
	harness: AutoresearchHarness,
	switching: Switcher,
	params: Record<string, unknown>,
): Promise<string> {
	const result = await createLogExperimentTool({ ...harness.options, pi: switching.api }).execute(
		"call-log",
		params as never,
		new AbortController().signal,
		() => {},
		switching.ctx,
	);
	if (!result.details) throw new Error(`log_experiment returned no details: ${JSON.stringify(result.content)}`);
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

/** A logged result as the screen reads it. */
function experimentResult(overrides: Partial<ExperimentResult>): ExperimentResult {
	return {
		runNumber: 1,
		commit: "c0ffee",
		metric: 100,
		measuredPrimary: 100,
		metrics: {},
		status: "keep",
		description: "a run",
		timestamp: 0,
		segment: 0,
		confidence: null,
		modifiedPaths: [],
		scopeDeviations: [],
		justification: null,
		flagged: false,
		flaggedReason: null,
		arm: null,
		certifiedBy: null,
		model: null,
		...overrides,
	};
}

describe("an arm is built by the model configured for it", () => {
	it("maps one spec to one arm, keeping an interior gap and dropping trailing ones", () => {
		// The gap is the whole point of the syntax: `,gpt-5` is "a0 as it is, a1
		// on GPT-5". Trimming blanks from both ends would shift every later spec
		// one arm to the left, which reads as a model comparison and is not one.
		expect(parseArmModels("sonnet, gpt-5")).toEqual(["sonnet", "gpt-5"]);
		expect(parseArmModels(", gpt-5")).toEqual(["", "gpt-5"]);
		expect(parseArmModels("sonnet, , glm")).toEqual(["sonnet", "", "glm"]);
		expect(parseArmModels("sonnet, ,")).toEqual(["sonnet"]);
		expect(parseArmModels("   ")).toEqual([]);
		expect(parseArmModels("")).toEqual([]);
	});

	it("always offers the models row across all swarm breadths", () => {
		for (let breadth = MIN_SWARM_BREADTH; breadth <= MAX_BREADTH; breadth += 1) {
			const model = new LoopConsoleModel(
				{ goal: "faster", breadth, attempts: 1, certify: true, armModels: [], maxIterations: null },
				stubHost(),
			);
			expect(modelsRow(model).focusedId).toBe("models");
		}
	});

	it("hands back one spec per arm, trimmed to the configured breadth, and names the spec that lost its arm", () => {
		// The persisted setup carries one spec per arm because the session prompt
		// lists every entry as an arm. A third spec at breadth 2 is therefore not
		// kept, and the row says so instead of dropping it in silence: the reader
		// raises breadth or deletes the spec, rather than finding it gone on the
		// next open.
		const model = new LoopConsoleModel(
			{
				goal: "faster",
				breadth: 2,
				attempts: 1,
				certify: true,
				armModels: ["sonnet", "gpt-5", "glm"],
				maxIterations: null,
			},
			stubHost(),
		);
		expect(model.setup().armModels).toEqual(["sonnet", "gpt-5"]);
		expect(model.modelSummary()).toBe('a0 sonnet · a1 gpt-5. "glm" has no arm at breadth 2.');
		// A blank past the last arm is nothing to report; a second spare joins the list.
		model.models = "sonnet, gpt-5, , glm, opus";
		expect(model.modelSummary()).toBe('a0 sonnet · a1 gpt-5. "glm", "opus" have no arm at breadth 2.');
		model.models = "sonnet, gpt-5, ,";
		expect(model.modelSummary()).toBe("a0 sonnet · a1 gpt-5.");
	});

	it("names the arm each spec lands on, including the ones left on the session model", () => {
		const model = new LoopConsoleModel(
			{
				goal: "faster",
				breadth: 3,
				attempts: 1,
				certify: true,
				armModels: ["", "gpt-5"],
				maxIterations: null,
			},
			stubHost(),
		);
		expect(model.modelSummary()).toBe("a0 session model · a1 gpt-5 · a2 session model.");
	});

	it("refuses to start on a spec nothing resolves, and says so on the key that refuses", () => {
		// Starting anyway would run the arm on the session model and report it as
		// the model that was asked for. The refusal is on `enter`, where the
		// console already states why a run cannot start.
		const model = new LoopConsoleModel(
			{
				goal: "faster",
				breadth: 2,
				attempts: 1,
				certify: true,
				armModels: ["sonnet", "gpt-4o"],
				maxIterations: null,
			},
			stubHost(),
		);
		expect(model.unknownModels()).toEqual(["gpt-4o"]);
		expect(model.startBlocker()).toBe('no model matches "gpt-4o"');

		// A spec that resolves clears the refusal, so the console is not stuck.
		const form = modelsRow(model);
		form.handleInput("\x7f"); // backspace 'o'
		form.handleInput("\x7f"); // backspace '4'
		form.handleInput("5"); // type '5' -> "sonnet, gpt-5"
		expect(model.models).toBe("sonnet, gpt-5");
		expect(model.unknownModels()).toEqual([]);
		expect(model.startBlocker()).toBeNull();
	});

	it("names the models close to a spec nothing resolves, most likely first, and none for a spec like nothing", () => {
		// A typo on the models row is fixed from the card when the card states
		// what was probably meant; a list opened elsewhere is where it was fixed.
		const models = [
			{ id: "claude-opus-4-1", name: "Claude Opus 4.1", provider: "anthropic" },
			{ id: "claude-opus-4", name: "Claude Opus 4", provider: "anthropic" },
			{ id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
			{ id: "gpt-5", name: "GPT-5", provider: "openai" },
			{ id: "gpt-5-mini", name: "GPT-5 mini", provider: "openai" },
			{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
			// Alphabetically first, longest id: only the length rule puts it after the openai ones.
			{ id: "big-gpt-5-turbo-preview", name: "Big", provider: "azure" },
		];
		// A substring of the id outranks a token match, and a shorter id outranks a longer one.
		expect(closeModels("opus-4", models)).toEqual(["anthropic/claude-opus-4", "anthropic/claude-opus-4-1"]);
		// A run of letters in the spec (`opus`) reaches the ids the whole spec does not.
		expect(closeModels("opus4", models)).toEqual(["anthropic/claude-opus-4", "anthropic/claude-opus-4-1"]);
		// Case does not matter, and the name is searched as well as the id.
		expect(closeModels("Sonnet", models)).toEqual(["anthropic/claude-sonnet-4"]);
		// The exact id, then the ids that contain the spec (shorter first), then the ids that share a run of letters.
		expect(closeModels("gpt-5", models)).toEqual([
			"openai/gpt-5",
			"openai/gpt-5-mini",
			"azure/big-gpt-5-turbo-preview",
			"openai/gpt-4o",
		]);
		// A spec that shares no run of three letters with any model suggests nothing: two letters is noise.
		expect(closeModels("o3", models)).toEqual([]);
		expect(closeModels("gp-9", models)).toEqual([]);
		expect(closeModels("   ", models)).toEqual([]);
	});

	it("ignores an unresolvable spec on an arm the session will never reach", () => {
		// Breadth 2 with three specs: the third arm does not exist, so the spec on
		// it cannot mislead anybody and must not block the run either.
		const model = new LoopConsoleModel(
			{
				goal: "faster",
				breadth: 2,
				attempts: 1,
				certify: true,
				armModels: ["sonnet", "gpt-5", "nonexistent"],
				maxIterations: null,
			},
			stubHost(),
		);
		expect(model.unknownModels()).toEqual([]);
		expect(model.startBlocker()).toBeNull();
	});
	it("switches the session to the arm's model and back when the arm is logged", async () => {
		const harness = await swarmWith(["sonnet", "gpt-5"]);
		const switching = switcher(harness.dir);

		const first = await startArm(harness, switching, "a0");
		expect(first.text).toContain("a0 is in flight");
		expect(first.text).toContain("SONNET");
		expect(switching.current()?.id).toBe("sonnet");
		expect(harness.runtime.activeArm?.arm).toBe("a0");

		// The next arm is entered from the session model, not from a0's: chaining
		// arm models is how the third arm ends up on the first arm's model.
		const second = await startArm(harness, switching, "a1");
		expect(second.text).toContain("GPT-5");
		expect(switching.calls).toEqual(["sonnet", "session-default", "gpt-5"]);
		expect(switching.current()?.id).toBe("gpt-5");

		seedMeasuredRun(harness, { metric: 100, arm: "a1" });
		await logRun(
			{ ...harness, options: { ...harness.options, pi: switching.api } },
			{
				status: "keep",
				description: "a1 result",
				arm: "a1",
			},
		);
		expect(switching.current()?.id).toBe("session-default");
		expect(harness.runtime.activeArm).toBeNull();
	});

	it("leaves an arm with no configured model on the session model", async () => {
		const harness = await swarmWith(["", "gpt-5"]);
		const switching = switcher(harness.dir);
		const result = await startArm(harness, switching, "a0");
		expect(switching.calls).toEqual([]);
		expect(result.text).toContain("SESSION-DEFAULT");
		expect(harness.runtime.activeArm).toEqual({
			arm: "a0",
			modelLabel: "SESSION-DEFAULT",
			restore: undefined,
		});
	});

	it("does not switch when the arm's model is the one already in use", async () => {
		const harness = await swarmWith(["sonnet", "gpt-5"]);
		const switching = switcher(harness.dir, CATALOG.sonnet);
		await startArm(harness, switching, "a0");
		expect(switching.calls).toEqual([]);
		expect(switching.current()?.id).toBe("sonnet");
		// And nothing is restored later, since nothing moved.
		expect(harness.runtime.activeArm?.restore).toBeUndefined();
	});

	it("fails the arm loudly when its configured model no longer resolves", async () => {
		// The console refuses an unknown spec, but a session configured yesterday
		// can lose a provider. Falling back to the session model here would report
		// the round as a model comparison it is not.
		const harness = await swarmWith(["retired-model", "gpt-5"]);
		const switching = switcher(harness.dir);
		const result = await startArm(harness, switching, "a0");
		expect(result.text).toContain("Error");
		expect(result.text).toContain("retired-model");
		expect(switching.calls).toEqual([]);
		expect(harness.runtime.activeArm).toBeNull();
	});

	it("reports a refused switch rather than building the arm on the wrong model", async () => {
		const harness = await swarmWith(["sonnet", "gpt-5"]);
		const switching = switcher(harness.dir, modelNamed("session-default"), false);
		const result = await startArm(harness, switching, "a0");
		expect(result.text).toContain("Error");
		expect(switching.calls).toEqual(["sonnet"]);
		expect(switching.current()?.id).toBe("session-default");
		expect(harness.runtime.activeArm).toBeNull();
	});

	it("rejects an arm id that is not an arm, and one past the configured breadth", async () => {
		const harness = await swarmWith(["sonnet", "gpt-5"]);
		const switching = switcher(harness.dir);
		for (const arm of ["", "arm-1", "a", "a1x", "-1"]) {
			const result = await startArm(harness, switching, arm);
			expect(result.text).toContain("not an arm id");
		}
		const past = await startArm(harness, switching, "a2");
		expect(past.text).toContain("2 arms");
		expect(past.text).toContain("a1");
		expect(switching.calls).toEqual([]);
	});

	it("returns the session model when an arm is abandoned rather than logged", async () => {
		// A user who turns the mode off mid-arm must not be left on that arm's
		// model. `leaveArm` is the one path both the tool and the commands use.
		const runtime = createSessionRuntime();
		const switching = switcher(freshRepo());
		await enterArm(switching.ctx, switching.api, runtime, "a0", "glm");
		expect(switching.current()?.id).toBe("glm");
		expect(await leaveArm(switching.api, runtime)).toEqual({ restored: true, strandedOn: null });
		expect(switching.current()?.id).toBe("session-default");
		expect(runtime.activeArm).toBeNull();
		// Idempotent: leaving twice is not a second switch.
		expect(await leaveArm(switching.api, runtime)).toEqual({ restored: false, strandedOn: null });
		expect(switching.calls).toEqual(["glm", "session-default"]);
	});

	it("keeps the arm and says where the session is when the restore is refused", async () => {
		// `setModel` answers false when the model has no key, which a session can
		// lose mid-run. Recording the restore as done would strand the user on the
		// arm's model with nothing left that knows to put it back.
		const runtime = createSessionRuntime();
		const switching = switcher(freshRepo());
		await enterArm(switching.ctx, switching.api, runtime, "a0", "glm");
		switching.refuseFromNowOn();

		expect(await leaveArm(switching.api, runtime)).toEqual({ restored: false, strandedOn: "GLM" });
		// The session is where the refusal left it, and the arm still names it.
		expect(switching.current()?.id).toBe("glm");
		expect(runtime.activeArm?.arm).toBe("a0");
		expect(runtime.activeArm?.restore?.id).toBe("session-default");
	});

	it("returns to the session model rather than to the arm a refusal stranded it on", async () => {
		// The restore target survives the refusal, so the arm after it returns to
		// the session's own model instead of recording `glm` as the way back.
		const runtime = createSessionRuntime();
		const switching = switcher(freshRepo());
		await enterArm(switching.ctx, switching.api, runtime, "a0", "glm");
		switching.refuseFromNowOn();
		await leaveArm(switching.api, runtime);

		const accepting = switcher(freshRepo(), modelNamed("glm"));
		// Same runtime, a session whose provider came back.
		const outcome = await enterArm(accepting.ctx, accepting.api, runtime, "a1", "sonnet");
		expect(outcome.ok).toBe(true);
		expect(runtime.activeArm?.restore?.id).toBe("session-default");
		expect(accepting.current()?.id).toBe("sonnet");
	});

	it("refuses an arm on the session model while the session is stranded on another", async () => {
		// An arm with no configured model builds on the session model. Starting it
		// while a refusal holds the session on `glm` would report a comparison it
		// did not make, so the call fails instead.
		const runtime = createSessionRuntime();
		const switching = switcher(freshRepo());
		await enterArm(switching.ctx, switching.api, runtime, "a0", "glm");
		switching.refuseFromNowOn();
		await leaveArm(switching.api, runtime);

		const outcome = await enterArm(switching.ctx, switching.api, runtime, "a1", undefined);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected the stranded session to refuse the arm");
		expect(outcome.error).toContain("SESSION-DEFAULT");
		expect(outcome.error).toContain("GLM");
		expect(switching.current()?.id).toBe("glm");
	});

	it("reads a database written before the arm-models column existed", async () => {
		// The column is added by migration, not by `CREATE TABLE IF NOT EXISTS`,
		// so a store opened on a session from an earlier build reaches the read
		// path with no column at all. It must come back serial-shaped rather than
		// throwing, and must accept an assignment afterwards.
		const dir = freshRepo();
		const dbPath = path.join(dir, "before-arm-models.db");
		const legacy = new Database(dbPath);
		legacy.run(LEGACY_SESSIONS_DDL);
		legacy.run(
			`INSERT INTO sessions (id, name, primary_metric, metric_unit, direction, breadth, attempts, max_parallel, certify, created_at)
			 VALUES (1, 'legacy', 'ms', 'ms', 'lower', 2, 1, 2, 1, 1)`,
		);
		legacy.run("PRAGMA user_version = 2");
		legacy.close();

		const storage = new AutoresearchStorage(dbPath, dir);
		try {
			expect(storage.getSessionById(1)?.armModels).toEqual([]);
			storage.updateSession(1, { armModels: ["sonnet", "glm"] });
			expect(storage.getSessionById(1)?.armModels).toEqual(["sonnet", "glm"]);
		} finally {
			storage.close();
		}
	});

	it("keeps the arm assignment across a reopen of the store", async () => {
		const harness = await swarmWith(["sonnet", "", "glm"]);
		const reread = harness.storage.getSessionById(harness.session.id);
		expect(reread?.armModels).toEqual(["sonnet", "", "glm"]);
	});

	it("records on the run the model that measured it, not the one the arm was assigned", async () => {
		// The assignment is intent and the arm is the loop's claim. Neither is
		// evidence: only the model in force when the arm was measured says what
		// wrote the code the number came from.
		const harness = await swarmWith(["sonnet", "gpt-5"]);
		const switching = switcher(harness.dir);
		await startArm(harness, switching, "a1");
		expect(switching.current()?.id).toBe("gpt-5");

		const measured = await measureArm(harness, switching, "a1");
		expect(measured).not.toContain("Warning");
		await logArm(harness, switching, { status: "keep", description: "a1", metric: 10, arm: "a1" });

		const logged = harness.storage.listLoggedRuns(harness.session.id).at(-1);
		expect(logged?.arm).toBe("a1");
		// Logging restores the session model, so a read taken at the log call
		// would record `session-default` here. The row keeps what built it.
		expect(logged?.model).toBe("acme/gpt-5");
		expect(switching.current()?.id).toBe("session-default");
	});

	it("keeps the measuring model on the row when a later arm is in flight at the log call", async () => {
		// The shape a certified round always has: every arm is built before the
		// winner is logged, so the session is on some other arm's model by the
		// time the log call happens. A model read there records the wrong arm's.
		const harness = await swarmWith(["sonnet", "gpt-5"]);
		const switching = switcher(harness.dir);
		await startArm(harness, switching, "a0");
		await measureArm(harness, switching, "a0");
		await startArm(harness, switching, "a1");
		expect(switching.current()?.id).toBe("gpt-5");

		await logArm(harness, switching, { status: "keep", description: "a0 won", metric: 10, arm: "a0" });

		const logged = harness.storage.listLoggedRuns(harness.session.id).at(-1);
		expect(logged?.arm).toBe("a0");
		expect(logged?.model).toBe("acme/sonnet");
	});

	it("says so when a measurement is attributed to an arm nothing started", async () => {
		// The silent version of this is the defect the console refuses at setup:
		// four arms attributed to four models, all of them written by one.
		const harness = await swarmWith(["sonnet", "gpt-5"]);
		const switching = switcher(harness.dir);
		const text = await measureArm(harness, switching, "a1");

		expect(text).toContain("start_arm");
		expect(text).toContain("a1");
		expect(text).toContain("acme/session-default");
		expect(harness.storage.getPendingRun(harness.session.id)?.model).toBe("acme/session-default");
	});

	it("says so when the measured arm is not the arm in flight", async () => {
		const harness = await swarmWith(["sonnet", "gpt-5"]);
		const switching = switcher(harness.dir);
		await startArm(harness, switching, "a0");
		const text = await measureArm(harness, switching, "a1");

		expect(text).toContain("in flight");
		expect(text).toContain("a0");
		expect(text).toContain("a1");
		// The row keeps the model that actually built it, which is a0's.
		expect(harness.storage.getPendingRun(harness.session.id)?.model).toBe("acme/sonnet");
	});

	it("stays quiet about the model on a session that assigned none", async () => {
		// A serial loop and a swarm left on one model both measure with no arm
		// model configured. Warning there would be noise on every run.
		const harness = await swarmWith([], 2);
		const switching = switcher(harness.dir);
		const text = await measureArm(harness, switching, "a0");

		expect(text).not.toContain("start_arm");
		expect(text).not.toContain("in flight");
		expect(harness.storage.getPendingRun(harness.session.id)?.model).toBe("acme/session-default");
	});

	it("records the model on a serial run that names no arm at all", async () => {
		const harness = await swarmWith([], 1);
		const switching = switcher(harness.dir);
		const text = await measureArm(harness, switching);

		expect(text).not.toContain("Warning");
		const pending = harness.storage.getPendingRun(harness.session.id);
		expect(pending?.arm).toBeNull();
		expect(pending?.model).toBe("acme/session-default");
	});

	it("reads and writes a run recorded before the model column existed", async () => {
		// A stale row reads back with no model, and the next measurement into that
		// same database still writes one. Reading alone proves nothing here: an
		// absent column reads as undefined and coalesces to the null this asserts,
		// so the write is what shows the column was actually added.
		const dir = freshRepo();
		const dbPath = path.join(dir, "before-run-model.db");
		const legacy = new Database(dbPath);
		legacy.run(LEGACY_SESSIONS_DDL);
		legacy.run(LEGACY_RUNS_DDL);
		legacy.run(
			`INSERT INTO sessions (id, name, primary_metric, metric_unit, direction, breadth, attempts, max_parallel, certify, created_at)
			 VALUES (1, 'legacy', 'ms', 'ms', 'lower', 2, 1, 2, 1, 1)`,
		);
		legacy.run(
			`INSERT INTO runs (id, session_id, segment, command, started_at, log_path, status, metric, arm, logged_at)
			 VALUES (1, 1, 0, 'bench', 1, 'log.txt', 'keep', 12.5, 'a0', 2)`,
		);
		legacy.run("PRAGMA user_version = 3");
		legacy.close();

		const storage = new AutoresearchStorage(dbPath, dir);
		try {
			const stale = storage.listLoggedRuns(1).at(0);
			expect(stale?.arm).toBe("a0");
			expect(stale?.model).toBeNull();

			const measured = storage.insertRun({
				sessionId: 1,
				segment: 0,
				command: "bench",
				logPath: "log.txt",
				preRunDirtyPaths: [],
				startedAt: 4,
				arm: "a0",
				model: "acme/sonnet",
			});
			expect(measured.model).toBe("acme/sonnet");

			// And logging that row leaves the recorded model alone.
			const logged = storage.markRunLogged({
				runId: measured.id,
				status: "keep",
				description: "relogged",
				metric: 12.5,
				metrics: {},
				asi: null,
				commitHash: null,
				confidence: null,
				modifiedPaths: [],
				scopeDeviations: [],
				justification: null,
				loggedAt: 5,
				arm: "a0",
			});
			expect(logged.model).toBe("acme/sonnet");
		} finally {
			storage.close();
		}
	});

	it("names the model in the run detail, with or without an arm, and prints no row when none was recorded", () => {
		const runtime = createSessionRuntime();
		runtime.state = createExperimentState();
		runtime.state.breadth = 2;
		runtime.state.results = [
			experimentResult({ runNumber: 1, arm: "a0", model: "acme/sonnet" }),
			experimentResult({ runNumber: 2, arm: "a1", model: null }),
			// A serial run: no arm, and still measured on some model.
			experimentResult({ runNumber: 3, arm: null, model: "acme/gpt-5" }),
		];

		const withModel = renderRunDetail(runtime, "run:1", 80).map(stripAnsi);
		expect(withModel.some(line => line.startsWith("Arm"))).toBe(true);
		expect(withModel.some(line => line.startsWith("Built on") && line.includes("acme/sonnet"))).toBe(true);

		const withoutModel = renderRunDetail(runtime, "run:2", 80).map(stripAnsi);
		expect(withoutModel.some(line => line.startsWith("Arm"))).toBe(true);
		expect(withoutModel.some(line => line.startsWith("Built on"))).toBe(false);

		const serial = renderRunDetail(runtime, "run:3", 80).map(stripAnsi);
		expect(serial.some(line => line.startsWith("Arm"))).toBe(false);
		expect(serial.some(line => line.startsWith("Built on") && line.includes("acme/gpt-5"))).toBe(true);
	});
	it("takes a pasted list that ends in a newline, and types nothing from a key sequence", () => {
		// A model list is pasted, and a paste out of a terminal or a document
		// carries a trailing newline. The whole chunk used to be rejected, so the
		// paste inserted nothing and said nothing.
		const model = new LoopConsoleModel(
			{ goal: "g", breadth: 2, attempts: 1, certify: true, armModels: [], maxIterations: null },
			stubHost(),
		);
		modelsRow(model).handleInput("sonnet, gpt-5\n");
		expect(parseArmModels(model.models)).toEqual(["sonnet", "gpt-5"]);

		// An interior newline separates rather than fusing two specs.
		const pasted = new LoopConsoleModel(
			{ goal: "g", breadth: 2, attempts: 1, certify: true, armModels: [], maxIterations: null },
			stubHost(),
		);
		modelsRow(pasted).handleInput("sonnet,\ngpt-5");
		expect(parseArmModels(pasted.models)).toEqual(["sonnet", "gpt-5"]);

		// An escape sequence is a key, not text: it must not type its own bytes.
		// F1, deliberately: an arrow is caught by its own branch above, so a test
		// that used one would pass with the escape guard removed.
		const untouched = new LoopConsoleModel(
			{ goal: "g", breadth: 2, attempts: 1, certify: true, armModels: [], maxIterations: null },
			stubHost(),
		);
		modelsRow(untouched).handleInput("\u001bOP");
		expect(untouched.models).toBe("");
	});
});
