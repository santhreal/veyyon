import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import { assistantTextBlocksFromUnknown } from "@veyyon/ai/utils/message-text";
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

export async function applyArgotPhaseSettings(
	argotEnabled: boolean,
	model: string,
	disableAboveTokens?: number,
): Promise<void> {
	await Settings.init();
	const settings = Settings.instance;
	settings.override("argot.enabled", argotEnabled);
	settings.override("argot.encode.models", argotEnabled ? [model] : []);
	settings.override("argot.encode.disableAboveTokens", disableAboveTokens ?? 0);
}

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

export interface RunArgotBenchOptions {
	model: string;
	taskLimit?: number;
	disableAboveTokens?: number;
	signal?: AbortSignal;
}

export interface ArgotBenchOutcome {
	on: ArgotRunMeasurement[];
	off: ArgotRunMeasurement[];
	certification: ArgotCertification;
}

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

interface ReproTask {
	id: string;
	corpus: Array<{ path: string; content: string }>;
	prompt: string;
	targetFile: string;
	required: string[];
}

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

export interface SigilEmissionResult {
	sigil: string;
	token: string;
	requested: number;
	emitted: number;
	survived: boolean;
	sample: string;
}

export async function measureSigilEmission(
	model: string,
	sigils: readonly string[],
	repetitions = 5,
): Promise<SigilEmissionResult[]> {
	await applyArgotPhaseSettings(false, model);
	const authStorage = await discoverAuthStorage();
	const cwd = await fs.mkdtemp(path.join(await realTmp(), "argot-sigil-"));
	const results: SigilEmissionResult[] = [];
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		for (const sigil of sigils) {
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

export interface ForcedAdoptionResult {
	opportunities: number;
	handleEmissions: number;
	distinctHandles: number;
	adopted: boolean;
	sample: string;
}

export async function measureForcedAdoption(model: string): Promise<ForcedAdoptionResult> {
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

function assistantText(messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages as ReadonlyArray<{ role: string; content?: unknown }>) {
		if (message.role !== "assistant") continue;
		const ab = assistantTextBlocksFromUnknown(message.content);
		for (let pi = 0; pi < ab.length; pi++) parts.push(ab[pi]!);
	}
	return parts.join("\n");
}

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
