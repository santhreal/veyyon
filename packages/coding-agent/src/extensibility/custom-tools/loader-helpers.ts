import { errorMessage } from "@veyyon/utils";
import { factoryExportMissingMessage, moduleImportFailedMessage } from "../load-failure";
import { resolvePath, withExitGuard } from "../utils";
import type { CustomToolAPI, CustomToolFactory, LoadedCustomTool, ToolLoadError } from "./types";

export interface LoadToolResult {
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

export async function loadTool(
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
