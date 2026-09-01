import { join } from "node:path";
import { hermesRoot } from "../config";

export function pluginRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(hermesRoot(env), "mnemopi", "plugins");
}

export type PluginConfig = Record<string, unknown>;
export type MemoryDict = Record<string, unknown>;
