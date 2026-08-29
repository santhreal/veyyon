import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { logger } from "@veyyon/utils";
import { type } from "arktype";
import * as zodModule from "zod/v4";
import { toolCapability } from "../../capability/tool";
import { type DiscoveredCustomTool, loadCapability } from "../../discovery";
import { pluginsRootFor } from "../../discovery/helpers";
import type { ExecOptions } from "../../exec/exec";
import { execCommand, withSessionCpuExec } from "../../exec/exec";
import type { HookUIContext } from "../../extensibility/hooks/types";
import { getAllPluginToolPaths } from "../../extensibility/plugins/loader";
import { type CodingAgentApi, loadCodingAgentApi } from "../coding-agent-api";
import { nameConflictMessage } from "../load-failure";
import * as typebox from "../typebox";
import { createNoOpUIContext, resolvePath } from "../utils";
import type { ToolPathWithSource } from "./loader-helpers";

import { loadTool } from "./loader-helpers";
import type { CustomToolAPI, LoadedCustomTool, ToolLoadError } from "./types";

export type { ToolPathWithSource };

export class CustomToolLoader {
	tools: LoadedCustomTool[] = [];
	errors: ToolLoadError[] = [];
	#sharedApi: CustomToolAPI;
	#seenNames: Set<string>;
	#builtInNames: ReadonlySet<string>;

	constructor(
		pi: CodingAgentApi,
		cwd: string,
		builtInToolNames: string[],
		pushPendingAction?: (action: {
			label: string;
			sourceToolName: string;
			apply(reason: string): Promise<AgentToolResult<unknown>>;
			reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
		}) => void,
		adoptSpawnedPid?: (pid: number) => void,
		gateSpawn?: (what: string) => Promise<void>,
	) {
		this.#sharedApi = {
			cwd,
			exec: (command: string, args: string[], options?: ExecOptions) =>
				execCommand(
					command,
					args,
					options?.cwd ?? cwd,
					withSessionCpuExec(options, adoptSpawnedPid, gateSpawn, "a custom tool command"),
				),
			ui: createNoOpUIContext(),
			hasUI: false,
			logger,
			typebox,
			arktype: type,
			zod: zodModule,
			pi,
			pushPendingAction: action => {
				if (!pushPendingAction) {
					throw new Error("Pending action store unavailable for custom tools in this runtime.");
				}
				pushPendingAction({
					label: action.label,
					sourceToolName: action.sourceToolName ?? "custom_tool",
					apply: action.apply,
					reject: action.reject,
				});
			},
		};
		this.#builtInNames = new Set<string>(builtInToolNames);
		this.#seenNames = new Set<string>(builtInToolNames);
	}

	async load(pathsWithSources: ToolPathWithSource[]): Promise<void> {
		for (const { path: toolPath, source } of pathsWithSources) {
			const { tools: loadedTools, errors } = await loadTool(toolPath, this.#sharedApi.cwd, this.#sharedApi, source);
			for (let ei = 0; ei < errors.length; ei++) this.errors.push(errors[ei]!);

			for (const loadedTool of loadedTools) {
				if (this.#seenNames.has(loadedTool.tool.name)) {
					const owner = this.#builtInNames.has(loadedTool.tool.name)
						? "a built-in veyyon tool"
						: "a custom tool that loaded earlier";
					this.errors.push({
						path: toolPath,
						error: nameConflictMessage("custom tool", loadedTool.tool.name, owner),
						source,
					});
					continue;
				}

				this.#seenNames.add(loadedTool.tool.name);
				this.tools.push(loadedTool);
			}
		}
	}

	setUIContext(uiContext: HookUIContext, hasUI: boolean): void {
		this.#sharedApi.ui = uiContext;
		this.#sharedApi.hasUI = hasUI;
	}
}

export async function loadCustomTools(
	pathsWithSources: ToolPathWithSource[],
	cwd: string,
	builtInToolNames: string[],
	pushPendingAction?: (action: {
		label: string;
		sourceToolName: string;
		apply(reason: string): Promise<AgentToolResult<unknown>>;
		reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
	}) => void,
	adoptSpawnedPid?: (pid: number) => void,
	gateSpawn?: (what: string) => Promise<void>,
) {
	if (pathsWithSources.length === 0) {
		return { tools: [] as LoadedCustomTool[], errors: [] as ToolLoadError[], setUIContext: () => {} };
	}

	const loader = new CustomToolLoader(
		await loadCodingAgentApi(),
		cwd,
		builtInToolNames,
		pushPendingAction,
		adoptSpawnedPid,
		gateSpawn,
	);
	await loader.load(pathsWithSources);
	return {
		tools: loader.tools,
		errors: loader.errors,
		setUIContext: (uiContext: HookUIContext, hasUI: boolean) => {
			loader.setUIContext(uiContext, hasUI);
		},
	};
}

export async function discoverCustomToolPaths(
	configuredPaths: string[],
	cwd: string,
	agentDir?: string,
): Promise<ToolPathWithSource[]> {
	const allPathsWithSources: ToolPathWithSource[] = [];
	const seen = new Set<string>();

	const addPath = (p: string, source?: { provider: string; providerName: string; level: "user" | "project" }) => {
		const resolved = path.resolve(p);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			allPathsWithSources.push({ path: p, source });
		}
	};

	const discoveredTools = await loadCapability<DiscoveredCustomTool>(toolCapability.id, { cwd, agentDir });
	for (const tool of discoveredTools.items) {
		addPath(tool.path, {
			provider: tool._source.provider,
			providerName: tool._source.providerName,
			level: tool.level,
		});
	}

	for (const pluginPath of await getAllPluginToolPaths(cwd, agentDir ? pluginsRootFor(agentDir) : undefined)) {
		addPath(pluginPath, { provider: "plugin", providerName: "Plugin", level: "user" });
	}

	for (const configPath of configuredPaths) {
		addPath(resolvePath(configPath, cwd), { provider: "config", providerName: "Config", level: "project" });
	}

	return allPathsWithSources;
}
