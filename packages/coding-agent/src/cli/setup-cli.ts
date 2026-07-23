/**
 * Setup CLI command handler.
 *
 * Handles `veyyon setup` for onboarding and `veyyon setup <component>` for optional dependencies.
 */
import * as path from "node:path";
import { $which, getProjectDir, getPythonEnvDir } from "@veyyon/utils";
import { $ } from "bun";
import chalk from "chalk";
import { Settings, settings } from "../config/settings";
import { formatDoctorResults, runDoctorChecks } from "../extensibility/plugins/doctor";
import { theme } from "../modes/theme/theme";
import { downloadSttModel, isSttModelCached } from "../stt/downloader";
import { isSttModelKey, STT_MODEL_OPTIONS } from "../stt/models";
import { detectRecorder, ensureRecorder } from "../stt/recorder";
import { downloadTtsModel, isTtsLocalModelKey, isTtsModelCached, TTS_LOCAL_MODEL_OPTIONS } from "../tts";
import { makeCoarseStepPrinter } from "./progress-line";
import { selectSetupModel } from "./setup-model-picker";

export type SetupComponent = "python" | "speech" | "status" | "auth" | "";
export interface SetupCommandArgs {
	component: SetupComponent;
	flags: {
		json?: boolean;
		check?: boolean;
	};
}

/** Canonical component list; the `setup` command's options validation imports this. */
export const SETUP_COMPONENTS: SetupComponent[] = ["python", "speech", "status", "auth", ""];

const MANAGED_PYTHON_ENV = getPythonEnvDir();

interface PythonCheckResult {
	available: boolean;
	pythonPath?: string;
	usingManagedEnv?: boolean;
	managedEnvPath?: string;
}

function managedPythonPath(): string {
	return process.platform === "win32"
		? path.join(MANAGED_PYTHON_ENV, "Scripts", "python.exe")
		: path.join(MANAGED_PYTHON_ENV, "bin", "python");
}

/**
 * Check Python environment and kernel dependencies.
 */
async function checkPythonSetup(): Promise<PythonCheckResult> {
	const result: PythonCheckResult = {
		available: false,
		managedEnvPath: MANAGED_PYTHON_ENV,
	};

	const systemPythonPath = $which("python") ?? $which("python3");
	const managedPath = managedPythonPath();
	const hasManagedEnv = await Bun.file(managedPath).exists();

	const pythonPath = systemPythonPath ?? (hasManagedEnv ? managedPath : undefined);
	if (!pythonPath) {
		return result;
	}
	const probe = await $`${pythonPath} -c "import sys;sys.exit(0)"`.quiet().nothrow();
	result.pythonPath = pythonPath;
	result.available = probe.exitCode === 0;
	result.usingManagedEnv = pythonPath === managedPath;
	return result;
}

/**
 * Install Python packages using uv (preferred) or pip.
 */
// Python installation helper removed: the subprocess runner has no Python
// package dependencies beyond a working interpreter. `veyyon setup python --check`
// remains as a probe; users install optional libs (pandas, matplotlib, ...)
// directly via pip or the in-process `%pip` magic.

/**
 * Run the setup command.
 */
export async function runSetupCommand(cmd: SetupCommandArgs): Promise<void> {
	switch (cmd.component) {
		case "python":
			await handlePythonSetup(cmd.flags);
			break;
		case "speech":
			await handleSpeechSetup(cmd.flags);
			break;
		default:
			await handleStatusSetup(cmd.flags);
			break;
	}
}

async function handleStatusSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const checks = await runDoctorChecks();
	if (flags.json) {
		console.log(JSON.stringify(checks, null, 2));
		return;
	}
	console.log(formatDoctorResults(checks));
}

async function handlePythonSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const check = await checkPythonSetup();

	if (flags.json) {
		console.log(JSON.stringify(check, null, 2));
		if (!check.available) process.exit(1);
		return;
	}

	if (!check.pythonPath) {
		console.error(chalk.red(`${theme.status.error} Python not found`));
		console.error(chalk.dim("Install Python 3.8+ and ensure it's in your PATH"));
		process.exit(1);
	}

	console.log(chalk.dim(`Python: ${check.pythonPath}`));
	if (check.usingManagedEnv) {
		console.log(chalk.dim(`Using managed environment: ${check.managedEnvPath}`));
	}

	if (check.available) {
		console.log(chalk.green(`\n${theme.status.success} Python execution is ready`));
		return;
	}

	console.error(chalk.red(`\n${theme.status.error} Python interpreter reported failure`));
	process.exit(1);
}

/**
 * One installable speech dependency. `isReady`/`status` are read-only probes;
 * `pick` (optional) lets an interactive user choose + persist a model; `ensure`
 * performs the download, streaming a normalized progress event.
 */
interface SpeechComponent {
	name: string;
	isReady(): Promise<boolean>;
	status(): Promise<string>;
	pick?(): Promise<boolean>;
	ensure(onProgress: (progress: { stage: string; percent?: number }) => void): Promise<void>;
}

function buildSpeechComponents(): SpeechComponent[] {
	return [
		{
			name: "Recorder",
			isReady: async () => detectRecorder() !== null,
			status: async () => {
				const recorder = detectRecorder();
				return recorder ? `${recorder.tool} (${recorder.bin})` : "none — ffmpeg will be downloaded";
			},
			ensure: async onProgress => {
				await ensureRecorder(onProgress);
			},
		},
		{
			name: "Speech-to-Text model",
			isReady: () => isSttModelCached(settings.get("stt.modelName")),
			status: async () => {
				const key = settings.get("stt.modelName");
				return (await isSttModelCached(key)) ? key : `${key} — not downloaded`;
			},
			pick: async () => {
				const chosen = await selectSetupModel(
					"Speech-to-Text model",
					[...STT_MODEL_OPTIONS],
					settings.get("stt.modelName"),
				);
				if (chosen === null) return false;
				if (isSttModelKey(chosen)) {
					settings.set("stt.modelName", chosen);
					await settings.flush();
				}
				return true;
			},
			ensure: onProgress =>
				downloadSttModel(settings.get("stt.modelName"), progress =>
					onProgress({ stage: `Downloading ${progress.label} model`, percent: progress.percent }),
				),
		},
		{
			name: "Text-to-Speech model",
			isReady: () => isTtsModelCached(settings.get("tts.localModel")),
			status: async () => {
				const key = settings.get("tts.localModel");
				return (await isTtsModelCached(key)) ? key : `${key} — model/runtime not installed`;
			},
			pick: async () => {
				const chosen = await selectSetupModel(
					"Text-to-Speech model",
					[...TTS_LOCAL_MODEL_OPTIONS],
					settings.get("tts.localModel"),
				);
				if (chosen === null) return false;
				if (isTtsLocalModelKey(chosen)) {
					settings.set("tts.localModel", chosen);
					await settings.flush();
				}
				return true;
			},
			ensure: async onProgress => {
				const ok = await downloadTtsModel(settings.get("tts.localModel"), progress =>
					onProgress({ stage: progress.stage, percent: progress.percent }),
				);
				if (!ok) throw new Error("Failed to download the local text-to-speech model.");
			},
		},
	];
}

/**
 * Unified `veyyon setup speech` flow. Drives every {@link SpeechComponent} through
 * one path: report (`--json`/`--check`) or install (interactive pick + ensure
 * with single-line progress; non-TTY skips pickers and installs configured
 * values).
 */
async function handleSpeechSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	await Settings.init({ cwd: getProjectDir() });
	const components = buildSpeechComponents();

	if (flags.json) {
		const report: Record<string, { ready: boolean; status: string }> = {};
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			report[component.name] = { ready, status: await component.status() };
		}
		console.log(JSON.stringify(report, null, 2));
		if (!allReady) process.exit(1);
		return;
	}

	if (flags.check) {
		console.log(chalk.bold("Speech dependencies:"));
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			const mark = ready ? chalk.green("[ok]") : chalk.yellow("[missing]");
			console.log(`  ${mark} ${component.name}: ${await component.status()}`);
		}
		if (!allReady) process.exit(1);
		return;
	}

	const interactive = Boolean(process.stdout.isTTY);
	for (const component of components) {
		if (interactive && component.pick) {
			await component.pick();
		}
		if (await component.isReady()) {
			console.log(chalk.green(`${theme.status.success} ${component.name} ready`));
			continue;
		}
		console.log(chalk.dim(`Preparing ${component.name}...`));
		try {
			const stepPrinter = makeCoarseStepPrinter(line => process.stdout.write(`${line}\n`));
			await component.ensure(progress => {
				if (process.stdout.isTTY) {
					const percent = typeof progress.percent === "number" ? ` (${progress.percent}%)` : "";
					process.stdout.write(`\r${chalk.dim(`${progress.stage}${percent}`)}\x1b[K`);
					return;
				}
				stepPrinter(progress.stage, progress.percent);
			});
			if (process.stdout.isTTY) process.stdout.write("\n");
		} catch (err) {
			process.stdout.write("\n");
			const msg = err instanceof Error ? err.message : `Failed to set up ${component.name}`;
			console.error(chalk.red(`${theme.status.error} ${msg}`));
			process.exit(1);
		}
	}

	console.log(chalk.green(`\n${theme.status.success} Speech is ready`));
	console.log(
		chalk.dim(
			"Enable speech-to-text via stt.enabled, then hold Space to talk (or bind app.stt.toggle); enable the speech-generation tool via speechgen.enabled; speak replies aloud via speech.enabled.",
		),
	);
}
