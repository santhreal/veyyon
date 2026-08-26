import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { defaultSuiteRegistry, type SuiteRegistry } from "../../core/suite-registry";
import type {
	BackendId,
	EvalSuite,
	PreflightVerdict,
	SuiteContext,
	SuiteProvenance,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialScore,
	TrialUsage,
} from "../../core/types";
import { typescriptEditCacheDir, typescriptEditFixturesArchive } from "../../paths";
import { computeTypescriptEditProvenance, TYPESCRIPT_EDIT_SUITE_NAME, TYPESCRIPT_EDIT_VERSION } from "./provenance";
import { type EditTask, loadTasksFromDir } from "./tasks";
import { verifyExpectedFileSubset } from "./verify";

export interface TypescriptEditSuiteOptions {
	readonly defaultArchive?: string;
	readonly defaultFixturesDir?: string;
	readonly version?: string;
}

/**
 * EvalSuite implementation for the TypeScript edit benchmark.
 */
export class TypescriptEditSuite implements EvalSuite {
	readonly name = TYPESCRIPT_EDIT_SUITE_NAME;
	readonly version: string;
	readonly displayName = "TypeScript Edit Benchmark";
	readonly description =
		"Mutation-based code editing benchmark evaluating surgical editing precision on TypeScript source";
	readonly backend: BackendId = "in-process";

	readonly #defaultArchive: string | undefined;
	readonly #defaultFixturesDir: string | undefined;
	#extractedDir: string | null = null;
	#taskMap: Map<string, EditTask> | null = null;

	constructor(options: TypescriptEditSuiteOptions = {}) {
		this.version = options.version ?? TYPESCRIPT_EDIT_VERSION;
		this.#defaultArchive = options.defaultArchive;
		this.#defaultFixturesDir = options.defaultFixturesDir;
	}

	#resolveArchivePath(context: SuiteContext): string {
		if (context.options?.fixturesArchive && typeof context.options.fixturesArchive === "string") {
			return path.resolve(context.options.fixturesArchive);
		}
		if (context.datasetDir && (context.datasetDir.endsWith(".tar.gz") || context.datasetDir.endsWith(".tar"))) {
			return path.resolve(context.datasetDir);
		}
		return this.#defaultArchive ?? typescriptEditFixturesArchive();
	}

	async #ensureExtracted(archivePath: string): Promise<string> {
		if (this.#extractedDir) {
			const check = await fs.stat(this.#extractedDir).catch(() => null);
			if (check?.isDirectory()) {
				return this.#extractedDir;
			}
		}

		const cacheRoot = typescriptEditCacheDir();
		await fs.mkdir(cacheRoot, { recursive: true });

		const buffer = await fs.readFile(archivePath);
		const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
		const targetDir = path.join(cacheRoot, hash);

		const targetStat = await fs.stat(targetDir).catch(() => null);
		if (targetStat?.isDirectory()) {
			const entries = await fs.readdir(targetDir, { withFileTypes: true });
			const dirs = entries.filter(entry => entry.isDirectory());
			const files = entries.filter(entry => entry.isFile());
			const finalDir = dirs.length === 1 && files.length === 0 ? path.join(targetDir, dirs[0]!.name) : targetDir;
			this.#extractedDir = finalDir;
			return finalDir;
		}

		const stagingDir = path.join(cacheRoot, `staging-${hash}-${Date.now()}`);
		await fs.mkdir(stagingDir, { recursive: true });

		const archive = new Bun.Archive(buffer.buffer);
		for (const [filePath, file] of await archive.files()) {
			const fullPath = path.join(stagingDir, filePath);
			await fs.mkdir(path.dirname(fullPath), { recursive: true });
			await fs.writeFile(fullPath, Buffer.from(await file.arrayBuffer()));
		}

		try {
			await fs.rename(stagingDir, targetDir);
		} catch {
			await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
		}

		const entries = await fs.readdir(targetDir, { withFileTypes: true });
		const dirs = entries.filter(entry => entry.isDirectory());
		const files = entries.filter(entry => entry.isFile());
		const finalDir = dirs.length === 1 && files.length === 0 ? path.join(targetDir, dirs[0]!.name) : targetDir;
		this.#extractedDir = finalDir;
		return finalDir;
	}

	async #getTasks(context: SuiteContext): Promise<EditTask[]> {
		if (
			this.#taskMap &&
			this.#taskMap.size > 0 &&
			!context.datasetDir &&
			!context.options?.fixturesDir &&
			!context.options?.fixturesArchive
		) {
			return [...this.#taskMap.values()];
		}

		let fixturesDir: string;
		if (context.options?.fixturesDir && typeof context.options.fixturesDir === "string") {
			fixturesDir = path.resolve(context.options.fixturesDir);
		} else if (
			context.datasetDir &&
			!(context.datasetDir.endsWith(".tar.gz") || context.datasetDir.endsWith(".tar"))
		) {
			fixturesDir = path.resolve(context.datasetDir);
		} else if (this.#defaultFixturesDir) {
			fixturesDir = path.resolve(this.#defaultFixturesDir);
		} else {
			const archivePath = this.#resolveArchivePath(context);
			fixturesDir = await this.#ensureExtracted(archivePath);
		}

		const tasks = await loadTasksFromDir(fixturesDir);
		this.#taskMap = new Map(tasks.map(t => [t.id, t]));
		return tasks;
	}

	async discoverTasks(context: SuiteContext = {}): Promise<readonly string[]> {
		if (Array.isArray(context.options?.tasks) && context.options.tasks.length > 0) {
			return context.options.tasks.filter((t): t is string => typeof t === "string");
		}
		if (Array.isArray(context.options?.taskIds) && context.options.taskIds.length > 0) {
			return context.options.taskIds.filter((t): t is string => typeof t === "string");
		}

		const tasks = await this.#getTasks(context);
		let taskIds = tasks.map(t => t.id);

		if (typeof context.options?.maxTasks === "number" && context.options.maxTasks > 0) {
			taskIds = taskIds.slice(0, context.options.maxTasks);
		}

		return taskIds;
	}

	async describeTask(taskId: string, context: SuiteContext = {}): Promise<TaskDescriptor> {
		const tasks = await this.#getTasks(context);
		const task = tasks.find(t => t.id === taskId);
		if (!task) {
			const available = tasks
				.map(t => t.id)
				.slice(0, 10)
				.join(", ");
			throw new Error(`TypeScript-edit task "${taskId}" not found. Available tasks: ${available}...`);
		}

		const taskDir = path.dirname(task.inputDir);
		const instructionPath = path.join(taskDir, "prompt.md");

		return {
			id: task.id,
			path: taskDir,
			timeBudgetSec: 120,
			instructionPath,
			metadata: {
				name: task.name,
				prompt: task.prompt,
				files: task.files,
				inputDir: task.inputDir,
				expectedDir: task.expectedDir,
				...(task.metadata ?? {}),
			},
		};
	}

	async provenance(context: SuiteContext = {}): Promise<SuiteProvenance> {
		if (context.options?.fixturesDir && typeof context.options.fixturesDir === "string") {
			return computeTypescriptEditProvenance({
				fixturesDir: path.resolve(context.options.fixturesDir),
				version: this.version,
			});
		}

		const archivePath = this.#resolveArchivePath(context);
		return computeTypescriptEditProvenance({
			archivePath,
			version: this.version,
		});
	}

	async preflight(context: SuiteContext = {}): Promise<PreflightVerdict> {
		if (context.options?.fixturesDir && typeof context.options.fixturesDir === "string") {
			const dir = path.resolve(context.options.fixturesDir);
			try {
				const s = await fs.stat(dir);
				if (!s.isDirectory()) {
					return {
						ok: false,
						reason: `TypeScript-edit fixtures directory at ${dir} is not a directory.`,
						missingRequirements: ["fixtures-directory"],
					};
				}
				const tasks = await loadTasksFromDir(dir);
				if (tasks.length === 0) {
					return {
						ok: false,
						reason: `TypeScript-edit fixtures directory at ${dir} contains no valid task fixtures.`,
						missingRequirements: ["fixtures-directory-contents"],
					};
				}
				return { ok: true };
			} catch (error) {
				const err = errorMessage(error);
				return {
					ok: false,
					reason: `TypeScript-edit fixtures directory at ${dir} is unreadable: ${err}.`,
					missingRequirements: ["fixtures-directory"],
				};
			}
		}

		const archivePath = this.#resolveArchivePath(context);
		try {
			const s = await fs.stat(archivePath);
			if (!s.isFile()) {
				return {
					ok: false,
					reason: `TypeScript-edit fixture archive at ${archivePath} is not a file. Ensure datasets/typescript-edit/fixtures.tar.gz exists.`,
					missingRequirements: ["fixture-archive"],
				};
			}
			if (s.size === 0) {
				return {
					ok: false,
					reason: `TypeScript-edit fixture archive at ${archivePath} is empty (0 bytes). Re-generate or restore datasets/typescript-edit/fixtures.tar.gz.`,
					missingRequirements: ["fixture-archive"],
				};
			}
		} catch (error) {
			const err = errorMessage(error);
			return {
				ok: false,
				reason: `TypeScript-edit fixture archive is missing or unreadable at ${archivePath} (${err}). Ensure datasets/typescript-edit/fixtures.tar.gz exists.`,
				missingRequirements: ["fixture-archive"],
			};
		}

		try {
			const buffer = await fs.readFile(archivePath);
			const archive = new Bun.Archive(buffer.buffer);
			const files = await archive.files();
			if (files.size === 0) {
				return {
					ok: false,
					reason: `TypeScript-edit fixture archive at ${archivePath} contains no files.`,
					missingRequirements: ["fixture-archive-contents"],
				};
			}
		} catch (error) {
			const err = errorMessage(error);
			return {
				ok: false,
				reason: `TypeScript-edit fixture archive at ${archivePath} is corrupt or unreadable: ${err}.`,
				missingRequirements: ["fixture-archive-readable"],
			};
		}

		return { ok: true };
	}

	async scoreTrial(cell: TrialCell, artifacts: TrialArtifacts): Promise<TrialScore> {
		const trialDir = artifacts.trialDir ?? (artifacts.extra?.trialDir as string | undefined);
		if (!trialDir) {
			return {
				reward: null,
				partial: null,
				error: "Missing trialDir in trial artifacts",
				usage: (artifacts.extra?.usage as TrialUsage | null | undefined) ?? null,
				extra: { ...artifacts.extra, cell },
			};
		}

		try {
			const descriptor = await this.describeTask(cell.task);
			const expectedDir = descriptor.metadata.expectedDir as string;
			const files = descriptor.metadata.files as string[] | undefined;

			const verification = await verifyExpectedFileSubset(expectedDir, trialDir, files);

			const reward = verification.success ? 1 : 0;
			const partial = verification.success ? 1 : verification.formattedEquivalent ? 0.5 : 0;
			const usage = (artifacts.extra?.usage as TrialUsage | null | undefined) ?? null;

			return {
				reward,
				partial,
				error: null,
				usage,
				extra: {
					...artifacts.extra,
					cell,
					success: verification.success,
					error: verification.error ?? null,
					duration: verification.duration,
					indentScore: verification.indentScore ?? 0,
					formattedEquivalent: verification.formattedEquivalent ?? false,
					diffStats: verification.diffStats ?? { linesChanged: 0, charsChanged: 0 },
					diff: verification.diff ?? null,
				},
			};
		} catch (error) {
			const err = errorMessage(error);
			return {
				reward: null,
				partial: null,
				error: `Scoring failed: ${err}`,
				usage: (artifacts.extra?.usage as TrialUsage | null | undefined) ?? null,
				extra: { ...artifacts.extra, cell, error: err },
			};
		}
	}
}

export const typescriptEditSuite = new TypescriptEditSuite();

/**
 * Registers the TypeScript edit benchmark suite in the suite registry.
 * Idempotent: safe to call multiple times.
 */
export function registerTypescriptEditSuite(registry?: SuiteRegistry): void {
	const target = registry ?? defaultSuiteRegistry;
	if (!target.has(typescriptEditSuite.name)) {
		target.register(typescriptEditSuite);
	}
}

// Auto-register on module load
registerTypescriptEditSuite();
