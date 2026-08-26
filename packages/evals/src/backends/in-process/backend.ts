import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Settings } from "@veyyon/coding-agent";
import { clamp, errorMessage } from "@veyyon/utils";
import { type BackendRegistry, defaultBackendRegistry } from "../../core/backend-registry";
import { resolveCellVariant } from "../../core/cell-variant";
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

export const DEFAULT_TRIAL_TIMEOUT_SEC = 1800;
export const HARD_CEILING_TRIAL_TIMEOUT_SEC = 7200;
export const RAW_OUTPUT_TAIL_CAP_BYTES = 64 * 1024;

/**
 * Returns a bounded tail of rawOutput up to capBytes (defaults to 64 KiB).
 */
export function capRawOutputTail(text: string | null | undefined, capBytes = RAW_OUTPUT_TAIL_CAP_BYTES): string | null {
	if (!text) return null;
	const buf = Buffer.from(text, "utf-8");
	if (buf.byteLength <= capBytes) return text;
	return buf.subarray(buf.byteLength - capBytes).toString("utf-8");
}

export type InProcessClientFactory = (options: InProcessClientOptions) => InProcessClientLike;

export interface InProcessBackendOptions {
	readonly shared?: SharedInfra;
	readonly clientFactory?: InProcessClientFactory;
}

export class InProcessBackend implements ExecutionBackend {
	readonly id: BackendId = "in-process";
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

		const variant = resolveCellVariant(cell, context);
		const model =
			variant.model ||
			(context.options?.model as string | undefined) ||
			(context.options?.defaultModel as string | undefined) ||
			"anthropic/claude-sonnet-4-6";

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

		const baseBudget = descriptor.timeBudgetSec > 0 ? descriptor.timeBudgetSec : DEFAULT_TRIAL_TIMEOUT_SEC;
		const overrideTimeout =
			typeof context.options?.trialTimeout === "number" && context.options.trialTimeout > 0
				? context.options.trialTimeout
				: typeof context.options?.trialTimeoutSec === "number" && context.options.trialTimeoutSec > 0
					? context.options.trialTimeoutSec
					: undefined;
		const multiplier =
			typeof context.options?.timeoutMultiplier === "number" && context.options.timeoutMultiplier > 0
				? context.options.timeoutMultiplier
				: 1;
		const rawBudget = (overrideTimeout ?? baseBudget) * multiplier;
		const timeoutSec = clamp(rawBudget, 1, HARD_CEILING_TRIAL_TIMEOUT_SEC);

		let sessionStats: InProcessSessionStats | null = null;
		let lastAssistantText: string | null = null;
		let trialError: string | null = null;
		let state: InProcessSessionState | undefined;
		let timedOut = false;
		let timeoutTimer: NodeJS.Timeout | undefined;
		const timeoutAbort = new AbortController();

		const { promise: deadlinePromise, reject: rejectDeadline } = Promise.withResolvers<never>();
		timeoutTimer = setTimeout(() => {
			timedOut = true;
			timeoutAbort.abort();
			try {
				client.abort?.();
			} catch {}
			rejectDeadline(new Error(`Trial exceeded deadline of ${timeoutSec}s (time budget exceeded)`));
		}, timeoutSec * 1000);

		if (context.signal) {
			if (context.signal.aborted) {
				timeoutAbort.abort();
				try {
					client.abort?.();
				} catch {}
				rejectDeadline(new Error("Trial aborted by context signal"));
			} else {
				context.signal.addEventListener(
					"abort",
					() => {
						timeoutAbort.abort();
						try {
							client.abort?.();
						} catch {}
						rejectDeadline(new Error("Trial aborted by context signal"));
					},
					{ once: true },
				);
			}
		}

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
			await client.dispose().catch(() => {});
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
			rawOutput: capRawOutputTail(lastAssistantText),
			filePaths: filePathsMap,
			usage,
			extra: {
				cell,
				variant: cell.variant,
				trialDir,
				durationSec,
				sessionStats,
				error: trialError,
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
