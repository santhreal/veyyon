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
 * breadth, a stale session row from before the column existed, and the knob
 * being reachable at breadth 1 where there are no arms to spread.
 *
 * What it does not catch: that the provider actually answers on the switched
 * model. `pi.setModel` is the product's own model switch and is observed here
 * as the call it is; a provider that accepts the switch and serves another
 * model is beyond any client-side assertion.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Model } from "@veyyon/ai";
import { enterArm, leaveArm } from "@veyyon/coding-agent/autoresearch/arm-model";
import {
	parseArmModels,
	renderSetupConsole,
	SwarmSetupModel,
	setupRows,
} from "@veyyon/coding-agent/autoresearch/setup-console";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import { AutoresearchStorage } from "@veyyon/coding-agent/autoresearch/storage";
import { MAX_BREADTH, MIN_BREADTH } from "@veyyon/coding-agent/autoresearch/swarm";
import { createStartArmTool } from "@veyyon/coding-agent/autoresearch/tools/start-arm";
import type { AutoresearchRuntime, AutoresearchToolFactoryOptions } from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionAPI, ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";
import {
	type AutoresearchHarness,
	createCtx,
	dashboardStub,
	logRun,
	openExperiment,
	seedMeasuredRun,
	useAutoresearchRepo,
} from "./helpers/autoresearch-session";

const freshRepo = useAutoresearchRepo("arm-model");

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

const plainTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Parameters<typeof renderSetupConsole>[2];

function modelNamed(id: string): Model {
	return { id, name: id.toUpperCase(), api: "anthropic-messages" } as unknown as Model;
}

/** Every model this session can reach, by the spec that names it. */
const CATALOG: Record<string, Model> = {
	sonnet: modelNamed("sonnet"),
	"gpt-5": modelNamed("gpt-5"),
	glm: modelNamed("glm"),
};

interface Switcher {
	api: ExtensionAPI;
	ctx: ExtensionContext;
	/** Every model `setModel` was asked for, oldest first. */
	calls: string[];
	/** The model the session is on, as `models.current()` reports it. */
	current(): Model | undefined;
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
	return { api, ctx, calls, current: () => current };
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

/** A swarm session whose arms are assigned the given specs. */
async function swarmWith(armModels: string[], breadth = armModels.length): Promise<AutoresearchHarness> {
	const harness = await openExperiment(freshRepo(), { name: "arm models", breadth });
	harness.storage.updateSession(harness.session.id, { armModels });
	const refreshed = harness.storage.getSessionById(harness.session.id);
	if (!refreshed) throw new Error("session vanished");
	return { ...harness, session: refreshed };
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

	it("offers the models row only where there are arms to spread across", () => {
		// Swept from the source bounds rather than a hardcoded pair: a knob that
		// governs arms must be gone at breadth 1, not present and inert.
		for (let breadth = MIN_BREADTH; breadth <= MAX_BREADTH; breadth += 1) {
			const model = new SwarmSetupModel({ goal: "faster", breadth, attempts: 1, certify: true, armModels: [] });
			const ids = setupRows(model).map(row => row.id);
			expect(ids.includes("models")).toBe(breadth > 1);
			expect(model.fields().includes("models")).toBe(breadth > 1);
		}
	});

	it("drops the row and the assignment together when breadth falls back to 1", () => {
		// Lowering breadth takes the row out from under the cursor. A cursor left
		// on a row that no longer renders is a console where the arrows edit
		// something invisible.
		const model = new SwarmSetupModel({
			goal: "faster",
			breadth: 3,
			attempts: 1,
			certify: true,
			armModels: ["sonnet", "gpt-5", "glm"],
			modelExists: spec => spec in CATALOG,
		});
		model.field = "models";
		model.adjust(0);
		expect(model.field).toBe("models");
		model.field = "breadth";
		model.adjust(-1);
		model.adjust(-1);
		expect(model.breadth).toBe(1);
		expect(model.field).toBe("breadth");
		expect(model.result().armModels).toEqual([]);
		expect(model.modelSummary()).toBe("");
	});

	it("hands back one spec per arm, trimmed to the configured breadth", () => {
		const model = new SwarmSetupModel({
			goal: "faster",
			breadth: 2,
			attempts: 1,
			certify: true,
			armModels: ["sonnet", "gpt-5", "glm"],
			modelExists: spec => spec in CATALOG,
		});
		expect(model.result().armModels).toEqual(["sonnet", "gpt-5"]);
		expect(model.modelSummary()).toBe("a0 sonnet · a1 gpt-5.");
	});

	it("names the arm each spec lands on, including the ones left on the session model", () => {
		const model = new SwarmSetupModel({
			goal: "faster",
			breadth: 3,
			attempts: 1,
			certify: true,
			armModels: ["", "gpt-5"],
			modelExists: spec => spec in CATALOG,
		});
		expect(model.modelSummary()).toBe("a0 session model · a1 gpt-5 · a2 session model.");
	});

	it("refuses to start on a spec nothing resolves, and says so on the key that refuses", () => {
		// Starting anyway would run the arm on the session model and report it as
		// the model that was asked for. The refusal is on `enter`, where the
		// console already states why a run cannot start.
		const model = new SwarmSetupModel({
			goal: "faster",
			breadth: 2,
			attempts: 1,
			certify: true,
			armModels: ["sonnet", "gpt-4o"],
			modelExists: spec => spec in CATALOG,
		});
		expect(model.unknownModels()).toEqual(["gpt-4o"]);
		expect(model.canStart()).toBe(false);
		const frame = renderSetupConsole(model, 100, plainTheme).join("\n");
		expect(frame).toContain("enter needs a known model");
		expect(frame).toContain('No model matches "gpt-4o"');
		expect(frame).not.toContain("enter start");

		// A spec that resolves clears the refusal, so the console is not stuck.
		model.field = "models";
		model.backspace();
		model.backspace();
		model.typeText("5");
		expect(model.models).toBe("sonnet, gpt-5");
		expect(model.canStart()).toBe(true);
	});

	it("ignores an unresolvable spec on an arm the session will never reach", () => {
		// Breadth 2 with three specs: the third arm does not exist, so the spec on
		// it cannot mislead anybody and must not block the run either.
		const model = new SwarmSetupModel({
			goal: "faster",
			breadth: 2,
			attempts: 1,
			certify: true,
			armModels: ["sonnet", "gpt-5", "nonexistent"],
			modelExists: spec => spec in CATALOG,
		});
		expect(model.unknownModels()).toEqual([]);
		expect(model.canStart()).toBe(true);
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
		expect(await leaveArm(switching.api, runtime)).toBe(true);
		expect(switching.current()?.id).toBe("session-default");
		expect(runtime.activeArm).toBeNull();
		// Idempotent: leaving twice is not a second switch.
		expect(await leaveArm(switching.api, runtime)).toBe(false);
		expect(switching.calls).toEqual(["glm", "session-default"]);
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
});
