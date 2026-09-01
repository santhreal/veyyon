import type * as vm from "node:vm";

export interface LocalModuleEntry {
	version: number;
	identifier: string;
	module: vm.SourceTextModule;
	loaded?: Promise<void>;
}

export type LocalImportResolution = { mode: "local"; value: unknown } | { mode: "external"; target: string };

export const LOCAL_MODULE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx", ".mts"]);
