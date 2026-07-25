/**
 * Argot live adoption bench: run the built-in edit tasks with a real model, once
 * with argot ON and once OFF, and measure whether the shorthand actually earned
 * its keep. This is the only certifier of "argot works" — the unit suites prove
 * the codec is lossless, but only a real model's transcript can prove it ADOPTS
 * handles and NETS a token saving.
 *
 * The verdict math ({@link certifyArgot}, {@link assertArgotCertified}) and the
 * per-run assembly ({@link assembleRunMeasurement}) are pure and unit-tested. The
 * one live part is {@link runArgotBench}, which drives the shared in-process agent
 * session against the configured model. It is opt-in: a caller supplies the model
 * id explicitly, and a missing model is a loud skip in the test, never a silent
 * pass.
 */
/// <reference types="./bun-imports.d.ts" />
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import { createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } from "@veyyon/coding-agent";
import { loadArgotFolder } from "@veyyon/coding-agent/argot-cache";
import { ArgotSession, DEFAULT_SIGIL, makePromptFragment, measureDecode, renderPreamble, type Vocabulary } from "argot";
import {
	type ArgotCertification,
	type ArgotRunMeasurement,
	assembleRunMeasurement,
	certifyArgot,
} from "./argot-certify";
import type { EditTask } from "./tasks";
import { loadTasksFromDir } from "./tasks";
import { verifyExpectedFileSubset } from "./verify";

/**
 * Extract the bundled fixture tasks into a fresh temp dir. Returns the directory
 * that directly contains the task folders (descending into a single top-level
 * wrapper directory if the archive has one, matching the metaharness), plus a
 * cleanup.
 */
export async function extractBenchmarkFixtures(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const root = await fs.mkdtemp(path.join(await realTmp(), "argot-bench-fixtures-"));
	const archivePath = path.join(import.meta.dir, "..", "fixtures.tar.gz");
	const archive = new Bun.Archive(await Bun.file(archivePath).arrayBuffer());
	for (const [filePath, file] of await archive.files()) {
		await Bun.write(path.join(root, filePath), file);
	}
	const entries = await fs.readdir(root, { withFileTypes: true });
	const dirs = entries.filter(entry => entry.isDirectory());
	const files = entries.filter(entry => entry.isFile());
	const dir = dirs.length === 1 && files.length === 0 ? path.join(root, dirs[0]!.name) : root;
	return { dir, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function realTmp(): Promise<string> {
	const os = await import("node:os");
	return os.tmpdir();
}

/**
 * Apply this phase's argot policy to the LIVE settings singleton.
 *
 * `Settings.init` is once-only: it caches the first call's promise and IGNORES the
 * options of every later call (see `globalInstancePromise` in config/settings.ts).
 * The bench runs an "off" phase and then an "on" phase back to back, so a second
 * `Settings.init({ "argot.enabled": true })` was a silent no-op — the on-phase kept
 * the off-phase's `enabled=false`, never armed the codec, and adoption measured a
 * FALSE ZERO while the model was in fact never taught the handles. That single bug
 * is why the content-repro bench reported `totalHandleEmissions: 0` even though the
 * model adopts 3/3 handles when argot is actually on.
 *
 * The fix mirrors a real operator flipping the setting mid-run: init once
 * (idempotent), then push the phase's values as runtime overrides, which the agent
 * session reads at construction exactly like a persisted setting.
 *
 * Exported for its regression suite (argot-bench.test.ts locks the flip).
 */
export async function applyArgotPhaseSettings(
	argotEnabled: boolean,
	model: string,
	disableAboveTokens?: number,
): Promise<void> {
	await Settings.init();
	const settings = Settings.instance;
	settings.override("argot.enabled", argotEnabled);
	settings.override("argot.models", argotEnabled ? [model] : []);
	settings.override("argot.disableAboveTokens", disableAboveTokens ?? 0);
}

/** Recursively copy a directory tree. */
async function copyTree(src: string, dest: string): Promise<void> {
	await fs.mkdir(dest, { recursive: true });
	for (const entry of await fs.readdir(src, { withFileTypes: true })) {
		const from = path.join(src, entry.name);
		const to = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			await copyTree(from, to);
		} else if (entry.isFile()) {
			await fs.copyFile(from, to);
		}
	}
}

/**
 * Prepare a task's working directory: copy its input fixtures into `destDir`, mark
 * it an argot project (a bare `.argot` marker, so arming engages without needing a
 * git repo), and arm a vocabulary from it. The returned vocabulary is what
 * adoption is measured against; when the fixture yields no handles it is empty,
 * and the bench will correctly report zero adoption for that task.
 */
export async function prepareArgotWorkdir(
	task: EditTask,
	destDir: string,
): Promise<{ cwd: string; vocab: Vocabulary }> {
	await copyTree(task.inputDir, destDir);
	await fs.writeFile(path.join(destDir, ".argot"), "");
	const argot = new ArgotSession();
	await loadArgotFolder(argot, destDir);
	return { cwd: destDir, vocab: argot.vocabulary() };
}

/** Options for {@link runArgotBench}. */
export interface RunArgotBenchOptions {
	/** The provider-qualified model id to run (e.g. `google-antigravity/gemini-2.5-flash`). */
	model: string;
	/** How many of the loaded tasks to run (from the front). Default: all. */
	taskLimit?: number;
	/** The context-token cutoff above which argot stops teaching. Default: 0 (never). */
	disableAboveTokens?: number;
	/** Cancels the run. */
	signal?: AbortSignal;
}

/** The outcome of a live bench run: the paired measurements and their certification. */
export interface ArgotBenchOutcome {
	on: ArgotRunMeasurement[];
	off: ArgotRunMeasurement[];
	certification: ArgotCertification;
}

/**
 * Run the edit tasks with argot on and off against `options.model`, measure each
 * run, and return the paired measurements with their certification. The caller
 * (a test) decides pass/fail with {@link assertArgotCertified}.
 *
 * Argot is toggled through the global settings the agent session reads at start:
 * on the "on" pass the model id is added to `argot.models` so the encode gate
 * actually teaches this model (an empty allowlist teaches nobody); on the "off"
 * pass argot is disabled outright. Both passes run the identical task set so the
 * token comparison is like-for-like.
 */
export async function runArgotBench(options: RunArgotBenchOptions): Promise<ArgotBenchOutcome> {
	const fixtures = await extractBenchmarkFixtures();
	const workRoot = await fs.mkdtemp(path.join(await realTmp(), "argot-bench-work-"));
	try {
		const allTasks = await loadTasksFromDir(fixtures.dir);
		const tasks = options.taskLimit ? allTasks.slice(0, options.taskLimit) : allTasks;
		if (tasks.length === 0) {
			throw new Error("argot bench: no tasks loaded from fixtures");
		}

		const off = await runPhase(tasks, workRoot, { ...options, argotEnabled: false });
		const on = await runPhase(tasks, workRoot, { ...options, argotEnabled: true });
		return { on, off, certification: certifyArgot(on, off) };
	} finally {
		await fs.rm(workRoot, { recursive: true, force: true });
		await fixtures.cleanup();
	}
}

/**
 * A content-reproduction task: a small synthetic project plus a prompt that makes
 * the agent WRITE a file whose content reproduces strings that recur across the
 * project (its imports, deep paths, a shared URL). Unlike the minimal-edit
 * fixtures, this is the workload argot is built for — the agent retypes long
 * project strings, so a good dictionary gives it handles to use. Adoption and net
 * savings are only measurable on a workload like this.
 */
interface ReproTask {
	/** Stable task id (used for the paired on/off measurement key). */
	id: string;
	/** The corpus files written into the workdir. Their recurring strings become handles. */
	corpus: Array<{ path: string; content: string }>;
	/** The instruction handed to the agent. */
	prompt: string;
	/** The file the agent is asked to create, relative to the workdir. */
	targetFile: string;
	/**
	 * Strings the created file MUST contain verbatim (after argot expansion). These
	 * are the exact project strings the task forces the agent to reproduce, so they
	 * are both the correctness assertion and the adoption opportunity.
	 */
	required: string[];
}

/**
 * The synthetic project shared by the reproduction tasks. Five feature files each
 * import the same three long strings, so document-frequency scoring turns those
 * strings into high-value handles (this is exactly the centrality the generator
 * rewards). The strings are deliberately long and project-specific: a scoped
 * package, a deep relative path, and an API URL.
 */
const REPRO_SHARED = {
	pkg: "@acme/shared-core-utilities",
	deepPath: "../../../lib/database/connection-pool",
	url: "https://api.acme.example/v2/records",
};

function reproCorpus(): Array<{ path: string; content: string }> {
	const files: Array<{ path: string; content: string }> = [];
	for (let i = 1; i <= 5; i++) {
		files.push({
			path: `src/feature-${i}.ts`,
			content:
				`import { helper } from '${REPRO_SHARED.pkg}';\n` +
				`import { pool } from '${REPRO_SHARED.deepPath}';\n` +
				`const ENDPOINT = '${REPRO_SHARED.url}';\n` +
				`export function feature${i}() {\n  return helper(pool, ENDPOINT);\n}\n`,
		});
	}
	return files;
}

/** The content-reproduction tasks the adoption certification runs on. */
const CONTENT_REPRO_TASKS: ReproTask[] = [
	{
		id: "repro-barrel-reexport",
		corpus: reproCorpus(),
		targetFile: "src/barrel.ts",
		required: [REPRO_SHARED.pkg, REPRO_SHARED.deepPath, REPRO_SHARED.url],
		prompt:
			"Create a new file `src/barrel.ts`. In it:\n" +
			`- re-export \`helper\` from '${REPRO_SHARED.pkg}'\n` +
			`- re-export \`pool\` from '${REPRO_SHARED.deepPath}'\n` +
			`- export a constant \`ENDPOINT\` set to the string '${REPRO_SHARED.url}'\n` +
			"Write only that file.",
	},
	{
		id: "repro-new-feature",
		corpus: reproCorpus(),
		targetFile: "src/feature-6.ts",
		required: [REPRO_SHARED.pkg, REPRO_SHARED.deepPath, REPRO_SHARED.url],
		prompt:
			"Create `src/feature-6.ts` following the exact same shape as the other feature files in `src/`: " +
			`import \`helper\` from '${REPRO_SHARED.pkg}', import \`pool\` from '${REPRO_SHARED.deepPath}', ` +
			`define \`const ENDPOINT = '${REPRO_SHARED.url}'\`, and export a function \`feature6()\` that returns ` +
			"`helper(pool, ENDPOINT)`. Write only that file.",
	},
];

/** Prepare a reproduction task's workdir: write the corpus, mark it argot, arm a vocab. */
async function prepareReproWorkdir(task: ReproTask, destDir: string): Promise<{ cwd: string; vocab: Vocabulary }> {
	await fs.mkdir(destDir, { recursive: true });
	for (const file of task.corpus) {
		const abs = path.join(destDir, file.path);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, file.content);
	}
	await fs.writeFile(path.join(destDir, ".argot"), "");
	const argot = new ArgotSession();
	await loadArgotFolder(argot, destDir);
	return { cwd: destDir, vocab: argot.vocabulary() };
}

/**
 * Verify a reproduction task: the target file exists and contains every required
 * string verbatim. This asserts real values (the exact project strings the task
 * forced the agent to reproduce), not shape. The on-disk file is always full text
 * because handles expand at the tool-argument seam before the write runs, so this
 * passes identically whether or not the model used a handle — correctness is
 * independent of adoption, which is the point.
 */
async function verifyReproContains(cwd: string, task: ReproTask): Promise<boolean> {
	const abs = path.join(cwd, task.targetFile);
	let content: string;
	try {
		content = await fs.readFile(abs, "utf8");
	} catch {
		return false;
	}
	return task.required.every(s => content.includes(s));
}

async function runReproPhase(
	tasks: readonly ReproTask[],
	workRoot: string,
	opts: RunArgotBenchOptions & { argotEnabled: boolean },
): Promise<ArgotRunMeasurement[]> {
	await applyArgotPhaseSettings(opts.argotEnabled, opts.model, opts.disableAboveTokens);
	const authStorage = await discoverAuthStorage();
	const results: ArgotRunMeasurement[] = [];
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		for (let i = 0; i < tasks.length; i++) {
			const task = tasks[i]!;
			const destDir = path.join(workRoot, `${opts.argotEnabled ? "on" : "off"}-${i}-${task.id}`);
			const { cwd, vocab } = await prepareReproWorkdir(task, destDir);
			const session = await createAgentSession({
				cwd,
				modelPattern: opts.model,
				authStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(cwd),
				toolNames: ["read", "edit", "write"],
				hasUI: false,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
				disableExtensionDiscovery: true,
			});
			try {
				await session.session.prompt(task.prompt, { expandPromptTemplates: false });
				await session.session.waitForIdle();
				const stats = await session.session.getSessionStats();
				const messages = session.session.messages as AgentMessage[];
				const passed = await verifyReproContains(cwd, task);
				results.push(
					assembleRunMeasurement({
						taskId: task.id,
						argotEnabled: opts.argotEnabled,
						passed,
						outputTokens: stats.tokens.output,
						vocab,
						messages,
					}),
				);
			} finally {
				await session.session.dispose();
				await (session.mcpManager as { dispose?: () => Promise<void> } | undefined)?.dispose?.();
			}
		}
	} finally {
		authStorage.close();
	}
	return results;
}

/**
 * Run the content-reproduction bench: the same paired on/off measurement as
 * {@link runArgotBench}, but over {@link CONTENT_REPRO_TASKS}, where the agent
 * reproduces the project's recurring strings and therefore has real handles to
 * adopt. This is the workload that certifies adoption + net savings; the edit
 * fixtures certify parity + zero-leak. Returns the paired measurements and their
 * certification.
 */
export async function runContentReproBench(options: RunArgotBenchOptions): Promise<ArgotBenchOutcome> {
	const workRoot = await fs.mkdtemp(path.join(await realTmp(), "argot-repro-work-"));
	try {
		const tasks = options.taskLimit ? CONTENT_REPRO_TASKS.slice(0, options.taskLimit) : CONTENT_REPRO_TASKS;
		if (tasks.length === 0) {
			throw new Error("argot repro bench: no tasks");
		}
		const off = await runReproPhase(tasks, workRoot, { ...options, argotEnabled: false });
		const on = await runReproPhase(tasks, workRoot, { ...options, argotEnabled: true });
		return { on, off, certification: certifyArgot(on, off) };
	} finally {
		await fs.rm(workRoot, { recursive: true, force: true });
	}
}

/** One sigil's measured emit-reliability for a model. */
export interface SigilEmissionResult {
	/** The sigil character(s) under test (e.g. `§` or an ASCII candidate). */
	sigil: string;
	/** The exact handle-shaped token the model was asked to reproduce. */
	token: string;
	/** How many verbatim copies of {@link token} were requested. */
	requested: number;
	/** How many verbatim copies actually came back in the model's output. */
	emitted: number;
	/** Whether at least one verbatim copy survived (the pass/fail bit). */
	survived: boolean;
	/** First 200 chars of the raw model output, for eyeballing a failure. */
	sample: string;
}

/**
 * The sigil-emission canary. Adoption is mechanically impossible if the target
 * model will not reproduce the sigil byte-for-byte — a model that silently
 * substitutes `§` (U+00A7) with a lookalike, drops it, or re-encodes it can never
 * emit a usable handle no matter how good the dictionary is. This isolates that
 * one mechanical question from task structure and dict quality: it asks the model,
 * with argot OFF (so nothing in the harness expands or rewrites the reply), to
 * echo a handle-shaped token verbatim a fixed number of times, then counts how
 * many exact copies survived the round trip.
 *
 * Run it for `§` and one or more ASCII-safe candidates; if `§` does not survive
 * reliably while an ASCII sigil does, that is the evidence to change the default
 * sigil (it is already configurable) and record the rate in SPEC/README.
 */
export async function measureSigilEmission(
	model: string,
	sigils: readonly string[],
	repetitions = 5,
): Promise<SigilEmissionResult[]> {
	// Argot fully off: we are measuring the model's raw byte fidelity, so no encode
	// gate and no decode pass may touch the reply. `applyArgotPhaseSettings` forces
	// the value even if an earlier phase in the same process turned argot on (a plain
	// `Settings.init` would no-op and leak that on-state into this measurement).
	await applyArgotPhaseSettings(false, model);
	const authStorage = await discoverAuthStorage();
	const cwd = await fs.mkdtemp(path.join(await realTmp(), "argot-sigil-"));
	const results: SigilEmissionResult[] = [];
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		for (const sigil of sigils) {
			// A fixed nonce name keeps the token unlikely to occur by chance; the test
			// is whether the SIGIL survives, so the name is deliberately mundane.
			const token = `${sigil}kx7qz`;
			const prompt =
				`Output this exact token ${repetitions} times, separated by single spaces, ` +
				`and write nothing else at all (no quotes, no explanation): ${token}`;
			const session = await createAgentSession({
				cwd,
				modelPattern: model,
				authStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(cwd),
				toolNames: [],
				hasUI: false,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
				disableExtensionDiscovery: true,
			});
			try {
				await session.session.prompt(prompt, { expandPromptTemplates: false });
				await session.session.waitForIdle();
				const raw = assistantText(session.session.messages as AgentMessage[]);
				const emitted = countOccurrences(raw, token);
				results.push({
					sigil,
					token,
					requested: repetitions,
					emitted,
					survived: emitted > 0,
					sample: raw.slice(0, 200),
				});
			} finally {
				await session.session.dispose();
				await (session.mcpManager as { dispose?: () => Promise<void> } | undefined)?.dispose?.();
			}
		}
	} finally {
		authStorage.close();
		await fs.rm(cwd, { recursive: true, force: true });
	}
	return results;
}

/** The measured outcome of the forced-adoption probe. */
export interface ForcedAdoptionResult {
	/** How many distinct handle expansions the prompt forced the model to reproduce. */
	opportunities: number;
	/** Total handle emissions the model actually produced (adoption count). */
	handleEmissions: number;
	/** Distinct handles the model used at least once. */
	distinctHandles: number;
	/** Whether the model adopted at least one handle (the pass bit). */
	adopted: boolean;
	/** First 400 chars of the raw model output, for eyeballing a refusal. */
	sample: string;
}

/**
 * The forced-adoption probe. The edit-benchmark tasks are minimal single-line
 * diffs whose output reproduces almost none of a file's import paths, so they give
 * the model no opportunity to use a handle — a real cause of zero measured
 * adoption that is NOT the model refusing the notation. This probe removes that
 * confound: it teaches the exact preamble the harness injects plus a small handle
 * table, then asks the model to reproduce strings that ARE those handles'
 * expansions. If the model still writes them out in full, that is genuine
 * non-adoption (the notation is understood but not used); if it writes the § form,
 * the model DOES adopt when reproduction is forced and the edit bench is simply the
 * wrong instrument. Argot is off in the harness so nothing rewrites the reply; the
 * output is scored with the codec's own {@link measureDecode} against the same
 * vocabulary the model was taught.
 */
export async function measureForcedAdoption(model: string): Promise<ForcedAdoptionResult> {
	// A small, realistic table: the exact kind of long project string argot targets.
	const expansions = [
		"packages/coding-agent/src/database/connection.ts",
		"@oh-my-pi/pi-coding-agent",
		"https://rubygems.org/api/v1/gems",
	];
	const handles = new Map<string, string>([
		["conn", expansions[0]!],
		["pkg", expansions[1]!],
		["gemsapi", expansions[2]!],
	]);
	const vocab: Vocabulary = { version: 1, sigil: DEFAULT_SIGIL, handles, meta: new Map() };
	const teaching = `${renderPreamble({ tools: false })}\n\n${makePromptFragment(vocab)}`;
	const prompt =
		`${teaching}\n\n` +
		"Now apply that shorthand. Reproduce the following three references exactly, one per line, " +
		"but replace any value that appears in the dictionary above with its handle. Output only the " +
		"three lines, nothing else:\n" +
		`${expansions.join("\n")}`;

	// Argot off in the harness: this probe teaches the handles by prepending the
	// preamble to the prompt itself, so the codec must not also inject or decode.
	await applyArgotPhaseSettings(false, model);
	const authStorage = await discoverAuthStorage();
	const cwd = await fs.mkdtemp(path.join(await realTmp(), "argot-forced-"));
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		const session = await createAgentSession({
			cwd,
			modelPattern: model,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(cwd),
			toolNames: [],
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			rules: [],
			contextFiles: [],
			disableExtensionDiscovery: true,
		});
		try {
			await session.session.prompt(prompt, { expandPromptTemplates: false });
			await session.session.waitForIdle();
			const raw = assistantText(session.session.messages as AgentMessage[]);
			const measured = measureDecode(vocab, raw);
			const distinct = new Set(measured.replacements.map(r => r.name));
			return {
				opportunities: expansions.length,
				handleEmissions: measured.replacements.length,
				distinctHandles: distinct.size,
				adopted: measured.replacements.length > 0,
				sample: raw.slice(0, 400),
			};
		} finally {
			await session.session.dispose();
			await (session.mcpManager as { dispose?: () => Promise<void> } | undefined)?.dispose?.();
		}
	} finally {
		authStorage.close();
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

/** Concatenate the visible text of every assistant turn. */
function assistantText(messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages as ReadonlyArray<{ role: string; content?: unknown }>) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const part of message.content as Array<Record<string, unknown>>) {
			if (part && part.type === "text" && typeof part.text === "string") {
				parts.push(part.text);
			}
		}
	}
	return parts.join("\n");
}

/** Count non-overlapping verbatim occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) {
		return 0;
	}
	let count = 0;
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) {
			break;
		}
		count++;
		from = at + needle.length;
	}
	return count;
}

async function runPhase(
	tasks: readonly EditTask[],
	workRoot: string,
	opts: RunArgotBenchOptions & { argotEnabled: boolean },
): Promise<ArgotRunMeasurement[]> {
	await applyArgotPhaseSettings(opts.argotEnabled, opts.model, opts.disableAboveTokens);
	const authStorage = await discoverAuthStorage();
	const results: ArgotRunMeasurement[] = [];
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		for (let i = 0; i < tasks.length; i++) {
			const task = tasks[i]!;
			const destDir = path.join(workRoot, `${opts.argotEnabled ? "on" : "off"}-${i}-${task.id}`);
			const { cwd, vocab } = await prepareArgotWorkdir(task, destDir);

			const session = await createAgentSession({
				cwd,
				modelPattern: opts.model,
				authStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(cwd),
				toolNames: ["read", "edit", "write"],
				hasUI: false,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
				disableExtensionDiscovery: true,
			});
			try {
				await session.session.prompt(task.prompt, { expandPromptTemplates: false });
				await session.session.waitForIdle();
				const stats = await session.session.getSessionStats();
				const messages = session.session.messages as AgentMessage[];
				// Verify ONLY the task's target files. The workdir also holds the `.argot`
				// marker this bench drops to arm the project (scaffolding, never task
				// output); a whole-directory check would count that marker as an
				// "unexpected file" and fail every task, on AND off, masking real
				// adoption and pass numbers. Scoping to `task.files` byte-compares each
				// edited file against its expected fixture and ignores the marker.
				const verification = await verifyExpectedFileSubset(task.expectedDir, cwd, task.files);
				results.push(
					assembleRunMeasurement({
						taskId: task.id,
						argotEnabled: opts.argotEnabled,
						passed: verification.success,
						outputTokens: stats.tokens.output,
						vocab,
						messages,
					}),
				);
			} finally {
				await session.session.dispose();
				await (session.mcpManager as { dispose?: () => Promise<void> } | undefined)?.dispose?.();
			}
		}
	} finally {
		authStorage.close();
	}
	return results;
}
