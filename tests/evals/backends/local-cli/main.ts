/**
 * The local-cli backend: each trial is one print-mode run of a harness's CLI on this host, in a
 * sandbox of its own.
 *
 * A trial's record goes under the runs directory:
 *
 *   events.jsonl   the JSON event stream: every turn, tool call and token
 *   stderr.txt     what the CLI printed to stderr
 *   answer.txt     the text of the agent's last message
 *   workspace/     the agent's working directory as the trial left it
 *
 * plus whatever the suite's `finish` writes for its grader. The agent itself runs in a scratch
 * directory under the system temp directory ({@link localTrialLayout}), with an empty HOME, its own
 * TMPDIR, and a credential store holding the model provider's sign-in alone. It inherits only the
 * variables {@link trialEnvironment} keeps, and on Linux runs under Landlock ({@link sandboxRules}):
 * it cannot open the runner's home, the runs directory, this package, the tests of the build it
 * runs, or another trial's scratch, so it can read neither a grader nor an earlier trial's
 * transcript.
 *
 * The variant's build (`--build`) selects which tree or binary runs, so two builds of the agent
 * run interleaved in one plan on the same tasks, and their difference is measured under the same
 * host load, network and provider conditions.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import YAML from "yaml";
import type {
	BackendId,
	ExecutionBackend,
	HarnessAdapter,
	LocalCommand,
	LocalCommandContext,
	PreflightVerdict,
	RunContext,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialEnvironment,
	TrialUsage,
	Variant,
	VariantAxis,
} from "../../engine/contracts";
import { listFiles } from "../../engine/io/list-files";
import { evalsPackageDir, runsDir as defaultRunsDir, repoRootDir } from "../../engine/package-paths";
import { resolveCellVariant } from "../../engine/plan/cell-variant";
import { loadAndValidateConfigOverlay, loadAndValidatePromptOverlay } from "../../engine/plan/overlays";
import { LOCAL_TRIAL_FILES as TRIAL_FILES, trialDirFor } from "../../engine/run/layout";
import { boundRawOutput, teardownGraceFromOptions, teardownWithin, trialTimeoutFromOptions } from "../../engine/trial/deadline";
import { resolveTrialModel } from "../../engine/trial/model";
import { awaitTrialProcessOutput, terminateProcessTree } from "../../engine/trial/process";
import { credentialSource, providerCredentialCount, stageCredentials } from "./credentials";
import { trialEnvironment } from "./environment";
import { type EventUsage, finalText, readUsage } from "./events";
import { landlockSandbox, sandboxedLaunch, sandboxRules } from "./sandbox";

/**
 * Where one trial's pieces go. The record (events, answer, the suite's state) is filed under the
 * runs directory; the agent runs in a scratch directory outside every project tree, so neither the
 * CLI nor its tools find the repository's context files, settings or git root by walking up from
 * the working directory. The scratch is deleted when the trial ends, after its workspace is copied
 * into the record.
 */
export interface LocalTrialLayout {
	readonly trialDir: string;
	readonly scratch: string;
	readonly workspace: string;
	readonly home: string;
	readonly agentDir: string;
	readonly tmp: string;
}

/**
 * The directory every trial's scratch is made under; hidden from every trial but its own part.
 *
 * Short on purpose: Chrome makes a Unix socket under TMPDIR, and a socket path longer than 107
 * bytes aborts its launch. `/tmp/vey/<12 hex>/tmp/com.google.Chrome.XXXXXX/SingletonSocket` fits;
 * a scratch named after the run, variant and task did not.
 */
export function trialScratchRoot(): string {
	return path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "vey");
}

export function localTrialLayout(runsDir: string, runId: string, cell: TrialCell): LocalTrialLayout {
	const trialDir = trialDirFor(runsDir, runId, cell);
	// Derived from the record's path, so one trial's scratch is the same on every call.
	const scratch = path.join(trialScratchRoot(), createHash("sha256").update(trialDir).digest("hex").slice(0, 12));
	return {
		trialDir,
		scratch,
		workspace: path.join(scratch, "workspace"),
		home: path.join(scratch, "home"),
		agentDir: path.join(scratch, "agent"),
		tmp: path.join(scratch, "tmp"),
	};
}

interface PreparedTrial {
	readonly descriptor: TaskDescriptor;
	readonly variant: Variant;
	readonly model: string;
	readonly provider: string;
	readonly source: string;
	readonly layout: LocalTrialLayout;
	readonly localCommand: (context: LocalCommandContext) => LocalCommand;
	readonly timeoutSec: number;
}

/** How many trailing characters of stderr an error names. */
const STDERR_TAIL = 2_000;

interface AgentRun {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly wallSec: number;
	readonly usage: EventUsage;
}

export class LocalCliBackend implements ExecutionBackend {
	readonly id: BackendId = "local-cli";
	/** The settings overlay and the task's settings become `--config` files, the prompt overlay an environment variable, the build the command. */
	readonly appliesVariantAxes: readonly VariantAxis[] = ["config", "promptVariant", "build"];

	async preflight(context: RunContext): Promise<PreflightVerdict> {
		const sandbox = landlockSandbox();
		if (!sandbox.usable && context.options?.unsandboxed !== true) {
			return {
				ok: false,
				reason:
					`local-cli trials run under Landlock and this host has none (${sandbox.reason}). ` +
					"Run on Linux, or pass --unsandboxed to run anyway: the agent's tools can then read the graders.",
				missingRequirements: ["landlock"],
			};
		}
		const source = credentialSource(context.options);
		for (const variant of context.options?.variants ?? []) {
			const problem = await variantProblem(variant, context, source);
			if (problem) return { ok: false, reason: `${variant.name}: ${problem.reason}`, missingRequirements: [problem.missing] };
		}
		return { ok: true };
	}

	async prepare(context: RunContext): Promise<void> {
		await fs.mkdir(context.runsDir || defaultRunsDir(), { recursive: true });
	}

	async runTrial(cell: TrialCell, context: RunContext): Promise<TrialArtifacts> {
		const descriptor = await context.suite.describeTask(cell.task, {
			workDir: context.workDir,
			signal: context.signal,
			options: context.options,
		});
		const variant = resolveCellVariant(cell, context);
		const harness = context.harnesses.require(variant.harness);
		const localCommand = harness.localCommand?.bind(harness);
		if (!localCommand) throw new Error(`the ${harness.id} harness declares no local command`);
		const model = resolveTrialModel(variant, harness, context);
		const source = credentialSource(context.options);
		if (!source) throw new Error("no credential store to copy the model's sign-in from");

		const layout = localTrialLayout(context.runsDir || defaultRunsDir(), context.runId, cell);
		// An attempt after a thrown one starts from what a fresh trial would.
		await fs.rm(layout.trialDir, { recursive: true, force: true });
		await fs.rm(layout.scratch, { recursive: true, force: true });
		for (const dir of [layout.trialDir, layout.workspace, layout.home, layout.tmp]) {
			await fs.mkdir(dir, { recursive: true });
		}
		const timeoutSec = trialTimeoutFromOptions(descriptor.timeBudgetSec, context.options);
		let run: AgentRun;
		try {
			await copyTaskInput(descriptor, layout.workspace);
			run = await this.#runPrepared(cell, context, {
				descriptor,
				variant,
				model: model.id,
				provider: model.provider,
				source,
				layout,
				localCommand,
				timeoutSec,
			});
		} finally {
			// The workspace is the agent's output; the rest of the scratch (home, credential, temp) is not kept.
			await fs
				.cp(layout.workspace, path.join(layout.trialDir, "workspace"), { recursive: true, verbatimSymlinks: true })
				.catch(() => {});
			await fs.rm(layout.scratch, { recursive: true, force: true });
		}

		const answer = finalText(run.stdout);
		await fs.writeFile(path.join(layout.trialDir, TRIAL_FILES.events), run.stdout);
		await fs.writeFile(path.join(layout.trialDir, TRIAL_FILES.stderr), run.stderr);
		await fs.writeFile(path.join(layout.trialDir, TRIAL_FILES.answer), answer);
		if (run.aborted) throw new Error("the trial was aborted by the run's cancellation");
		// An agent that exited on an error before its first turn measured nothing: a bad flag, a
		// sign-in the provider refused, a build that does not start. That is infrastructure, and
		// another attempt may succeed; a run that took turns is an outcome and is graded.
		if (run.usage.turns === 0 && !run.timedOut && run.exitCode !== 0) {
			throw new Error(`the agent exited with code ${run.exitCode} before its first turn: ${run.stderr.slice(-STDERR_TAIL)}`);
		}

		const files: Record<string, string> = {};
		for (const file of await listFiles(layout.trialDir).catch(() => [])) {
			files[file] = path.join(layout.trialDir, file);
		}
		const usage: TrialUsage = {
			inputTokens: run.usage.inputTokens,
			outputTokens: run.usage.outputTokens,
			cacheTokens: run.usage.cacheReadTokens + run.usage.cacheWriteTokens,
			cacheReadTokens: run.usage.cacheReadTokens,
			cacheWriteTokens: run.usage.cacheWriteTokens,
			// A provider with no pricing reports 0, which is not a free trial.
			costUsd: run.usage.costUsd > 0 ? run.usage.costUsd : null,
			durationSec: run.wallSec,
			extra: { turns: run.usage.turns, toolCalls: run.usage.toolCalls },
		};
		return {
			trialDir: layout.trialDir,
			logPaths: [path.join(layout.trialDir, TRIAL_FILES.events), path.join(layout.trialDir, TRIAL_FILES.stderr)],
			rawOutput: boundRawOutput(answer),
			filePaths: files,
			usage,
			extra: {
				cell,
				variant: cell.variant,
				build: variant.build ?? null,
				model: model.id,
				trialDir: layout.trialDir,
				exitCode: run.exitCode,
				timedOut: run.timedOut,
				timeoutSec,
				turns: run.usage.turns,
				toolCalls: run.usage.toolCalls,
				sandboxed: landlockSandbox().usable,
			},
		};
	}

	/** Start the suite's services, run the agent under the sandbox, then let the suite finish. */
	async #runPrepared(cell: TrialCell, context: RunContext, trial: PreparedTrial): Promise<AgentRun> {
		const { layout, variant } = trial;
		const environment = await context.suite.prepareTrial?.(cell, {
			trialDir: layout.trialDir,
			workspace: layout.workspace,
			signal: context.signal,
			options: context.options,
		});
		let run: AgentRun | undefined;
		let failure: unknown = null;
		try {
			stageCredentials(trial.source, trial.provider, layout.agentDir);
			const instruction = environment?.instruction ?? (await taskInstruction(trial.descriptor));
			const configFiles = await trialConfigFiles(variant, environment, layout, context.workDir);
			const command = trial.localCommand({
				model: trial.model,
				instruction,
				tools: environment?.tools ?? optionTools(context.options),
				configFiles,
				build: variant.build ?? null,
				agentDir: layout.agentDir,
				options: context.options ?? {},
			});
			const prompts = variant.promptVariantPath
				? (await loadAndValidatePromptOverlay(variant.promptVariantPath, context.workDir)).overrides
				: null;
			const rules = await sandboxRules({
				hidden: hiddenDirectories(context, variant.build ?? null),
				read: [...command.readable, ...configFiles, ...(environment?.readable ?? [])],
				write: [layout.scratch],
			});
			run = await runAgent({
				launch: sandboxedLaunch(landlockSandbox(), rules, command.command, command.args),
				cwd: layout.workspace,
				env: {
					...trialEnvironment(process.env),
					HOME: layout.home,
					USERPROFILE: layout.home,
					TMPDIR: layout.tmp,
					TMP: layout.tmp,
					TEMP: layout.tmp,
					...environment?.env,
					...command.env,
					...(prompts ? { VEYYON_EVAL_PROMPTS: JSON.stringify(prompts) } : {}),
				},
				timeoutMs: trial.timeoutSec * 1000,
				signal: context.signal,
			});
		} catch (cause) {
			failure = cause;
		}
		const finishProblem = environment
			? await teardownWithin(() => environment.finish(), teardownGraceFromOptions(context.options))
			: null;
		if (failure !== null) throw failure;
		if (!run) throw new Error("the agent never started");
		if (finishProblem) throw new Error(`the suite could not finish the trial: ${finishProblem}`);
		return run;
	}

	async cleanup(cell: TrialCell, context: RunContext): Promise<void> {
		if (context.options?.cleanup !== true) return;
		const trialDir = trialDirFor(context.runsDir || defaultRunsDir(), context.runId, cell);
		await fs.rm(trialDir, { recursive: true, force: true }).catch(() => {});
	}
}

async function variantProblem(
	variant: Variant,
	context: RunContext,
	source: string | null,
): Promise<{ readonly reason: string; readonly missing: string } | null> {
	const harness: HarnessAdapter | undefined = context.harnesses.get(variant.harness);
	if (!harness?.localCommand) {
		return { reason: `the ${variant.harness} harness declares no local command`, missing: "local-command" };
	}
	if (variant.build) {
		try {
			await fs.stat(variant.build);
		} catch {
			return { reason: `the build ${variant.build} does not exist`, missing: "build" };
		}
	}
	try {
		if (variant.configPath) await loadAndValidateConfigOverlay(variant.configPath, context.workDir);
		if (variant.promptVariantPath) await loadAndValidatePromptOverlay(variant.promptVariantPath, context.workDir);
	} catch (error) {
		return { reason: errorMessage(error), missing: "valid-overlay" };
	}
	let provider: string;
	try {
		provider = resolveTrialModel(variant, harness, context).provider;
	} catch (error) {
		return { reason: errorMessage(error), missing: "model" };
	}
	if (!source) {
		return { reason: "no credential store exists; sign in with the CLI first", missing: "credentials" };
	}
	if (providerCredentialCount(source, provider) === 0) {
		return { reason: `${source} holds no usable ${provider} sign-in`, missing: "credentials" };
	}
	return null;
}

/** The task's instruction: the descriptor's prompt, else its instruction file. */
async function taskInstruction(descriptor: TaskDescriptor): Promise<string> {
	const prompt = descriptor.metadata.prompt;
	if (typeof prompt === "string" && prompt.length > 0) return prompt;
	if (descriptor.instructionPath) return (await fs.readFile(descriptor.instructionPath, "utf8")).trim();
	throw new Error(`task ${descriptor.id} states no instruction`);
}

/** Copy the task's input files, when it has any, into the workspace. */
async function copyTaskInput(descriptor: TaskDescriptor, workspace: string): Promise<void> {
	const stated = descriptor.metadata.inputDir;
	const inputDir = typeof stated === "string" ? stated : descriptor.path ? path.join(descriptor.path, "input") : null;
	if (!inputDir) return;
	for (const file of await listFiles(inputDir).catch(() => [])) {
		const destination = path.join(workspace, file);
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.copyFile(path.join(inputDir, file), destination);
	}
}

/**
 * The trial's `--config` files in the order they apply: the task's own settings, then the
 * variant's overlay, so an arm can change a default the task leaves open.
 */
async function trialConfigFiles(
	variant: Variant,
	environment: TrialEnvironment | undefined,
	layout: LocalTrialLayout,
	workDir: string,
): Promise<string[]> {
	const files: string[] = [];
	if (environment?.settings && Object.keys(environment.settings).length > 0) {
		const taskSettings = path.join(layout.agentDir, "task-settings.yml");
		await fs.writeFile(taskSettings, YAML.stringify(environment.settings));
		files.push(taskSettings);
	}
	if (variant.configPath) files.push((await loadAndValidateConfigOverlay(variant.configPath, workDir)).resolvedPath);
	return files;
}

function optionTools(options: Readonly<Record<string, unknown>> | undefined): readonly string[] {
	const tools = options?.tools;
	return Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === "string") : [];
}

/**
 * What a trial cannot read: the runner's home, the runs directory, every trial's scratch (its own
 * is granted back), this package (graders, fixture sources) and the tests of the build it runs.
 */
function hiddenDirectories(context: RunContext, build: string | null): string[] {
	return [
		os.homedir(),
		path.resolve(context.runsDir || defaultRunsDir()),
		trialScratchRoot(),
		evalsPackageDir(),
		path.join(path.resolve(build ?? repoRootDir()), "tests"),
	];
}

interface AgentLaunch {
	readonly launch: { readonly command: string; readonly args: readonly string[] };
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

/** Run the agent to its exit, its deadline or the run's cancellation, and keep what it printed. */
async function runAgent(options: AgentLaunch): Promise<AgentRun> {
	const started = Date.now();
	// Its own process group, so a deadline ends the agent and every browser and shell it started.
	const child = spawn(options.launch.command, [...options.launch.args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	const exited = exitOf(child);
	const result = await awaitTrialProcessOutput({
		exited,
		stdout: textOf(child.stdout),
		stderr: textOf(child.stderr),
		timeoutMs: options.timeoutMs,
		signal: options.signal,
		terminate: async () => {
			await terminateProcessTree({ pid: child.pid, kill: signal => child.kill(signal), exited });
		},
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		timedOut: result.kind === "timed_out",
		aborted: result.kind === "aborted",
		wallSec: (Date.now() - started) / 1000,
		usage: readUsage(result.stdout),
	};
}

function exitOf(child: ChildProcess): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	child.once("error", () => resolve(-1));
	child.once("exit", code => resolve(code ?? -1));
	return promise;
}

function textOf(stream: NodeJS.ReadableStream | null): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	if (!stream) {
		resolve("");
		return promise;
	}
	const chunks: Buffer[] = [];
	stream.on("data", (chunk: Buffer) => chunks.push(chunk));
	stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	stream.once("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
	return promise;
}

export const localCliBackend = new LocalCliBackend();

export default localCliBackend;
