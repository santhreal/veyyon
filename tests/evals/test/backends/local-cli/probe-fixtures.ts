/**
 * What the local-cli suites run the real backend with: a credential store, a harness whose local
 * command runs a script from a probe tree instead of an agent, a registry holding only it, and a
 * run of one kit task.
 */
import { Database } from "bun:sqlite";
import * as path from "node:path";
import { landlockSandbox } from "../../../backends/local-cli/sandbox";
import type { HarnessAdapter, HarnessLookup, RunContext, TrialCell, Variant } from "../../../engine/contracts";
import { kitTask } from "../../../engine/kit/catalog";
import { defineSuite } from "../../../engine/kit/suite";

/** A store with the model provider's credential, another provider's, and a cached usage report. */
export function writeCredentials(file: string): void {
	const db = new Database(file);
	try {
		db.run(
			"CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, identity_key TEXT DEFAULT NULL)",
		);
		db.run("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT)");
		db.run(
			"INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('probe', 'oauth', '{\"access\":\"not-a-real-token\"}')",
		);
		db.run(
			"INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('other', 'api_key', '{\"key\":\"not-a-real-key\"}')",
		);
		db.run("INSERT INTO cache (key, value) VALUES ('usage', 'cached usage report')");
	} finally {
		db.close();
	}
}

/** A harness whose local command runs `<build>/<script> <instruction>` with the runner's Bun. */
export function probeHarness(tree: string, script: string): HarnessAdapter {
	return {
		id: "probe",
		displayName: "Probe",
		description: "reports what a trial can reach",
		flags: [],
		defaultModel: null,
		capabilities: { replay: false, compaction: false, armAttachments: false, promptOverrides: false, builds: true },
		backends: { "local-cli": {} },
		preflight: async () => ({ ok: true }),
		stageAssets() {},
		localCommand: context => ({
			command: process.execPath,
			args: [path.join(context.build ?? tree, script), context.instruction],
			env: { VEYYON_CODING_AGENT_DIR: context.agentDir, PROBE_FROM_HARNESS: "set" },
			readable: [context.build ?? tree, path.dirname(process.execPath)],
		}),
	};
}

export function lookup(harness: HarnessAdapter): HarnessLookup {
	return {
		get: id => (id === harness.id ? harness : undefined),
		require: id => {
			if (id !== harness.id) throw new Error(`no harness ${id}`);
			return harness;
		},
		list: () => [harness],
		ids: () => [harness.id],
	};
}

export interface OneTrialRun {
	readonly context: RunContext;
	readonly cell: TrialCell;
}

/**
 * A run of one kit task under `harness`, whose one variant runs `build` against a credential store
 * written under `root`. Sandboxed wherever the host has Landlock.
 */
export function oneTrialRun(options: {
	readonly root: string;
	readonly suite: string;
	readonly harness: HarnessAdapter;
	readonly build: string;
	readonly signal?: AbortSignal;
	/** What the task's `finish` does once the agent stops; by default it records nothing at once. */
	readonly finish?: () => Promise<Record<string, never>>;
}): OneTrialRun {
	const authDb = path.join(options.root, "agent.db");
	writeCredentials(authDb);
	const task = kitTask<Record<string, never>>({
		id: "probe-task",
		title: "probe",
		capabilities: ["probe"],
		difficulty: "easy",
		start: async () => ({
			instruction: "probe",
			solve: async () => "",
			finish: options.finish ?? (async () => ({})),
		}),
		checks: [{ id: "answered", description: "answered", pass: (_state, answer) => answer.length > 0 }],
	});
	const variant: Variant = {
		name: "arm",
		harness: options.harness.id,
		configPath: null,
		promptVariantPath: null,
		model: "probe/model",
		attachments: [],
		build: options.build,
	};
	const context: RunContext = {
		runId: `${options.suite}-${path.basename(options.root)}`,
		suite: defineSuite({
			id: options.suite,
			version: "1.0.0",
			displayName: options.suite,
			description: "one probe task",
			sourceDir: options.root,
			capabilities: { probe: "probe" },
			tasks: [task],
			tools: [],
			defaultTimeBudgetSec: 60,
		}),
		workDir: options.root,
		runsDir: path.join(options.root, "runs"),
		signal: options.signal,
		harnesses: lookup(options.harness),
		options: { variants: [variant], authDb, ...(landlockSandbox().usable ? {} : { unsandboxed: true }) },
	};
	return { context, cell: { variant: "arm", suite: options.suite, task: "probe-task", repeat: 1 } };
}
