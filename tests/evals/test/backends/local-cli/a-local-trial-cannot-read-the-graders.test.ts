/**
 * WHY: an agent's tools run code with the file access of the user running the evals. Browser run
 * code and a shell can open a task's grader, its fixture sources, or an earlier trial's transcript,
 * and print a token from the environment into the transcript. This suite runs the real local-cli
 * backend on a one-task kit suite whose harness command is a probe instead of an agent. The probe
 * reports what it could read and write, which variables it inherited, and which credentials its
 * store holds; the report comes back through the backend's own event parsing as the trial's answer.
 *
 * It proves a trial inherits only the variables it runs on plus the ones its harness and suite
 * name; that its credential store holds the model provider's sign-in and nothing else, and is gone
 * after the trial; and, where the kernel has Landlock, that it cannot open this package, a sibling
 * trial's files, or the tests of the build it runs, while its own workspace, home, task settings and
 * the build's `node_modules` still work, so a sandbox that refused everything would fail too.
 *
 * Not caught: that the invoking user's home is hidden (the suite never writes there) and that `/tmp`
 * and `/proc` stay writable for Chrome; a real browser trial is the check for both. Without Landlock
 * (every host but Linux, a kernel without it, or no python3) the sandbox case skips.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { LocalCliBackend, type LocalTrialLayout, localTrialLayout } from "../../../backends/local-cli/main";
import { landlockSandbox } from "../../../backends/local-cli/sandbox";
import type { HarnessAdapter, HarnessLookup, RunContext, Variant } from "../../../engine/contracts";
import { kitTask } from "../../../engine/kit/catalog";
import { defineSuite } from "../../../engine/kit/suite";
import { LOCAL_TRIAL_FILES, trialDirFor } from "../../../engine/run/layout";

/** Imports a package the build installs, reads and writes what its plan names, and reports as an assistant message. */
const PROBE = `import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { value } from "probe-dep";
const plan = JSON.parse(process.argv.at(-1));
const reads = {};
for (const file of plan.read) {
	try { reads[file] = fs.readFileSync(file, "utf8"); } catch (error) { reads[file] = error.code; }
}
const writes = {};
for (const file of plan.write) {
	try { fs.writeFileSync(file, ""); writes[file] = "ok"; } catch (error) { writes[file] = error.code; }
}
const db = new Database(process.env.VEYYON_CODING_AGENT_DIR + "/agent.db", { readonly: true });
const providers = db.query("SELECT provider FROM auth_credentials ORDER BY provider").all().map(row => row.provider);
const cached = db.query("SELECT COUNT(*) AS count FROM cache").get().count;
const report = {
	home: process.env.HOME,
	tmp: process.env.TMPDIR,
	dep: value,
	planted: Object.keys(process.env).filter(name => name.startsWith("VEYYON_BENCH_PROBE_")),
	fromHarness: process.env.PROBE_FROM_HARNESS ?? null,
	providers,
	cached,
	reads,
	writes,
};
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(report) }], usage: { input: 10, output: 5 } } }));
`;

interface Probe {
	readonly read: readonly string[];
	readonly write: readonly string[];
}

async function writeTree(root: string): Promise<{ tree: string; answers: string }> {
	const tree = path.join(root, "tree");
	const answers = path.join(tree, "tests", "answers.ts");
	const dep = path.join(tree, "node_modules", "probe-dep");
	await fs.mkdir(path.dirname(answers), { recursive: true });
	await fs.mkdir(dep, { recursive: true });
	await fs.writeFile(path.join(tree, "probe.ts"), PROBE);
	await fs.writeFile(answers, "the expected answer");
	await fs.writeFile(
		path.join(dep, "package.json"),
		'{ "name": "probe-dep", "type": "module", "exports": "./index.js" }',
	);
	await fs.writeFile(path.join(dep, "index.js"), 'export const value = "resolved";');
	return { tree, answers };
}

async function writeCredentials(file: string): Promise<void> {
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

function probeHarness(tree: string): HarnessAdapter {
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
			args: [path.join(context.build ?? tree, "probe.ts"), context.instruction],
			env: { VEYYON_CODING_AGENT_DIR: context.agentDir, PROBE_FROM_HARNESS: "set" },
			readable: [context.build ?? tree, path.dirname(process.execPath)],
		}),
	};
}

function lookup(harness: HarnessAdapter): HarnessLookup {
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

interface ProbeRun {
	readonly report: {
		readonly home: string;
		readonly tmp: string;
		readonly dep: string;
		readonly planted: readonly string[];
		readonly fromHarness: string | null;
		readonly providers: readonly string[];
		readonly cached: number;
		readonly reads: Readonly<Record<string, string>>;
		readonly writes: Readonly<Record<string, string>>;
	};
	readonly layout: LocalTrialLayout;
	readonly paths: Readonly<Record<string, string>>;
}

/** One trial of the probe under the real backend, with a sibling trial's files beside it. */
async function runProbe(root: string, options: { readonly unsandboxed: boolean }): Promise<ProbeRun> {
	const { tree, answers } = await writeTree(root);
	const authDb = path.join(root, "agent.db");
	await writeCredentials(authDb);
	const runsDir = path.join(root, "runs");
	const cell = { variant: "arm", suite: "sandbox-probe", task: "probe-task", repeat: 0 };
	// The scratch root is the system temp directory's, shared with any other run on the host.
	const runId = `probe-${path.basename(root)}`;
	const sibling = path.join(trialDirFor(runsDir, runId, { ...cell, task: "other-task" }), LOCAL_TRIAL_FILES.events);
	await fs.mkdir(path.dirname(sibling), { recursive: true });
	await fs.writeFile(sibling, "an earlier trial's transcript");
	// A concurrent trial's scratch, which sits beside this trial's own.
	const other = localTrialLayout(runsDir, runId, { ...cell, task: "other-task" });
	const otherScratch = path.join(other.workspace, "secret.txt");
	await fs.mkdir(path.dirname(otherScratch), { recursive: true });
	await fs.writeFile(otherScratch, "another trial's workspace");
	await using _otherScratch = { [Symbol.asyncDispose]: () => fs.rm(other.scratch, { recursive: true, force: true }) };
	const layout = localTrialLayout(runsDir, runId, cell);
	const paths: Record<string, string> = { answers, sibling, otherScratch, grader: import.meta.filename };

	const task = kitTask<Record<string, never>>({
		id: "probe-task",
		title: "probe",
		capabilities: ["probe"],
		difficulty: "easy",
		async start({ workspace }) {
			const scratch = path.dirname(workspace);
			paths.taskFile = path.join(workspace, "task.txt");
			paths.settings = path.join(scratch, "agent", "task-settings.yml");
			paths.workspaceOut = path.join(workspace, "out.txt");
			paths.homeOut = path.join(scratch, "home", "out.txt");
			paths.tmpOut = path.join(scratch, "tmp", "out.txt");
			paths.siblingOut = path.join(path.dirname(sibling), "x");
			paths.systemTmpOut = path.join(os.tmpdir(), `veyyon-probe-escape-${process.pid}.txt`);
			await fs.writeFile(paths.taskFile, "the task's own file");
			const plan: Probe = {
				read: [paths.taskFile, paths.settings, answers, sibling, otherScratch, import.meta.filename],
				write: [paths.workspaceOut, paths.homeOut, paths.tmpOut, "/dev/null", paths.siblingOut, paths.systemTmpOut],
			};
			return { instruction: JSON.stringify(plan), solve: async () => "", finish: async () => ({}) };
		},
		checks: [{ id: "answered", description: "answered", pass: (_state, answer) => answer.length > 0 }],
	});
	const suite = defineSuite({
		id: "sandbox-probe",
		version: "1.0.0",
		displayName: "Sandbox probe",
		description: "one probe task",
		sourceDir: root,
		capabilities: { probe: "probe" },
		tasks: [task],
		tools: [],
		settings: { probe: { enabled: true } },
		defaultTimeBudgetSec: 60,
	});
	const variant: Variant = {
		name: "arm",
		harness: "probe",
		configPath: null,
		promptVariantPath: null,
		model: "probe/model",
		attachments: [],
		build: tree,
	};
	const context: RunContext = {
		runId,
		suite,
		workDir: root,
		runsDir,
		harnesses: lookup(probeHarness(tree)),
		options: { variants: [variant], authDb, ...(options.unsandboxed ? { unsandboxed: true } : {}) },
	};
	const backend = new LocalCliBackend();
	const verdict = await backend.preflight(context);
	expect(verdict).toEqual({ ok: true });

	// Set for this one trial and removed at once: the backend reads the runner's own environment.
	process.env.VEYYON_BENCH_PROBE_TOKEN = "not-a-real-token";
	try {
		const artifacts = await backend.runTrial(cell, context);
		expect(artifacts.trialDir).toBe(layout.trialDir);
		expect(artifacts.usage?.extra).toEqual({ turns: 1, toolCalls: 0 });
	} finally {
		delete process.env.VEYYON_BENCH_PROBE_TOKEN;
	}
	const answer = await fs.readFile(path.join(layout.trialDir, LOCAL_TRIAL_FILES.answer), "utf8");
	return { report: JSON.parse(answer), layout, paths };
}

describe("a local trial", () => {
	it("gives Chrome a temp directory short enough for its socket, however long the trial's names", () => {
		const long = "x".repeat(120);
		const layout = localTrialLayout(path.join("/", long, "runs"), long, {
			variant: long,
			suite: long,
			task: long,
			repeat: 9,
		});
		// Chrome aborts its launch when the socket it makes under TMPDIR exceeds 107 bytes.
		const socket = path.join(layout.tmp, "com.google.Chrome.XXXXXX", "SingletonSocket");
		expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(107);
		expect(layout.scratch).not.toBe(
			localTrialLayout("/runs", "other", { variant: "a", suite: "s", task: "t", repeat: 0 }).scratch,
		);
	});

	it("inherits only its own variables and holds only its model provider's sign-in", async () => {
		await using dir = await TempDir.create("@evals-local-cli-env-");
		const { report, layout } = await runProbe(dir.path(), { unsandboxed: !landlockSandbox().usable });
		expect(report.home).toBe(layout.home);
		expect(report.tmp).toBe(layout.tmp);
		expect(report.planted).toEqual([]);
		expect(report.fromHarness).toBe("set");
		expect(report.providers).toEqual(["probe"]);
		expect(report.cached).toBe(0);
		expect(report.dep).toBe("resolved");
		// The scratch, and the credential in it, is gone; the workspace is kept in the record.
		expect(await fs.stat(layout.scratch).catch(() => null)).toBeNull();
		expect(await fs.readFile(path.join(layout.trialDir, "workspace", "task.txt"), "utf8")).toBe(
			"the task's own file",
		);
	});

	it.skipIf(!landlockSandbox().usable)("opens its own files and none of the graders", async () => {
		await using dir = await TempDir.create("@evals-local-cli-sandbox-");
		const { report, paths } = await runProbe(dir.path(), { unsandboxed: false });
		expect(report.reads).toEqual({
			[paths.taskFile as string]: "the task's own file",
			[paths.settings as string]: "probe:\n  enabled: true\n",
			[paths.answers as string]: "EACCES",
			[paths.sibling as string]: "EACCES",
			[paths.otherScratch as string]: "EACCES",
			[paths.grader as string]: "EACCES",
		});
		expect(report.writes).toEqual({
			[paths.workspaceOut as string]: "ok",
			[paths.homeOut as string]: "ok",
			[paths.tmpOut as string]: "ok",
			"/dev/null": "ok",
			[paths.siblingOut as string]: "EACCES",
			[paths.systemTmpOut as string]: "EACCES",
		});
	});
});
