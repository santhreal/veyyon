import { installLegacyPiSpecifierShim } from "../plugins/legacy-pi-compat";
import type { ExtensionFactory } from "./types";

installLegacyPiSpecifierShim();

export type HandlerFn = (...args: unknown[]) => Promise<unknown>;
export type LoadedExtensionModule = ExtensionFactory | { default?: ExtensionFactory };

export function getExtensionFactory(module: LoadedExtensionModule): ExtensionFactory | null {
	const candidate = typeof module === "function" ? module : module.default;
	return typeof candidate === "function" ? candidate : null;
}
