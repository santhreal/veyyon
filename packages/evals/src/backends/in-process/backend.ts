import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Settings } from "@veyyon/coding-agent";
import { errorMessage } from "@veyyon/utils";
import { type BackendRegistry, defaultBackendRegistry } from "../../core/backend-registry";
import { resolveCellVariant } from "../../core/cell-variant";
import { listFiles } from "../../core/fs-walk";
import { requireHarness } from "../../core/harness-registry";
import {
	boundRawOutput,
	teardownGraceFromOptions,
	teardownWithin,
	trialTimeoutFromOptions,
} from "../../core/trial-deadline";
import { resolveTrialModel } from "../../core/trial-model";
import { trialDirFor } from "../../core/trial-naming";
import type {
	BackendId,
	ExecutionBackend,
	PreflightVerdict,
	RunContext,
	TrialArtifacts,
	TrialCell,
	TrialUsage,
	VariantAxis,
} from "../../core/types";
import { runsDir as defaultRunsDir } from "../../paths";
import {
	type DiscoverSharedInfraOptions,
	discoverSharedInfra,
	InProcessClient,
	type InProcessClientOptions,
	type InProcessSessionState,
	type SharedInfra,
} from "./client";
import { loadAndValidateConfigOverlay, loadAndValidatePromptOverlay } from "./overlays";

export interface InProcessSessionStats {
	tokens: {
		input: number;
		output: number;
		reasoning?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total: number;
	};
	assistantMessages: number;
	/** Provider spend the session accumulated; 0 when the model carries no pricing. */
	cost: number;
}

export interface InProcessClientLike {
	start(): Promise<void>;
	prompt(text: string): Promise<void>;
	getSessionStats(): Promise<InProcessSessionStats>;
	getLastAssistantText(): Promise<string | null>;
	getSettings?(): Promise<Settings | undefined>;
	getState?(): Promise<InProcessSessionState>;
	abort?(): void;
	dispose(): Promise<void>;
}

export type InProcessClientFactory = (options: InProcessClientOptions) => InProcessClientLike;

export interface InProcessBackendOptions {
	readonly shared?: SharedInfra;
	readonly clientFactory?: InProcessClientFactory;
}

export class InProcessBackend implements ExecutionBackend {
	readonly id: BackendId = "in-process";
	/** A settings overlay and a prompt overlay are both read below; attachments are not. */
	readonly appliesVariantAxes: readonly VariantAxis[] = ["config", "promptVariant"];
	#sharedInfra: SharedInfra | null = null;
	readonly #clientFactory: InProcessClientFactory | undefined;

	constructor(options: InProcessBackendOptions = {}) {
		this.#sharedInfra = options.shared ?? null;
		this.#clientFactory = options.clientFactory;
	}

	async preflight(context: RunContext): Promise<PreflightVerdict> {
		const variants = context.options?.variants ?? [];
		if (variants.length > 0) {
			for (const variant of variants) {
				if (variant.configPath) {
					try {
						await loadAndValidateConfigOverlay(variant.configPath, context.workDir);
					} catch (error) {
						return {
							ok: false,
							reason: errorMessage(error),
							missingRequirements: ["valid-config-overlay"],
						};
					}
				}
				if (variant.promptVariantPath) {
					try {
						await loadAndValidatePromptOverlay(variant.promptVariantPath, context.workDir);
					} catch (error) {
						return {
							ok: false,
							reason: errorMessage(error),
							missingRequirements: ["valid-prompt-overlay"],
						};
					}
				}
			}
		}

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
		const trialDir = trialDirFor(runsDir, context.runId, cell);
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

		const variant = resolveCellVariant(cell, context);
		const harness = requireHarness(variant.harness);
		const model = resolveTrialModel(variant, harness, context).id;

		const configPath = variant.configPath ?? (context.options?.configPath as string | undefined) ?? null;
		const promptVariantPath =
			variant.promptVariantPath ?? (context.options?.promptVariantPath as string | undefined) ?? null;

		let resolvedConfigPath: string | undefined;
		if (configPath) {
			const loaded = await loadAndValidateConfigOverlay(configPath, context.workDir);
			resolvedConfigPath = loaded.resolvedPath;
		}

		let promptOverrides: Record<string, string> | undefined;
		if (promptVariantPath) {
			const loaded = await loadAndValidatePromptOverlay(promptVariantPath, context.workDir);
			promptOverrides = loaded.overrides;
		}

		const clientOptions: InProcessClientOptions = {
			cwd: trialDir,
			model,
			appendSystemPrompt: context.options?.appendSystemPrompt as string | undefined,
			tools: (context.options?.tools as string[] | undefined) ?? ["read", "edit", "write"],
			editVariant: context.options?.editVariant as string | undefined,
			editFuzzy: context.options?.editFuzzy as boolean | "auto" | undefined,
			editFuzzyThreshold: context.options?.editFuzzyThreshold as number | "auto" | undefined,
			shared: this.#sharedInfra ?? undefined,
			configPath: resolvedConfigPath,
			promptOverrides,
		};

		const startTime = Date.now();
		const client = this.#clientFactory ? this.#clientFactory(clientOptions) : new InProcessClient(clientOptions);

		const timeoutSec = trialTimeoutFromOptions(descriptor.timeBudgetSec, context.options);

		let sessionStats: InProcessSessionStats | null = null;
		let lastAssistantText: string | null = null;
		let trialError: string | null = null;
		let state: InProcessSessionState | undefined;
		let timedOut = false;
		let teardownReason: string | null = null;
		const timeoutAbort = new AbortController();

		const { promise: deadlinePromise, reject: rejectDeadline } = Promise.withResolvers<never>();
		const interrupt = (reason: string): void => {
			timeoutAbort.abort();
			try {
				client.abort?.();
			} catch {}
			rejectDeadline(new Error(reason));
		};
		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			interrupt(`Trial exceeded deadline of ${timeoutSec}s (time budget exceeded)`);
		}, timeoutSec * 1000);

		// One run's signal outlives every trial in it, so a listener this trial leaves behind holds
		// this trial's client and session state for the rest of the run.
		const onCancel = (): void => interrupt("Trial aborted by context signal");
		context.signal?.addEventListener("abort", onCancel, { once: true });
		if (context.signal?.aborted) onCancel();

		const runClient = async (): Promise<{
			stats: InProcessSessionStats | null;
			text: string | null;
			sessionState: InProcessSessionState | undefined;
		}> => {
			await client.start();
			if (typeof client.getState === "function") {
				state = await client.getState();
			}
			if (instruction) {
				await client.prompt(instruction);
			}
			const stats = await client.getSessionStats().catch(() => null);
			const text = await client.getLastAssistantText().catch(() => null);
			return { stats, text, sessionState: state };
		};

		try {
			const result = await Promise.race([runClient(), deadlinePromise]);
			sessionStats = result.stats;
			lastAssistantText = result.text;
			state = result.sessionState;
		} catch (err) {
			trialError = errorMessage(err);
		} finally {
			clearTimeout(timeoutTimer);
			context.signal?.removeEventListener("abort", onCancel);
			// The trial's deadline bounds the trial; this bounds what comes after it, so a client
			// that never finishes disposing cannot hold the worker that already scored this trial.
			teardownReason = await teardownWithin(() => client.dispose(), teardownGraceFromOptions(context.options));
		}

		const durationSec = (Date.now() - startTime) / 1000;
		const actualFiles = await listFiles(trialDir).catch(() => []);
		const filePathsMap: Record<string, string> = {};
		for (const file of actualFiles) {
			filePathsMap[file] = path.join(trialDir, file);
		}

		const usage: TrialUsage = sessionStats
			? {
					inputTokens: sessionStats.tokens.input,
					outputTokens: sessionStats.tokens.output,
					cacheTokens: (sessionStats.tokens.cacheRead ?? 0) + (sessionStats.tokens.cacheWrite ?? 0),
					cacheReadTokens: sessionStats.tokens.cacheRead ?? null,
					cacheWriteTokens: sessionStats.tokens.cacheWrite ?? null,
					// A provider with no pricing metadata reports 0, which is not a $0 trial:
					// report it absent so a run's spend never reads as free when it is unknown.
					costUsd: sessionStats.cost > 0 ? sessionStats.cost : null,
					durationSec,
				}
			: { durationSec };

		return {
			trialDir,
			logPaths: [],
			rawOutput: boundRawOutput(lastAssistantText),
			filePaths: filePathsMap,
			usage,
			extra: {
				cell,
				variant: cell.variant,
				trialDir,
				durationSec,
				sessionStats,
				error: trialError,
				// A teardown that was abandoned is reported beside the score it could not affect.
				teardownReason,
				timedOut,
				infrastructureError: timedOut ? trialError : undefined,
				timeoutSec,
				systemPrompt: state?.systemPrompt,
				settings: state?.settings,
			},
		};
	}

	async cleanup(cell: TrialCell, context: RunContext): Promise<void> {
		if (context.options?.cleanup === true) {
			const runsDir = context.runsDir || defaultRunsDir();
			const trialDir = trialDirFor(runsDir, context.runId, cell);
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
