import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ImageContent, ToolExample } from "@veyyon/ai";
import { errorMessage, formatCount, logger } from "@veyyon/utils";
import type { ExecutorBackendResult } from "../eval/backend";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../eval/bridge-timeout";
import { IdleTimeout } from "../eval/idle-timeout";
import { defaultEvalSessionId } from "../eval/session-id";
import { upsertStatusEvent } from "../eval/status-events";
import type { EvalCellResult, EvalDisplayOutput, EvalLanguage, EvalStatusEvent, EvalToolDetails } from "../eval/types";
import { formatExitCodeNotice } from "../exec/exit-notice";
import {
	countNewlines,
	DEFAULT_MAX_BYTES,
	OutputSink,
	type OutputSummary,
	TailBuffer,
} from "../session/streaming-output";
import { discoverAgents } from "../task/discovery";
import { type EnabledSubagentCatalog, resolveEnabledSubagents } from "../task/subagent-settings";
import type { AgentDefinition } from "../task/types";
import { webpExclusionForModel } from "../utils/image-loading";
import { formatDimensionNote, resizeImage } from "../utils/image-resize";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { resolveEvalBackends } from "./eval-backends";
import type {
	EvalLanguageToken,
	EvalProxyExecutor,
	EvalToolOptions,
	EvalToolParams,
	ResolvedEvalCell,
} from "./eval-helpers";
import {
	buildEvalSchema,
	describeEvalCell,
	detailsNotice,
	EVAL_LANGUAGE_ORDER,
	enabledEvalLanguages,
	evalSchema,
	formatDisplayOutputsForText,
	formatEvalInputLanguage,
	getEvalToolDescription,
	resolveBackend,
	summarizeEvalLanguages,
} from "./eval-helpers";
import { inlineBudgetFor } from "./output-artifact";
import { foldToolOutputBookkeeping } from "./output-fold";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "./output-meta";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";

export { formatDisplayJsonForText } from "./eval-helpers";
export { evalSchema, getEvalToolDescription };

export class EvalTool implements AgentTool<typeof evalSchema> {
	readonly name = "eval";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<EvalToolParams>;
		const language =
			typeof params.language === "string" ? formatEvalInputLanguage(params.language) : "javascript (default)";
		const code = typeof params.code === "string" ? params.code : "";
		return [`Language: ${language}`, `Code:\n${truncateForPrompt(code)}`];
	};
	get summary(): string {
		return summarizeEvalLanguages(this.#enabledLanguages());
	}
	readonly loadMode = "essential";
	readonly label = "Eval";
	get description(): string {
		if (!this.session) return getEvalToolDescription();
		const backends = resolveEvalBackends(this.session);
		const catalog = this.#enabledSubagents();
		return getEvalToolDescription({
			py: backends.python,
			js: backends.js,
			rb: backends.ruby,
			jl: backends.julia,
			effectiveAgents: catalog.agents.map(agent => agent.name),
			effectiveDefaultAgent: catalog.defaultAgent,
		});
	}
	static readonly #ALL_EXAMPLES: readonly ToolExample<typeof evalSchema.infer>[] = [
		{
			caption: "First call — set up once",
			call: {
				language: "py",
				title: "imports",
				code: "import json\nfrom pathlib import Path",
			},
		},
		{
			caption: "Second call — reuse, do NOT re-import",
			call: {
				language: "py",
				title: "load config",
				code: "data = json.loads(read('package.json'))\ndisplay(data)",
			},
		},
		{
			caption: "Ruby first call — set up once",
			call: {
				language: "rb",
				title: "setup",
				code: "require 'json'\npkg_path = 'package.json'",
			},
		},
		{
			caption: "Ruby second call — reuse, do NOT re-require",
			call: {
				language: "rb",
				title: "load config",
				code: "pkg = JSON.parse(read(pkg_path))\ndisplay(pkg.keys.sort)",
			},
		},
	];
	get examples(): readonly ToolExample<typeof evalSchema.infer>[] {
		const langs = new Set(this.#enabledLanguages());
		return EvalTool.#ALL_EXAMPLES.filter(ex => "call" in ex && langs.has(ex.call.language as EvalLanguageToken));
	}
	get parameters(): typeof evalSchema {
		const langs = this.#enabledLanguages();
		if (langs.length === 0 || langs.length === EVAL_LANGUAGE_ORDER.length) return evalSchema;
		const key = langs.join(",");
		if (this.#paramsKey !== key) {
			this.#cachedParams = buildEvalSchema(langs);
			this.#paramsKey = key;
		}
		return this.#cachedParams ?? evalSchema;
	}
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly intent = (args: Partial<typeof evalSchema.infer>): string | undefined => {
		const title = typeof args.title === "string" ? args.title : undefined;
		const language = typeof args.language === "string" ? formatEvalInputLanguage(args.language) : "javascript";
		return title || `running ${language}`;
	};

	readonly #proxyExecutor?: EvalProxyExecutor;
	readonly #discoveredAgents: readonly AgentDefinition[];

	#paramsKey?: string;
	#cachedParams?: typeof evalSchema;

	#enabledLanguages(): EvalLanguageToken[] {
		return this.session ? enabledEvalLanguages(resolveEvalBackends(this.session)) : ["py", "js"];
	}

	#enabledSubagents(): EnabledSubagentCatalog {
		if (!this.session) {
			throw new ToolError("Eval tool requires a session to resolve enabled subagents");
		}
		return resolveEnabledSubagents({
			settings: this.session.settings,
			agents: this.#discoveredAgents,
			parentSpawns: this.session.getSessionSpawns?.() ?? "*",
		});
	}

	constructor(
		private readonly session: ToolSession | null,
		options?: EvalToolOptions,
	) {
		this.#proxyExecutor = options?.proxyExecutor;
		this.#discoveredAgents = options?.discoveredAgents ?? [];
	}

	static async create(session: ToolSession): Promise<EvalTool> {
		const { agents } = await discoverAgents(session.cwd);
		return new EvalTool(session, { discoveredAgents: agents });
	}

	async execute(
		_toolCallId: string,
		params: typeof evalSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		if (this.#proxyExecutor) {
			return this.#proxyExecutor(params, signal);
		}

		if (!this.session) {
			throw new ToolError("Eval tool requires a session when not using proxy executor");
		}
		const session = this.session;
		const excludeWebP = webpExclusionForModel(session.getActiveModel?.());

		const cellLanguage: EvalLanguage =
			params.language === "py"
				? "python"
				: params.language === "rb"
					? "ruby"
					: params.language === "jl"
						? "julia"
						: "js";
		const resolved = await resolveBackend(session, cellLanguage);
		const cell: ResolvedEvalCell = {
			index: 0,
			title: params.title,
			code: params.code,
			timeoutMs: (params.timeout ?? TOOL_TIMEOUTS.eval.default) * 1000,
			reset: params.reset ?? false,
			resolved,
		};
		const languages: EvalLanguage[] = [cell.resolved.backend.id];
		const notice = detailsNotice(cell, session.settings.get("tools.maxTimeout"));
		const sessionAbortController = new AbortController();
		let outputSink: OutputSink | undefined;
		let outputSummary: OutputSummary | undefined;
		let outputDumped = false;
		const finalizeOutput = async (): Promise<OutputSummary | undefined> => {
			if (outputDumped || !outputSink) return outputSummary;
			outputSummary = await outputSink.dump();
			outputDumped = true;
			return outputSummary;
		};

		const execution = (async (): Promise<AgentToolResult<EvalToolDetails | undefined>> => {
			try {
				if (signal?.aborted) {
					throw new ToolAbortError();
				}
				session.assertEvalExecutionAllowed?.();

				const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES * 2);
				const jsonOutputs: unknown[] = [];
				const images: ImageContent[] = [];
				const statusEvents: EvalStatusEvent[] = [];

				const cellResult: EvalCellResult = {
					index: cell.index,
					title: cell.title,
					code: cell.code,
					language: cell.resolved.backend.id,
					output: "",
					status: "pending",
				};
				let foldedOutput = "";
				let activeLiveCell: { result: EvalCellResult; buf: TailBuffer } | undefined;

				const appendTail = (text: string) => {
					tailBuffer.append(text);
				};

				const buildUpdateDetails = (): EvalToolDetails => {
					const details: EvalToolDetails = {
						language: languages[0],
						languages,
						cells: [
							{
								...cellResult,
								statusEvents: cellResult.statusEvents ? cellResult.statusEvents.slice() : undefined,
							},
						],
					};
					if (jsonOutputs.length > 0) {
						details.jsonOutputs = jsonOutputs;
					}
					if (images.length > 0) {
						details.images = images;
					}
					if (statusEvents.length > 0) {
						details.statusEvents = statusEvents;
					}
					if (notice) {
						details.notice = notice;
					}
					return details;
				};

				const pushUpdate = () => {
					if (!onUpdate) return;
					const tailText = tailBuffer.text();
					onUpdate({
						content: [{ type: "text", text: tailText }],
						details: buildUpdateDetails(),
					});
				};

				const sessionFile = session.getSessionFile?.() ?? undefined;
				const kernelOwnerId = session.getEvalKernelOwnerId?.() ?? undefined;
				const { path: artifactPath, id: artifactId } = (await session.allocateOutputArtifact?.("eval")) ?? {};
				session.assertEvalExecutionAllowed?.();
				outputSink = new OutputSink({
					artifactPath,
					artifactId,
					spillThreshold: inlineBudgetFor(session),
					headBytes: resolveOutputSinkHeadBytes(session.settings),
					maxColumns: resolveOutputMaxColumns(session.settings),
					onChunk: chunk => {
						appendTail(chunk);
						if (activeLiveCell) {
							activeLiveCell.buf.append(chunk);
							activeLiveCell.result.output = activeLiveCell.buf.text();
						}
						pushUpdate();
					},
				});
				const sessionId = session.getEvalSessionId?.() ?? defaultEvalSessionId(session);

				const backend = cell.resolved.backend;
				const idleTimeoutMs =
					cell.timeoutMs === 0
						? undefined
						: clampTimeout("eval", cell.timeoutMs / 1000, session.settings.get("tools.maxTimeout")) * 1000;
				const idle = idleTimeoutMs === undefined ? undefined : new IdleTimeout(idleTimeoutMs);
				const combinedSignal =
					signal && idle
						? AbortSignal.any([signal, idle.signal, sessionAbortController.signal])
						: signal
							? AbortSignal.any([signal, sessionAbortController.signal])
							: idle
								? AbortSignal.any([idle.signal, sessionAbortController.signal])
								: sessionAbortController.signal;

				cellResult.status = "running";
				cellResult.output = "";
				cellResult.statusEvents = undefined;
				cellResult.exitCode = undefined;
				cellResult.durationMs = undefined;
				const liveOutput = new TailBuffer(DEFAULT_MAX_BYTES * 2);
				activeLiveCell = { result: cellResult, buf: liveOutput };
				pushUpdate();

				const startTime = Date.now();
				let result: ExecutorBackendResult;
				try {
					result = await backend.execute(cell.code, {
						cwd: session.cwd,
						sessionId,
						sessionFile: sessionFile ?? undefined,
						kernelOwnerId,
						signal: combinedSignal,
						session,
						idleTimeoutMs,
						reset: cell.reset,
						onChunk: chunk => {
							outputSink!.push(chunk);
						},
						onStatus: event => {
							if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
								idle?.pause();
								return;
							}
							if (event.op === EVAL_TIMEOUT_RESUME_OP) {
								idle?.resume();
								return;
							}
							cellResult.statusEvents ??= [];
							upsertStatusEvent(cellResult.statusEvents, event);
							pushUpdate();
						},
					});
				} finally {
					idle?.dispose();
					activeLiveCell = undefined;
				}
				const durationMs = Date.now() - startTime;

				const cellStatusEvents: EvalStatusEvent[] = [];
				const cellDisplayOutputs: EvalDisplayOutput[] = [];
				const cellImageNotes: string[] = [];
				let cellHasMarkdown = false;
				for (const output of result.displayOutputs) {
					if (output.type === "json") {
						jsonOutputs.push(output.data);
						cellDisplayOutputs.push(output);
					}
					if (output.type === "image") {
						const resized = await resizeImage(
							{
								type: "image",
								data: output.data,
								mimeType: output.mimeType,
							},
							{ excludeWebP },
						);
						const image: ImageContent = {
							type: "image",
							data: resized.data,
							mimeType: resized.mimeType,
						};
						images.push(image);
						cellDisplayOutputs.push({
							type: "image",
							data: image.data,
							mimeType: image.mimeType,
						});
						const dimensionNote = formatDimensionNote(resized);
						if (dimensionNote) {
							cellImageNotes.push(`display image ${cellImageNotes.length + 1}: ${dimensionNote}`);
						}
					}
					if (output.type === "status") {
						upsertStatusEvent(statusEvents, output.event);
						upsertStatusEvent(cellStatusEvents, output.event);
					}
					if (output.type === "markdown") {
						cellHasMarkdown = true;
					}
				}

				const stdoutTrimmed = result.output.trim();
				const imageText = cellImageNotes.join("\n");
				const displayText = formatDisplayOutputsForText(cellDisplayOutputs);
				const visibleDisplayText =
					displayText && imageText ? `${displayText}\n\n${imageText}` : displayText || imageText;
				const cellOutput =
					stdoutTrimmed && visibleDisplayText
						? `${stdoutTrimmed}\n\n${visibleDisplayText}`
						: stdoutTrimmed || visibleDisplayText;
				cellResult.output = cellOutput;
				cellResult.exitCode = result.exitCode;
				cellResult.durationMs = durationMs;
				cellResult.statusEvents = cellStatusEvents.length > 0 ? cellStatusEvents : undefined;
				cellResult.hasMarkdown = cellHasMarkdown || undefined;

				if (cellOutput) {
					foldedOutput = foldToolOutputBookkeeping(cellOutput).text;
					appendTail(foldedOutput);
				}

				if (result.cancelled) {
					cellResult.status = "error";
					pushUpdate();
					if (signal?.aborted || sessionAbortController.signal.aborted) {
						await finalizeOutput();
						const partial = (result.output || liveOutput.text()).trim();
						throw new ToolAbortError(
							[
								`Eval cancelled: ${describeEvalCell(cell)} started and did NOT finish`,
								"any state it had already mutated is still in the kernel",
								partial ? `output so far:\n${partial}` : "it produced no output before the cancellation",
							].join("; "),
							{ cause: signal?.reason ?? sessionAbortController.signal.reason },
						);
					}

					const errorMsg = result.output || "Command aborted";
					const outputText = foldedOutput || errorMsg;

					const summaryForMeta = await summarizeFinal(foldedOutput, finalizeOutput);
					const details: EvalToolDetails = {
						language: languages[0],
						languages,
						cells: [cellResult],
						jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
						statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
						isError: true,
					};
					if (notice) details.notice = notice;

					return toolResult(details)
						.content([{ type: "text", text: outputText }, ...images])
						.truncationFromSummary(summaryForMeta, { direction: "tail" })
						.done();
				}

				if (result.exitCode !== 0 && result.exitCode !== undefined) {
					cellResult.status = "error";
					pushUpdate();
					const outputText = foldedOutput
						? `${foldedOutput}\n\n${formatExitCodeNotice(result.exitCode)}`
						: formatExitCodeNotice(result.exitCode);

					const summaryForMeta = await summarizeFinal(foldedOutput, finalizeOutput);
					const details: EvalToolDetails = {
						language: languages[0],
						languages,
						cells: [cellResult],
						jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
						statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
						isError: true,
					};
					if (notice) details.notice = notice;

					return toolResult(details)
						.content([{ type: "text", text: outputText }, ...images])
						.truncationFromSummary(summaryForMeta, { direction: "tail" })
						.done();
				}

				cellResult.status = "complete";
				pushUpdate();

				const hasImages = images.length > 0;
				const outputText =
					foldedOutput ||
					(hasImages ? `(displayed ${formatCount("image", images.length)}; no text output)` : "(no output)");
				const summaryForMeta = await summarizeFinal(foldedOutput, finalizeOutput);

				const details: EvalToolDetails = {
					language: languages[0],
					languages,
					cells: [cellResult],
					jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
					statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
				};
				if (notice) details.notice = notice;

				return toolResult(details)
					.content([{ type: "text", text: outputText }, ...images])
					.truncationFromSummary(summaryForMeta, { direction: "tail" })
					.done();
			} finally {
				if (!outputDumped) {
					try {
						await finalizeOutput();
					} catch (error) {
						logger.warn("Eval output could not be written to its overflow sink; the full output is lost", {
							error: errorMessage(error),
						});
					}
				}
			}
		})();

		return await (session.trackEvalExecution?.(execution, sessionAbortController) ?? execution);
	}
}

async function summarizeFinal(
	cellOutput: string,
	finalizeOutput: () => Promise<OutputSummary | undefined>,
): Promise<OutputSummary> {
	const rawSummary = (await finalizeOutput()) ?? {
		output: "",
		truncated: false,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
	};
	const outputLines = cellOutput.length > 0 ? countNewlines(cellOutput) + 1 : 0;
	const outputBytes = Buffer.byteLength(cellOutput, "utf-8");
	const missingLines = Math.max(0, rawSummary.totalLines - rawSummary.outputLines);
	const missingBytes = Math.max(0, rawSummary.totalBytes - rawSummary.outputBytes);
	return {
		output: cellOutput,
		truncated: rawSummary.truncated,
		totalLines: outputLines + missingLines,
		totalBytes: outputBytes + missingBytes,
		outputLines,
		outputBytes,
		artifactId: rawSummary.artifactId,
	};
}
