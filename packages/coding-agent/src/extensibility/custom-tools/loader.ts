import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { errorMessage, logger } from "@veyyon/utils";
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
import { factoryExportMissingMessage, moduleImportFailedMessage, nameConflictMessage } from "../load-failure";
import * as typebox from "../typebox";
import { createNoOpUIContext, resolvePath, withExitGuard } from "../utils";
import type { CustomToolAPI, CustomToolFactory, LoadedCustomTool, ToolLoadError } from "./types";

interface LoadToolResult {
	tools: LoadedCustomTool[];
	errors: ToolLoadError[];
}

function isLoadableCustomTool(value: unknown): value is LoadedCustomTool["tool"] {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		typeof value.name === "string" &&
		value.name.length > 0 &&
		"description" in value &&
		typeof value.description === "string" &&
		"parameters" in value &&
		"execute" in value &&
		typeof value.execute === "function"
	);
}

function invalidToolError(path: string, index: number, source: ToolLoadError["source"]): ToolLoadError {
	const which = index === 0 ? "The tool" : `Tool #${index + 1} in the array`;
	return {
		path,
		error:
			`${which} this custom tool's default export returned is not usable, so it is not active in this run. ` +
			"Fix: return an object with a non-empty string `name`, a string `description`, a `parameters` schema " +
			"and an `execute` function, then start a new veyyon session.",
		source,
	};
}

async function loadTool(
	toolPath: string,
	cwd: string,
	sharedApi: CustomToolAPI,
	source?: { provider: string; providerName: string; level: "user" | "project" },
): Promise<LoadToolResult> {
	const resolvedPath = resolvePath(toolPath, cwd);

	if (resolvedPath.endsWith(".md") || resolvedPath.endsWith(".json")) {
		return {
			tools: [],
			errors: [
				{
					path: toolPath,
					error:
						"Veyyon runs custom tools as JS/TS modules, and a declarative .md or .json tool file cannot be " +
						"imported, so it is not active in this run. Fix: rewrite it as a .ts file whose default export " +
						"returns the tool, or delete it from the tools directory so it stops being reported.",
					source,
				},
			],
		};
	}

	try {
		const module = await withExitGuard(() => import(resolvedPath));
		const factory = (module.default ?? module) as CustomToolFactory;

		if (typeof factory !== "function") {
			return { tools: [], errors: [{ path: toolPath, error: factoryExportMissingMessage("custom tool"), source }] };
		}

		const toolResult: unknown = await withExitGuard(async () => factory(sharedApi));
		const toolsArray = Array.isArray(toolResult) ? toolResult : [toolResult];

		const loadedTools: LoadedCustomTool[] = [];
		const errors: ToolLoadError[] = [];
		for (const [index, tool] of toolsArray.entries()) {
			if (!isLoadableCustomTool(tool)) {
				errors.push(invalidToolError(toolPath, index, source));
				continue;
			}

			loadedTools.push({
				path: toolPath,
				resolvedPath,
				tool,
				source,
			});
		}

		return { tools: loadedTools, errors };
	} catch (err) {
		return {
			tools: [],
			errors: [{ path: toolPath, error: moduleImportFailedMessage("custom tool", errorMessage(err)), source }],
		};
	}
}

export interface ToolPathWithSource {
	path: string;
	source?: { provider: string; providerName: string; level: "user" | "project" };
}

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

export async function discoverAndLoadCustomTools(
	configuredPaths: string[],
	cwd: string,
	builtInToolNames: string[],
	pushPendingAction?: (action: {
		label: string;
		sourceToolName: string;
		apply(reason: string): Promise<AgentToolResult<unknown>>;
		reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
	}) => void,
	agentDir?: string,
) {
	const pathsWithSources = await discoverCustomToolPaths(configuredPaths, cwd, agentDir);
	return loadCustomTools(pathsWithSources, cwd, builtInToolNames, pushPendingAction);
}
