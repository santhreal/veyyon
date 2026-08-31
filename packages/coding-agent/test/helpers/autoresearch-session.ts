/**
 * A real autoresearch session, opened the way the loop opens one.
 *
 * Everything below the model is real: `init_experiment` writes the session,
 * `log_experiment` logs the runs, and `buildExperimentState` rebuilds the state
 * the screen renders from the same SQLite rows a live session leaves behind. Only
 * the dashboard and the extension API are stubbed, because the first draws to a
 * terminal that does not exist here and the second reaches the running agent.
 *
 * Why it exists: the session a display test needs is forty lines of git repo,
 * temp directory, tool wiring and storage handling, and the tests that assert on
 * the run screen were each carrying their own copy. A second copy is a second
 * definition of what a session looks like, and the two drift.
 *
 * @example
 * const freshRepo = useAutoresearchRepo("veyyon-arm-attribution-");
 * const harness = await openExperiment(freshRepo(), { name: "arm attribution", breadth: 3 });
 * seedMeasuredRun(harness, 80);
 */
import { afterAll, beforeAll } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { buildExperimentState, createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import {
	type AutoresearchStorage,
	closeAllAutoresearchStorages,
	openAutoresearchStorage,
	type SessionRow,
} from "@veyyon/coding-agent/autoresearch/storage";
import { createInitExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/init-experiment";
import { createLogExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/log-experiment";
import type {
	AutoresearchRuntime,
	AutoresearchToolFactoryOptions,
	DashboardController,
	ExperimentState,
	LogDetails,
} from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionAPI, ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";
import { TempDir } from "@veyyon/utils";

const run = promisify(execFile);

/** A dashboard that accepts every update and draws nothing. */
export function dashboardStub(): DashboardController {
	return {
		clear(): void {},
		requestRender(): void {},
		showScreen: async (): Promise<void> => {},
		update(): void {},
	};
}

/** The extension context the autoresearch tools read: a cwd and a session id. */
export function createCtx(cwd: string, sessionId = "autoresearch-test-session"): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
}

/** The agent surface the tools touch while arming and disarming themselves. */
export const stubExtensionApi = {
	appendEntry: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	getActiveTools: () => [],
	setActiveTools: async () => {},
} as unknown as ExtensionAPI;

export interface AutoresearchHarness {
	/** The repository the session runs in. */
	dir: string;
	/** The in-memory runtime the tools mutate, as a live session holds it. */
	runtime: AutoresearchRuntime;
	/** The session's store, already open on {@link dir}. */
	storage: AutoresearchStorage;
	/** The row `init_experiment` wrote. */
	session: SessionRow;
	/** Factory options, for building another tool against the same session. */
	options: AutoresearchToolFactoryOptions;
}

export interface OpenExperimentOptions {
	/** Session name, shown as the screen title. */
	name: string;
	/** Primary metric name. Defaults to `ms`. */
	primaryMetric?: string;
	/** Unit rendered beside the primary metric. */
	metricUnit?: string;
	/** `lower` (default) or `higher` is better. */
	direction?: "lower" | "higher";
	/** Metric names declared alongside the primary. */
	secondaryMetrics?: readonly string[];
	/** Arms per iteration. 1 is a serial loop; above 1 opens a swarm. */
	breadth?: number;
	/** Session id the store keys the session by. */
	sessionId?: string;
}

/**
 * Registers a git repository template for the file and returns a factory for
 * per-test copies of it. The copies and the template are removed when the file
 * finishes, and every store opened against them is closed first.
 */
export function useAutoresearchRepo(prefix: string): () => string {
	let template: TempDir;
	const scratch: TempDir[] = [];

	beforeAll(async () => {
		template = TempDir.createSync(`${prefix}template-`);
		const dir = template.path();
		await writeFile(path.join(dir, "README.md"), "# baseline\n");
		await writeFile(path.join(dir, "autoresearch.sh"), "#!/usr/bin/env bash\necho METRIC ms=100\n");
		const git = (...args: string[]): Promise<{ stdout: string; stderr: string }> => run("git", args, { cwd: dir });
		await git("init", "--initial-branch=main");
		await git("config", "core.autocrlf", "false");
		await git("config", "core.fsmonitor", "false");
		await git("config", "user.email", "tester@example.com");
		await git("config", "user.name", "Tester");
		await git("add", "-A");
		await git("commit", "-m", "baseline");
		await git("checkout", "-b", "autoresearch/base");
	});

	afterAll(async () => {
		closeAllAutoresearchStorages();
		for (const dir of scratch) await dir.remove();
		await template.remove();
	});

	return () => {
		const dir = TempDir.createSync(prefix);
		scratch.push(dir);
		fs.cpSync(template.path(), dir.path(), { recursive: true });
		return dir.path();
	};
}

/** Opens a session in `dir` through `init_experiment`, as the loop does. */
export async function openExperiment(dir: string, options: OpenExperimentOptions): Promise<AutoresearchHarness> {
	const runtime = createSessionRuntime();
	const factoryOptions = { dashboard: dashboardStub(), getRuntime: () => runtime, pi: stubExtensionApi };
	const params: Record<string, unknown> = {
		name: options.name,
		primary_metric: options.primaryMetric ?? "ms",
		direction: options.direction ?? "lower",
		off_limits: ["autoresearch.sh"],
	};
	// arktype rejects an optional key present with an `undefined` value, so an
	// option the caller left out never reaches the schema.
	if (options.metricUnit !== undefined) params.metric_unit = options.metricUnit;
	if (options.secondaryMetrics) params.secondary_metrics = [...options.secondaryMetrics];
	if (options.breadth !== undefined) params.breadth = options.breadth;
	await createInitExperimentTool(factoryOptions).execute(
		"call-init",
		params as never,
		new AbortController().signal,
		() => {},
		createCtx(dir, options.sessionId),
	);
	const storage = await openAutoresearchStorage(dir);
	const session = storage.getActiveSession();
	if (!session) throw new Error("init_experiment did not open a session");
	return { dir, runtime, storage, session, options: factoryOptions };
}

export interface SeedRunOptions {
	/** The primary measurement the harness parsed. */
	metric: number;
	/** Every metric the harness parsed, primary included, as `run_experiment` records them. */
	metrics?: Record<string, number>;
	/** The arm this run measured, for a swarm iteration. */
	arm?: string;
	/** Exit code of the measured command. Non-zero is how a crashed run arrives. */
	exitCode?: number;
}

/**
 * Leaves behind the completed, unlogged run `log_experiment` consumes, the way
 * `run_experiment` does once the harness has exited.
 */
export function seedMeasuredRun(harness: AutoresearchHarness, options: SeedRunOptions): number {
	const primary = harness.session.primaryMetric;
	const run = harness.storage.insertRun({
		sessionId: harness.session.id,
		segment: harness.session.currentSegment,
		command: "./autoresearch.sh",
		logPath: path.join(harness.dir, ".veyyon", "autoresearch", "run.log"),
		preRunDirtyPaths: [],
		startedAt: Date.now(),
		arm: options.arm,
	});
	harness.storage.markRunCompleted({
		runId: run.id,
		completedAt: Date.now(),
		durationMs: 1200,
		exitCode: options.exitCode ?? 0,
		timedOut: false,
		parsedPrimary: options.metric,
		parsedMetrics: options.metrics ?? { [primary]: options.metric },
		parsedAsi: null,
	});
	return run.id;
}

/** Logs a run through the real `log_experiment` tool. */
export async function logRun(harness: AutoresearchHarness, params: Record<string, unknown>): Promise<LogDetails> {
	const result = await createLogExperimentTool(harness.options).execute(
		"call-log",
		params as never,
		new AbortController().signal,
		() => {},
		createCtx(harness.dir),
	);
	if (!result.details) throw new Error(`log_experiment returned no details: ${JSON.stringify(result.content)}`);
	return result.details;
}

/** The state the screen renders, rebuilt from the rows the session wrote. */
export function stateOf(harness: AutoresearchHarness): ExperimentState {
	const session = harness.storage.getSessionById(harness.session.id);
	if (!session) throw new Error("session vanished");
	return buildExperimentState(session, harness.storage.listLoggedRuns(session.id));
}
