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
import type { BuiltinToolName } from "../core/builtin-names";
import type { ToolFactory } from "../index";

export const shellTools = {
	bash: async s => new (await import("./bash")).BashTool(s),
	launch: async s => new (await import("./launch")).LaunchTool(s),
	job: async s => new (await import("./job")).JobTool(s),
	debug: async s => (await import("./debug")).DebugTool.createIf(s),
	eval: async s => (await import("./eval")).EvalTool.create(s),
	ssh: async s => (await import("./ssh")).loadSshTool(s),
} satisfies Partial<Record<BuiltinToolName, ToolFactory>>;

export const shellDomain = { domain: "shell", tools: shellTools } satisfies ToolDomainManifest<ToolFactory>;
