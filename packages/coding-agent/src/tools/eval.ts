import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ImageContent, ToolExample } from "@veyyon/ai";
import { errorMessage, formatCount, logger, prompt } from "@veyyon/utils";
import { type } from "arktype";
import { jsBackend, juliaBackend, pythonBackend, rubyBackend } from "../eval";
import type { ExecutorBackend, ExecutorBackendResult } from "../eval/backend";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../eval/bridge-timeout";
import { IdleTimeout } from "../eval/idle-timeout";
import { defaultEvalSessionId } from "../eval/session-id";
import { upsertStatusEvent } from "../eval/status-events";
import type { EvalCellResult, EvalDisplayOutput, EvalLanguage, EvalStatusEvent, EvalToolDetails } from "../eval/types";
import { formatExitCodeNotice } from "../exec/exit-notice";
import { toolsPrompts } from "../prompts/tools/rows";
import { DEFAULT_MAX_BYTES, OutputSink, type OutputSummary, TailBuffer } from "../session/streaming-output";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import { webpExclusionForModel } from "../utils/image-loading";
import { formatDimensionNote, resizeImage } from "../utils/image-resize";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { type EvalBackendsAllowance, resolveEvalBackends } from "./eval-backends";
import { inlineBudgetFor } from "./output-artifact";
import { foldToolOutputBookkeeping } from "./output-fold";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "./output-meta";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, describeTimeoutParam, formatTimeoutClampNotice, TOOL_TIMEOUTS } from "./tool-timeouts";

/** Language tokens the eval tool accepts, in stable display order. */
export type EvalLanguageToken = "py" | "js" | "rb" | "jl";
const EVAL_LANGUAGE_ORDER: readonly EvalLanguageToken[] = ["py", "js", "rb", "jl"];
const EVAL_LANGUAGE_RUNTIME: Record<EvalLanguageToken, string> = {
	py: '"py" for the IPython kernel',
	js: '"js" for the persistent JS VM',
	rb: '"rb" for the persistent Ruby kernel',
	jl: '"jl" for the persistent Julia kernel',
};
const EVAL_LANGUAGE_NAME: Record<EvalLanguageToken, string> = {
	py: "Python",
	js: "JavaScript",
	rb: "Ruby",
	jl: "Julia",
};

/** Join names as an English "or" list: ["A"]→"A", ["A","B"]→"A or B", 3+→"A, B, or C". */
function joinWithOr(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} or ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

function describeLanguageField(langs: readonly EvalLanguageToken[]): string {
	return `runtime: ${langs.map(lang => EVAL_LANGUAGE_RUNTIME[lang]).join(", ")}`;
}

function describeCodeField(langs: readonly EvalLanguageToken[]): string {
	const replLangs = langs.filter(lang => lang === "rb" || lang === "jl");
	// No persistent REPL backends → keep the original py/js phrasing verbatim so the
	// default (rb/jl off) wire schema stays byte-identical to the pre-feature one.
	if (replLangs.length === 0) return "code to run in this eval call, verbatim. Use top-level await freely.";
	const awaitLangs = langs.filter(lang => lang === "py" || lang === "js");
	const clauses: string[] = [];
	if (awaitLangs.length > 0) clauses.push(`Top-level \`await\` is available in ${awaitLangs.join("/")}`);
	clauses.push(`${replLangs.join("/")} auto-display the last expression like a REPL`);
	return `code to run in this eval call, verbatim. ${clauses.join("; ")}.`;
}

/** One-line discovery summary listing the runtimes available this session. */
function summarizeEvalLanguages(langs: readonly EvalLanguageToken[]): string {
	const names = langs.map(lang => EVAL_LANGUAGE_NAME[lang]);
	const list = names.length > 0 ? joinWithOr(names) : "Python or JavaScript";
	// "in-process" matches the historical py/js summary; persistent kernels (rb/jl) switch wording.
	const backend = langs.some(lang => lang === "rb" || lang === "jl") ? "a persistent" : "an in-process";
	return `Execute ${list} code in ${backend} eval backend`;
}

/** Resolved-allowance → enabled language tokens, preserving display order. */
function enabledEvalLanguages(backends: EvalBackendsAllowance): EvalLanguageToken[] {
	const allowed: Record<EvalLanguageToken, boolean> = {
		py: backends.python,
		js: backends.js,
		rb: backends.ruby,
		jl: backends.julia,
	};
	return EVAL_LANGUAGE_ORDER.filter(lang => allowed[lang]);
}

const evalCellCommonFields = {
	"title?": type("string").describe('short label shown in transcript (e.g. "imports", "load config")'),
	"timeout?": type("number").describe(describeTimeoutParam("eval", { zeroDisablesNoun: "cell timeout" })),
	"reset?": type("boolean").describe("wipe this language's kernel before running. Other languages are untouched."),
};

/**
 * Per-call input: a single cell. State persists within a language across
 * separate eval calls and across tool calls, so each call is one logical step
 * and later calls reuse what earlier ones defined. This static schema carries
 * the full language union for typing; {@link buildEvalSchema} narrows the wire
 * copy per session so disabled backends are never advertised to the model.
 */
export const evalSchema = type({
	language: type("'py' | 'js' | 'rb' | 'jl'").describe(describeLanguageField(EVAL_LANGUAGE_ORDER)),
	...evalCellCommonFields,
	code: type("string").describe(describeCodeField(EVAL_LANGUAGE_ORDER)),
});
export type EvalToolParams = typeof evalSchema.infer;
export type EvalCellInput = EvalToolParams;

/**
 * Build a session-scoped copy of the eval schema whose `language` enum and field
 * descriptions advertise only the runtimes enabled for this session. Disabled
 * backends never reach the model: the wire schema, BM25 discovery corpus, and
 * tool description stay in lockstep with {@link resolveEvalBackends}. The static
 * {@link evalSchema} (full union) remains the type-level source of truth.
 */
function buildEvalSchema(langs: readonly EvalLanguageToken[]): typeof evalSchema {
	const schema = type({
		language: type.enumerated(...langs).describe(describeLanguageField(langs)),
		code: type("string").describe(describeCodeField(langs)),
		...evalCellCommonFields,
	});
	return schema as unknown as typeof evalSchema;
}

export type EvalToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: EvalToolDetails | undefined;
};

export type EvalProxyExecutor = (params: EvalToolParams, signal?: AbortSignal) => Promise<EvalToolResult>;

/** Cap per `display()` value sent back to the model. */
const MAX_DISPLAY_TEXT_BYTES = 8000;

function formatDisplayJsonForText(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		text = String(value);
	}
	if (text.length > MAX_DISPLAY_TEXT_BYTES) {
		text = `${text.slice(0, MAX_DISPLAY_TEXT_BYTES)}\n[…${text.length - MAX_DISPLAY_TEXT_BYTES}ch elided…]`;
	}
	return text;
}

/**
 * Format display() JSON values into text the model can see. Images are surfaced
 * separately as ImageContent so the model can actually inspect them; this helper
 * intentionally does not touch images.
 */
function formatDisplayOutputsForText(outputs: EvalDisplayOutput[]): string {
	const chunks: string[] = [];
	let displayIndex = 0;
	for (const output of outputs) {
		if (output.type !== "json") continue;
		displayIndex++;
		chunks.push(`display[${displayIndex}]:\n${formatDisplayJsonForText(output.data)}`);
	}
	return chunks.join("\n\n");
}

export interface EvalToolDescriptionOptions {
	py?: boolean;
	js?: boolean;
	rb?: boolean;
	jl?: boolean;
	/**
	 * Parent spawn policy (`getSessionSpawns`). `true`/omitted means unrestricted,
	 * `false`/`""` hides `agent()`, and a comma list drives the advertised default.
	 */
	spawns?: boolean | string | null;
}

export function getEvalToolDescription(options: EvalToolDescriptionOptions = {}): string {
	const py = options.py ?? true;
	const js = options.js ?? true;
	const rb = options.rb ?? false;
	const jl = options.jl ?? false;
	const spawnPolicy = resolveSpawnPolicy(options.spawns ?? true);
	return prompt.render(toolsPrompts["tools/eval"].text, {
		py,
		js,
		rb,
		jl,
		spawns: spawnPolicy.enabled,
		spawnDefaultAgent: spawnPolicy.defaultAgent,
		spawnAllowedAgentsText: spawnPolicy.allowedPromptText,
	});
}

export interface EvalToolOptions {
	proxyExecutor?: EvalProxyExecutor;
}

interface ResolvedBackend {
	backend: ExecutorBackend;
	notice?: string;
}

/**
 * The one cell a call runs, resolved against the session.
 *
 * ONE, not a list, and the singular is load-bearing rather than tidying. The wire
 * schema carries exactly one `language`/`code`/`title`/`timeout`/`reset`, so a
 * call has always been one cell; `execute` nevertheless built a one-element array
 * and looped over it, with per-cell timeout construction, `cellOutputs`
 * accumulation, and helpers that folded several cells into one summary. None of it
 * could run twice, and it was not free: the cancellation path read as though it
 * had a partial-progress story to tell (which cells ran, which did not) when there
 * is only ever one, so a reader reasoning about "the cells after the interrupted
 * one" was reasoning about an unreachable branch.
 *
 * `index` survives at a constant 0 because {@link EvalCellResult} is a wire type:
 * it reaches the renderer and is persisted in transcripts, so its shape is a
 * contract this refactor must not break. `details.cells` is still a one-element
 * array for the same reason.
 */
interface ResolvedEvalCell {
	index: number;
	title?: string;
	code: string;
	timeoutMs: number;
	reset: boolean;
	resolved: ResolvedBackend;
}

/**
 * Name the cell for a cancellation message, so an operator can tell what they
 * interrupted.
 *
 * The title when there is one, since that is the label already shown in the
 * transcript and matching the two is the whole point. Otherwise the language,
 * which at least says which runtime holds the half-mutated state. The code itself
 * is deliberately not included: a cancellation message is read in a hurry, and
 * pasting a cell body into it buries the rest of the sentence, which is the reason
 * the message exists.
 */
function describeEvalCell(cell: ResolvedEvalCell): string {
	return cell.title ?? `the ${cell.resolved.backend.id} cell`;
}

/**
 * The clamp notice for one cell, or `undefined` when its timeout was honored (or
 * disabled). `timeoutMs === 0` disables the deadline entirely (see the run
 * loop), so there is nothing to clamp or report. Surfacing this keeps eval from
 * silently shrinking an over-ceiling request the way bash already reports it.
 */
function timeoutClampNotice(cell: ResolvedEvalCell, maxTimeout?: number): string | undefined {
	if (cell.timeoutMs === 0) return undefined;
	return formatTimeoutClampNotice(
		"eval",
		cell.timeoutMs / 1000,
		clampTimeout("eval", cell.timeoutMs / 1000, maxTimeout),
	);
}

/**
 * The notice line for a call: the backend's own notice and the timeout clamp,
 * whichever of the two the cell produced.
 *
 * Deduplicated even at one cell, because a backend notice and a clamp notice can
 * be the same sentence and reading it twice reads like two separate problems.
 */
function detailsNotice(cell: ResolvedEvalCell, maxTimeout?: number): string | undefined {
	const notices = [
		...new Set([cell.resolved.notice, timeoutClampNotice(cell, maxTimeout)].filter(Boolean) as string[]),
	];
	return notices.length > 0 ? notices.join(" ") : undefined;
}

async function resolveBackend(session: ToolSession, language: EvalLanguage): Promise<ResolvedBackend> {
	const backends = resolveEvalBackends(session);
	const allowPy = backends.python;
	const allowJs = backends.js;
	const allowRb = backends.ruby;
	const allowJl = backends.julia;

	if (language === "python") {
		if (!allowPy) throw new ToolError("Python backend is disabled (VEYYON_PY=0 or eval.py = false).");
		if (!(await pythonBackend.isAvailable(session))) {
			const alternatives = [allowJs ? '"js"' : null, allowRb ? '"rb"' : null, allowJl ? '"jl"' : null].filter(
				Boolean,
			);
			throw new ToolError(
				alternatives.length > 0
					? `Python backend is unavailable in this session. Pass language: ${alternatives.join(" or ")} or install the python kernel.`
					: 'Python backend is unavailable in this session. Install the python kernel to use language: "py".',
			);
		}
		return { backend: pythonBackend };
	}
	if (language === "ruby") {
		if (!allowRb) throw new ToolError("Ruby backend is disabled (VEYYON_RB=0 or eval.rb = false).");
		if (!(await rubyBackend.isAvailable(session))) {
			const alternatives = [allowJs ? '"js"' : null, allowPy ? '"py"' : null, allowJl ? '"jl"' : null].filter(
				Boolean,
			);
			throw new ToolError(
				alternatives.length > 0
					? `Ruby backend is unavailable in this session. Pass language: ${alternatives.join(" or ")} or install Ruby.`
					: 'Ruby backend is unavailable in this session. Install Ruby to use language: "rb".',
			);
		}
		return { backend: rubyBackend };
	}
	if (language === "julia") {
		if (!allowJl) throw new ToolError("Julia backend is disabled (VEYYON_JL=0 or eval.jl = false).");
		if (!(await juliaBackend.isAvailable(session))) {
			const alternatives = [allowJs ? '"js"' : null, allowPy ? '"py"' : null, allowRb ? '"rb"' : null].filter(
				Boolean,
			);
			throw new ToolError(
				alternatives.length > 0
					? `Julia backend is unavailable in this session. Pass language: ${alternatives.join(" or ")} or install Julia.`
					: 'Julia backend is unavailable in this session. Install Julia to use language: "jl".',
			);
		}
		return { backend: juliaBackend };
	}
	if (!allowJs) throw new ToolError("JavaScript backend is disabled (VEYYON_JS=0 or eval.js = false).");
	return { backend: jsBackend };
}
function formatEvalInputLanguage(value: string): string {
	if (value === "py" || value === "python") return "python";
	if (value === "js" || value === "javascript") return "javascript";
	if (value === "rb" || value === "ruby") return "ruby";
	if (value === "jl" || value === "julia") return "julia";
	return value;
}

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
		const sessionSpawns = this.session.getSessionSpawns?.() ?? "*";
		return getEvalToolDescription({
			py: backends.python,
			js: backends.js,
			rb: backends.ruby,
			jl: backends.julia,
			spawns: sessionSpawns,
		});
	}
	/** All reuse-chain examples; the `examples` getter filters by enabled languages. */
	private static readonly ALL_EXAMPLES: readonly ToolExample<typeof evalSchema.infer>[] = [
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
			caption: "Third call — reuse the loaded config",
			call: {
				language: "py",
				title: "scan deps",
				code: "display(sorted(data['dependencies']))",
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
		return EvalTool.ALL_EXAMPLES.filter(ex => "call" in ex && langs.has(ex.call.language as EvalLanguageToken));
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

	#paramsKey?: string;
	#cachedParams?: typeof evalSchema;

	/**
	 * Languages enabled for this session, in display order. Detached tools (no
	 * session) fall back to the shipped defaults (py/js; rb/jl are opt-in).
	 */
	#enabledLanguages(): EvalLanguageToken[] {
		return this.session ? enabledEvalLanguages(resolveEvalBackends(this.session)) : ["py", "js"];
	}

	constructor(
		private readonly session: ToolSession | null,
		options?: EvalToolOptions,
	) {
		this.#proxyExecutor = options?.proxyExecutor;
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
		// `languages` stays a one-element array: it is part of the details wire type
		// the renderer reads, so its shape is a contract even though a call has only
		// ever had one language.
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
				/** The cell's folded output, once it has produced any. Empty until then. */
				let foldedOutput = "";
				// Set while the cell is inside backend.execute(). Streamed stdout is
				// appended to its rendered `output` live so a long-running cell (e.g. a
				// sleep loop) shows progress instead of nothing until it returns. A
				// dedicated tail buffer avoids double-counting against the aggregate
				// `tailBuffer`; on completion the authoritative `cellResult.output`
				// (below) overwrites this live tail. It is still a nullable handle rather
				// than a plain flag because a chunk can arrive after `execute` settles,
				// and that chunk must not reopen a finished cell's live output.
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
								statusEvents: cellResult.statusEvents ? [...cellResult.statusEvents] : undefined,
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
					// eval is the single largest producer of tool-result bytes, and its
					// largest tenth of results carried two thirds of them. Price the
					// inline window through the one owner rather than the flat default.
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
				// The per-cell `timeout` is a budget on the cell runtime's *own*
				// work. Host-side `agent()`/`parallel()`/`completion()` bridge calls suspend
				// that budget entirely and restart a fresh timeout window when control
				// returns to the active backend runtime. Compute, stdout, `log()`/`phase()`, and
				// ordinary tool calls all count against the budget. The watchdog drives
				// `combinedSignal`; we pass no wall-clock deadline downstream so the
				// backends never arm a competing fixed timer.
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
				// Held by name as well as through `activeLiveCell`, which the `finally`
				// below clears. This is the ONLY surviving record of what a cancelled
				// cell printed: a backend that is interrupted returns an empty
				// `result.output`, and `cellResult.output` is overwritten from that
				// empty value before the cancellation is handled. Without this the
				// abort message can only say the cell produced nothing, which is a
				// statement about the plumbing rather than about the run.
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
					// Fold test bookkeeping out of what the MODEL sees. `cellResult.output`
					// was assigned the raw text just above, and the renderer reads that, so
					// the operator still sees the run in full.
					//
					// This is the one accumulation point every return path below builds its
					// `outputText` from, so folding here covers the success, non-zero-exit
					// and cancelled paths without repeating itself in three places.
					foldedOutput = foldToolOutputBookkeeping(cellOutput).text;
					appendTail(foldedOutput);
				}

				if (result.cancelled) {
					cellResult.status = "error";
					pushUpdate();
					// THREE different signals are merged into `combinedSignal`, and this
					// one flag collapsed all of them. The two that matter here want
					// opposite responses: an idle timeout means "raise the cell's timeout
					// and run it again", and it already arrives carrying the backend's own
					// `timed out after N seconds` annotation, which is exactly what the
					// model needs to act on, so it keeps its ordinary error result. A user
					// pressing Escape means STOP, and folding that into the same result was
					// the defect. Nothing downstream could tell a cancellation from a cell
					// that threw, though the agent loop's correct response to a failure is
					// to read it and retry and its correct response to a cancellation is to
					// stop. Worse, the text was `result.output || "Command aborted"`, so a
					// cell that had printed anything at all before being interrupted
					// reported ONLY that output: the word "cancelled" appeared nowhere, and
					// a half-finished multi-cell run read as a finished one.
					//
					// The user's own signal outranks the watchdog when both have fired.
					// They asked for the stop, and telling them their cell timed out when
					// they cancelled it is the same conflation in the other direction.
					if (signal?.aborted || sessionAbortController.signal.aborted) {
						await finalizeOutput();
						// `result.output` is empty for an interrupted cell, so the streamed
						// text is the only surviving record of how far the work got, and it
						// is what the operator needs to decide whether to re-run.
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
						// Reached on the failure path, so the throw in flight must survive: it is
						// what the caller is waiting for, and rethrowing from a `finally` would
						// replace it. The dump is how a run's full output reaches the operator when
						// it overflowed the inline budget, so losing it silently means the output is
						// simply gone with no explanation.
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

/**
 * Reconcile the cell's visible output with the sink's own accounting.
 *
 * The sink counted every byte that streamed through it, including bytes the
 * inline window dropped; `cellOutput` is what the model will actually read. The
 * returned summary carries the visible text with the FULL totals, so a truncation
 * notice can say how much is missing rather than describing the window as if it
 * were the whole run.
 */
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
	const outputLines = cellOutput.length > 0 ? cellOutput.split("\n").length : 0;
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
