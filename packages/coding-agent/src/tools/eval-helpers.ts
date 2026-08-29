import { prompt, truncate } from "@veyyon/utils";
import { type } from "arktype";
import { jsBackend, juliaBackend, pythonBackend, rubyBackend } from "../eval";
import type { ExecutorBackend } from "../eval/backend";
import type { EvalDisplayOutput, EvalLanguage, EvalToolDetails } from "../eval/types";
import { toolsPrompts } from "../prompts/tools/rows";
import { resolveSpawnPolicy } from "../task/spawn-policy";
import type { AgentDefinition } from "../task/types";
import type { ToolSession } from ".";
import { type EvalBackendsAllowance, resolveEvalBackends } from "./eval-backends";
import { ToolError } from "./tool-errors";
import { clampTimeout, describeTimeoutParam, formatTimeoutClampNotice } from "./tool-timeouts";

export type EvalLanguageToken = "py" | "js" | "rb" | "jl";
export const EVAL_LANGUAGE_ORDER: readonly EvalLanguageToken[] = ["py", "js", "rb", "jl"];
export const EVAL_LANGUAGE_RUNTIME: Record<EvalLanguageToken, string> = {
	py: '"py" for the IPython kernel',
	js: '"js" for the persistent JS VM',
	rb: '"rb" for the persistent Ruby kernel',
	jl: '"jl" for the persistent Julia kernel',
};
export const EVAL_LANGUAGE_NAME: Record<EvalLanguageToken, string> = {
	py: "Python",
	js: "JavaScript",
	rb: "Ruby",
	jl: "Julia",
};

export function joinWithOr(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} or ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

export function describeLanguageField(langs: readonly EvalLanguageToken[]): string {
	return `runtime: ${langs.map(lang => EVAL_LANGUAGE_RUNTIME[lang]).join(", ")}`;
}

export function describeCodeField(langs: readonly EvalLanguageToken[]): string {
	const replLangs = langs.filter(lang => lang === "rb" || lang === "jl");
	if (replLangs.length === 0) return "code to run in this eval call, verbatim. Use top-level await freely.";
	const awaitLangs = langs.filter(lang => lang === "py" || lang === "js");
	const clauses: string[] = [];
	if (awaitLangs.length > 0) clauses.push(`Top-level \`await\` is available in ${awaitLangs.join("/")}`);
	clauses.push(`${replLangs.join("/")} auto-display the last expression like a REPL`);
	return `code to run in this eval call, verbatim. ${clauses.join("; ")}.`;
}

export function summarizeEvalLanguages(langs: readonly EvalLanguageToken[]): string {
	const names = langs.map(lang => EVAL_LANGUAGE_NAME[lang]);
	const list = names.length > 0 ? joinWithOr(names) : "Python or JavaScript";
	const backend = langs.some(lang => lang === "rb" || lang === "jl") ? "a persistent" : "an in-process";
	return `Execute ${list} code in ${backend} eval backend`;
}

export function enabledEvalLanguages(backends: EvalBackendsAllowance): EvalLanguageToken[] {
	const allowed: Record<EvalLanguageToken, boolean> = {
		py: backends.python,
		js: backends.js,
		rb: backends.ruby,
		jl: backends.julia,
	};
	return EVAL_LANGUAGE_ORDER.filter(lang => allowed[lang]);
}

export const evalCellCommonFields = {
	"title?": type("string").describe('short label shown in transcript (e.g. "imports", "load config")'),
	"timeout?": type("number").describe(describeTimeoutParam("eval", { zeroDisablesNoun: "cell timeout" })),
	"reset?": type("boolean").describe("wipe this language's kernel before running. Other languages are untouched."),
};

export const evalSchema = type({
	language: type("'py' | 'js' | 'rb' | 'jl'").describe(describeLanguageField(EVAL_LANGUAGE_ORDER)),
	...evalCellCommonFields,
	code: type("string").describe(describeCodeField(EVAL_LANGUAGE_ORDER)),
});
export type EvalToolParams = typeof evalSchema.infer;
export function buildEvalSchema(langs: readonly EvalLanguageToken[]): typeof evalSchema {
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

export const MAX_DISPLAY_TEXT_CHARS = 8000;

export function formatDisplayJsonForText(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		text = String(value);
	}
	if (text.length <= MAX_DISPLAY_TEXT_CHARS) return text;
	const chars = [...text];
	if (chars.length <= MAX_DISPLAY_TEXT_CHARS) return text;
	return `${truncate(text, MAX_DISPLAY_TEXT_CHARS, "")}\n[…${chars.length - MAX_DISPLAY_TEXT_CHARS}ch elided…]`;
}

export function formatDisplayOutputsForText(outputs: EvalDisplayOutput[]): string {
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
	spawns?: boolean | string | null;
	effectiveAgents?: readonly string[];
	effectiveDefaultAgent?: string;
}

export function getEvalToolDescription(options: EvalToolDescriptionOptions = {}): string {
	const py = options.py ?? true;
	const js = options.js ?? true;
	const rb = options.rb ?? false;
	const jl = options.jl ?? false;
	const spawnPolicy = resolveSpawnPolicy(options.spawns ?? true);
	const hasEffectiveCatalog = options.effectiveAgents !== undefined;
	const effectiveAgents = options.effectiveAgents ?? [];
	const spawns = hasEffectiveCatalog ? effectiveAgents.length > 0 : spawnPolicy.enabled;
	const spawnDefaultAgent = hasEffectiveCatalog ? options.effectiveDefaultAgent : spawnPolicy.defaultAgent;
	const spawnAllowedAgentsText = hasEffectiveCatalog
		? effectiveAgents.map(agent => `\`${agent}\``).join(", ")
		: spawnPolicy.allowedPromptText;
	return prompt.render(toolsPrompts["tools/eval"].text, {
		py,
		js,
		rb,
		jl,
		spawns,
		spawnDefaultAgent,
		hasSpawnDefaultAgent: spawnDefaultAgent !== undefined,
		spawnAllowedAgentsText,
		spawnAgentListLabel: hasEffectiveCatalog ? "Enabled agents" : "Allowed agents",
	});
}

export interface EvalToolOptions {
	proxyExecutor?: EvalProxyExecutor;
	discoveredAgents?: readonly AgentDefinition[];
}

export interface ResolvedBackend {
	backend: ExecutorBackend;
	notice?: string;
}

export interface ResolvedEvalCell {
	index: number;
	title?: string;
	code: string;
	timeoutMs: number;
	reset: boolean;
	resolved: ResolvedBackend;
}

export function describeEvalCell(cell: ResolvedEvalCell): string {
	return cell.title ?? `the ${cell.resolved.backend.id} cell`;
}

export function timeoutClampNotice(cell: ResolvedEvalCell, maxTimeout?: number): string | undefined {
	if (cell.timeoutMs === 0) return undefined;
	return formatTimeoutClampNotice(
		"eval",
		cell.timeoutMs / 1000,
		clampTimeout("eval", cell.timeoutMs / 1000, maxTimeout),
	);
}

export function detailsNotice(cell: ResolvedEvalCell, maxTimeout?: number): string | undefined {
	const notices = [
		...new Set([cell.resolved.notice, timeoutClampNotice(cell, maxTimeout)].filter(Boolean) as string[]),
	];
	return notices.length > 0 ? notices.join(" ") : undefined;
}

export async function resolveBackend(session: ToolSession, language: EvalLanguage): Promise<ResolvedBackend> {
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
export function formatEvalInputLanguage(value: string): string {
	if (value === "py" || value === "python") return "python";
	if (value === "js" || value === "javascript") return "javascript";
	if (value === "rb" || value === "ruby") return "ruby";
	if (value === "jl" || value === "julia") return "julia";
	return value;
}
