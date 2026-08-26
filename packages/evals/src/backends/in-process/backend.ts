import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { type BackendRegistry, defaultBackendRegistry } from "../../core/backend-registry";
import type {
	BackendId,
	ExecutionBackend,
	PreflightVerdict,
	RunContext,
	TrialArtifacts,
	TrialCell,
	TrialUsage,
} from "../../core/types";
import { runsDir as defaultRunsDir } from "../../paths";
import { listFiles } from "../../suites/typescript-edit/shared";
import {
	type DiscoverSharedInfraOptions,
	discoverSharedInfra,
	InProcessClient,
	type InProcessClientOptions,
	type SharedInfra,
} from "./client";

export interface InProcessClientLike {
	start(): Promise<void>;
	prompt(text: string): Promise<void>;
	getSessionStats(): Promise<{
		tokens: {
			input: number;
			output: number;
			reasoning?: number;
			cacheRead?: number;
			cacheWrite?: number;
			total: number;
		};
		assistantMessages: number;
	}>;
	getLastAssistantText(): Promise<string | null>;
	dispose(): Promise<void>;
}

export type InProcessClientFactory = (options: InProcessClientOptions) => InProcessClientLike;

export interface InProcessBackendOptions {
	readonly shared?: SharedInfra;
	readonly clientFactory?: InProcessClientFactory;
}

/**
 * ExecutionBackend implementation for in-process AgentSession evaluation.
 * Runs benchmark tasks directly in the local process, reusing auth/model infrastructure.
 */
export class InProcessBackend implements ExecutionBackend {
	readonly id: BackendId = "in-process";

	#sharedInfra: SharedInfra | null = null;
	readonly #clientFactory: InProcessClientFactory | undefined;

	constructor(options: InProcessBackendOptions = {}) {
		this.#sharedInfra = options.shared ?? null;
		this.#clientFactory = options.clientFactory;
	}

	async preflight(context: RunContext): Promise<PreflightVerdict> {
		if (this.#clientFactory) {
			return { ok: true };
		}
		try {
			if (!this.#sharedInfra) {
				const infraOptions: DiscoverSharedInfraOptions = {
					cwd: context.workDir,
					editVariant: context.options?.editVariant as string | undefined,
					editFuzzy: context.options?.editFuzzy as boolean | "auto" | undefined,
					editFuzzyThreshold: context.options?.editFuzzyThreshold as number | "auto" | undefined,
				};
				this.#sharedInfra = await discoverSharedInfra(infraOptions);
			}
			return { ok: true };
		} catch (error) {
			const err = errorMessage(error);
			return {
				ok: false,
				reason: `In-process backend preflight failed to discover shared auth/models: ${err}`,
				missingRequirements: ["in-process-infra"],
			};
		}
	}

	async prepare(context: RunContext): Promise<void> {
		const runsDir = context.runsDir || defaultRunsDir();
		await fs.mkdir(runsDir, { recursive: true });

		if (!this.#sharedInfra && !this.#clientFactory) {
			const infraOptions: DiscoverSharedInfraOptions = {
				cwd: context.workDir,
				editVariant: context.options?.editVariant as string | undefined,
				editFuzzy: context.options?.editFuzzy as boolean | "auto" | undefined,
				editFuzzyThreshold: context.options?.editFuzzyThreshold as number | "auto" | undefined,
			};
			this.#sharedInfra = await discoverSharedInfra(infraOptions);
		}
	}

	async runTrial(cell: TrialCell, context: RunContext): Promise<TrialArtifacts> {
		const descriptor = await context.suite.describeTask(cell.task, {
			workDir: context.workDir,
			signal: context.signal,
			options: context.options,
		});

		const runsDir = context.runsDir || defaultRunsDir();
		const variantSegment = (cell.variant || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
		const taskSegment = cell.task.replace(/[^a-zA-Z0-9._-]/g, "_");
		const trialDir = path.join(
			runsDir,
			context.runId || "in-process-run",
			variantSegment,
			taskSegment,
			`repeat-${cell.repeat ?? 0}`,
		);
		await fs.mkdir(trialDir, { recursive: true });

		const inputDir =
			(descriptor.metadata.inputDir as string | undefined) ??
			(descriptor.path ? path.join(descriptor.path, "input") : null);

		if (inputDir) {
			const fileList =
				(descriptor.metadata.files as string[] | undefined) ?? (await listFiles(inputDir).catch(() => []));
			for (const rel of fileList) {
				const src = path.join(inputDir, rel);
				const dst = path.join(trialDir, rel);
				await fs.mkdir(path.dirname(dst), { recursive: true });
				await fs.copyFile(src, dst);
			}
		}

		let instruction = "";
		if (typeof descriptor.metadata.prompt === "string" && descriptor.metadata.prompt) {
			instruction = descriptor.metadata.prompt;
		} else if (descriptor.instructionPath) {
			instruction = (await fs.readFile(descriptor.instructionPath, "utf-8")).trim();
		}

		const model =
			(context.options?.model as string | undefined) ??
			(context.options?.defaultModel as string | undefined) ??
			"anthropic/claude-sonnet-4-6";

		const clientOptions: InProcessClientOptions = {
			cwd: trialDir,
			model,
			appendSystemPrompt: context.options?.appendSystemPrompt as string | undefined,
			tools: (context.options?.tools as string[] | undefined) ?? ["read", "edit", "write"],
			editVariant: context.options?.editVariant as string | undefined,
			editFuzzy: context.options?.editFuzzy as boolean | "auto" | undefined,
			editFuzzyThreshold: context.options?.editFuzzyThreshold as number | "auto" | undefined,
			shared: this.#sharedInfra ?? undefined,
		};

		const startTime = Date.now();
		const client = this.#clientFactory ? this.#clientFactory(clientOptions) : new InProcessClient(clientOptions);

		let sessionStats: {
			tokens: {
				input: number;
				output: number;
				reasoning?: number;
				cacheRead?: number;
				cacheWrite?: number;
				total: number;
			};
			assistantMessages: number;
		} | null = null;
		let lastAssistantText: string | null = null;
		let trialError: string | null = null;

		try {
			await client.start();
			if (instruction) {
				await client.prompt(instruction);
			}
			sessionStats = await client.getSessionStats().catch(() => null);
			lastAssistantText = await client.getLastAssistantText().catch(() => null);
		} catch (err) {
			trialError = errorMessage(err);
		} finally {
			await client.dispose().catch(() => {});
		}

		const durationSec = (Date.now() - startTime) / 1000;
		const actualFiles = await listFiles(trialDir).catch(() => []);
		const fileMap: Record<string, string> = {};
		for (const file of actualFiles) {
			fileMap[file] = await fs.readFile(path.join(trialDir, file), "utf-8").catch(() => "");
		}

		const usage: TrialUsage = sessionStats
			? {
					inputTokens: sessionStats.tokens.input,
					outputTokens: sessionStats.tokens.output,
					cacheTokens: (sessionStats.tokens.cacheRead ?? 0) + (sessionStats.tokens.cacheWrite ?? 0),
					cacheReadTokens: sessionStats.tokens.cacheRead ?? null,
					cacheWriteTokens: sessionStats.tokens.cacheWrite ?? null,
					durationSec,
				}
			: { durationSec };

		return {
			trialDir,
			logPaths: [],
			rawOutput: lastAssistantText,
			files: fileMap,
			extra: {
				cell,
				trialDir,
				durationSec,
				sessionStats,
				usage,
				error: trialError,
			},
		};
	}

	async cleanup(cell: TrialCell, context: RunContext): Promise<void> {
		if (context.options?.cleanup === true) {
			const variantSegment = (cell.variant || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
			const taskSegment = cell.task.replace(/[^a-zA-Z0-9._-]/g, "_");
			const runsDir = context.runsDir || defaultRunsDir();
			const trialDir = path.join(
				runsDir,
				context.runId || "in-process-run",
				variantSegment,
				taskSegment,
				`repeat-${cell.repeat ?? 0}`,
			);
			await fs.rm(trialDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

export const inProcessBackend = new InProcessBackend();

/**
 * Registers the in-process execution backend in the backend registry.
 * Idempotent: safe to call multiple times.
 */
export function registerInProcessBackend(registry?: BackendRegistry): void {
	const target = registry ?? defaultBackendRegistry;
	if (!target.has(inProcessBackend.id)) {
		target.register(inProcessBackend);
	}
}

// Auto-register on module load
registerInProcessBackend();
