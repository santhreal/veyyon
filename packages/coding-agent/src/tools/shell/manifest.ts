/**
 * What the shell domain contributes.
 *
 * Everything that runs a process: the in-process shell, the supervised long-running launch, the
 * background job table, the debugger, the language kernels behind `eval`, and the remote shell.
 *
 * The factories stay dynamic for the reason the whole dispatch table does — a session that never
 * runs a command never parses the interpreter, the debug adapters or the kernels — and this file is
 * one of the six the dynamic-import baseline names for it.
 */
import type { ToolDomainManifest } from "@veyyon/kernel/registry/tool-domain";
import type { ExecutorBackend } from "../../eval/backend";
import type { EvalLanguage } from "../../eval/types";
import type { BuiltinToolName } from "../core/builtin-names";
import type { ToolFactory } from "../index";
import { bashExecutionKind, pythonExecutionKind } from "./execution-messages";

export const shellTools = {
	bash: async s => new (await import("./bash")).BashTool(s),
	launch: async s => new (await import("./launch")).LaunchTool(s),
	job: async s => new (await import("./job")).JobTool(s),
	debug: async s => (await import("./debug")).DebugTool.createIf(s),
	eval: async s => (await import("./eval")).EvalTool.create(s),
	ssh: async s => (await import("./ssh")).loadSshTool(s),
} satisfies Partial<Record<BuiltinToolName, ToolFactory>>;

/** Load Python execution only when a session reaches a Python command. */
export function loadPythonExecutor() {
	return import("../../eval/py/executor");
}

/** Runtime dispatch occurs after the requested language passes its session allowance. */
export const evalBackendLoaders = {
	python: async () => (await import("../../eval/py")).default,
	js: async () => (await import("../../eval/js")).default,
	ruby: async () => (await import("../../eval/rb")).default,
	julia: async () => (await import("../../eval/jl")).default,
} satisfies Record<EvalLanguage, () => Promise<ExecutorBackend>>;

/**
 * The two roles the domain records, a `!` command and a `$` run, ride on the manifest as kinds: they
 * are the wording the model reads, which is the domain's, and the kernel converts the roles by
 * looking them up rather than by naming the shell.
 */
export const shellDomain = {
	domain: "shell",
	tools: shellTools,
	messageKinds: [bashExecutionKind, pythonExecutionKind],
} satisfies ToolDomainManifest<ToolFactory>;
